/**
 * Shared Bluesky profile resolution with caching, batching, and timeouts.
 *
 * Profile lookups hit the public appview on request paths (member lists,
 * pending-member lists), so they must be bounded: every fetch carries a
 * timeout, results — including misses — are cached, and page-sized lookups
 * are batched through app.bsky.actor.getProfiles (25 actors per call).
 */

import { TtlCache } from "./cache";
import { logger } from "./logger";

export interface ResolvedProfile {
  handle: string | null;
  displayName: string | null;
  avatar: string | null;
}

const APPVIEW_URL = "https://public.api.bsky.app";
const FETCH_TIMEOUT_MS = 3000;
const BATCH_SIZE = 25; // getProfiles maximum

const EMPTY_PROFILE: ResolvedProfile = {
  handle: null,
  displayName: null,
  avatar: null,
};

/**
 * 10-minute cache keyed by DID. Failed lookups cache the empty profile so a
 * deleted/unreachable account doesn't get re-fetched on every page load.
 */
export const profileCache = new TtlCache<ResolvedProfile>(600_000, 5000);

function toProfile(data: {
  handle?: string;
  displayName?: string;
  avatar?: string;
}): ResolvedProfile {
  return {
    handle: data.handle || null,
    displayName: data.displayName || null,
    avatar: data.avatar || null,
  };
}

/**
 * Resolve a single DID's profile. Never throws — returns null fields when the
 * profile can't be fetched.
 */
export async function resolveProfile(did: string): Promise<ResolvedProfile> {
  const cached = profileCache.get(did);
  if (cached) return cached;

  let profile = EMPTY_PROFILE;
  try {
    const res = await fetch(
      `${APPVIEW_URL}/xrpc/app.bsky.actor.getProfile?actor=${encodeURIComponent(did)}`,
      { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) },
    );
    if (res.ok) {
      profile = toProfile((await res.json()) as any);
    }
  } catch {
    // Timeouts and network errors fall through to the empty profile.
  }
  profileCache.set(did, profile);
  return profile;
}

/**
 * Resolve many DIDs at once. Serves cache hits, batches the misses through
 * getProfiles (25 per call, chunks fetched in parallel), and falls back to
 * per-DID lookups if a batch call fails. Every requested DID is present in
 * the returned map.
 */
export async function resolveProfiles(
  dids: string[],
): Promise<Map<string, ResolvedProfile>> {
  const result = new Map<string, ResolvedProfile>();
  const misses: string[] = [];

  for (const did of new Set(dids)) {
    const cached = profileCache.get(did);
    if (cached) {
      result.set(did, cached);
    } else {
      misses.push(did);
    }
  }

  const chunks: string[][] = [];
  for (let i = 0; i < misses.length; i += BATCH_SIZE) {
    chunks.push(misses.slice(i, i + BATCH_SIZE));
  }

  await Promise.all(
    chunks.map(async (chunk) => {
      try {
        const url = new URL(`${APPVIEW_URL}/xrpc/app.bsky.actor.getProfiles`);
        for (const did of chunk) {
          url.searchParams.append("actors", did);
        }
        const res = await fetch(url.toString(), {
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });
        if (!res.ok) {
          throw new Error(`getProfiles returned ${res.status}`);
        }
        const data = (await res.json()) as {
          profiles: Array<{ did: string; [key: string]: unknown }>;
        };
        const byDid = new Map(data.profiles.map((p) => [p.did, p]));
        for (const did of chunk) {
          const profile = byDid.has(did)
            ? toProfile(byDid.get(did) as any)
            : EMPTY_PROFILE;
          profileCache.set(did, profile);
          result.set(did, profile);
        }
      } catch (err) {
        // Batch endpoint failure — degrade to per-DID lookups rather than
        // blanking the whole chunk.
        logger.warn(
          { error: err, count: chunk.length },
          "getProfiles batch failed, falling back to per-DID lookups",
        );
        await Promise.all(
          chunk.map(async (did) => {
            result.set(did, await resolveProfile(did));
          }),
        );
      }
    }),
  );

  return result;
}
