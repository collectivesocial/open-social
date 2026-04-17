import { BskyAgent, AtpAgent } from '@atproto/api';
import type { Kysely } from 'kysely';
import type { Database } from '../db';
import { decryptIfNeeded } from '../lib/crypto';
import { retry, isTransientError } from '../lib/retry';
import { logger } from '../lib/logger';
import { config } from '../config';

/**
 * In-memory cache for authenticated community agents.
 *
 * The Bluesky PDS enforces a rate limit of ~30 createSession calls per
 * 5-minute window.  Without caching, every inbound API request calls
 * `login()`, so a single page load (which fires 5-10 parallel requests)
 * quickly exhausts the budget and causes cascading 429 errors.
 *
 * Cached agents are reused for 4 minutes (well within the JWT lifetime)
 * and automatically evicted when they expire.
 */
interface CachedAgent {
  agent: BskyAgent;
  expiresAt: number;
}

const agentCache = new Map<string, CachedAgent>();
const AGENT_CACHE_TTL_MS = 4 * 60 * 1000; // 4 minutes

/**
 * Pending login promises so concurrent requests for the same community
 * share a single login() call instead of each triggering their own.
 */
const pendingLogins = new Map<string, Promise<BskyAgent>>();

/** Periodically prune expired entries so the map doesn't grow forever. */
setInterval(() => {
  const now = Date.now();
  for (const [did, entry] of agentCache) {
    if (now >= entry.expiresAt) {
      agentCache.delete(did);
    }
  }
}, 60_000);

/** Ensure a PDS host string is a full URL with scheme. */
export function ensureServiceUrl(pdsHost: string): string {
  if (pdsHost.startsWith('http://') || pdsHost.startsWith('https://')) {
    return pdsHost;
  }
  return `https://${pdsHost}`;
}

/**
 * Resolve a DID to its actual PDS endpoint via the PLC directory.
 * Falls back to the provided fallback URL if resolution fails.
 */
export async function resolvePdsEndpoint(did: string, fallback?: string): Promise<string> {
  try {
    const res = await fetch(`${config.plcUrl}/${did}`);
    if (!res.ok) throw new Error(`PLC directory returned ${res.status}`);
    const doc = await res.json() as { service?: { id: string; serviceEndpoint: string }[] };
    const pds = doc.service?.find((s) => s.id === '#atproto_pds');
    if (pds?.serviceEndpoint) {
      return pds.serviceEndpoint;
    }
  } catch (err) {
    logger.warn({ did, error: err }, 'Failed to resolve PDS from DID document');
  }
  if (fallback) return ensureServiceUrl(fallback);
  throw new Error(`Could not resolve PDS for ${did}`);
}

export async function createCommunityAgent(db: Kysely<Database>, did: string): Promise<BskyAgent> {
  // 1. Return a cached agent if it's still valid
  const cached = agentCache.get(did);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.agent;
  }

  // 2. If another caller is already logging in for this DID, await that
  //    instead of firing a second createSession call.
  const pending = pendingLogins.get(did);
  if (pending) {
    return pending;
  }

  // 3. Perform the actual login, sharing the promise with concurrent callers
  const loginPromise = (async (): Promise<BskyAgent> => {
    const community = await db
      .selectFrom('communities')
      .select(['handle', 'pds_host', 'app_password'])
      .where('did', '=', did)
      .executeTakeFirst();

    if (!community) {
      throw new Error('Community not found');
    }

    // Resolve the actual PDS endpoint from the DID document,
    // falling back to the stored pds_host if resolution fails.
    const pdsUrl = await resolvePdsEndpoint(did, community.pds_host);

    const agent = new BskyAgent({ service: pdsUrl });

    await retry(
      () => agent.login({
        identifier: did,
        password: decryptIfNeeded(community.app_password),
      }),
      {
        maxRetries: 2,
        initialDelay: 1000,
        shouldRetry: (error) => {
          return isTransientError(error);
        },
        context: {
          did,
          handle: community.handle,
          pdsHost: pdsUrl,
        },
      }
    );

    // Cache the authenticated agent
    agentCache.set(did, { agent, expiresAt: Date.now() + AGENT_CACHE_TTL_MS });
    logger.info({ did }, 'Community agent cached');

    return agent;
  })();

  pendingLogins.set(did, loginPromise);

  try {
    return await loginPromise;
  } finally {
    pendingLogins.delete(did);
  }
}

/**
 * Evict a cached community agent (e.g. after an app-password update).
 */
export function invalidateCommunityAgent(did: string): void {
  agentCache.delete(did);
  pendingLogins.delete(did);
}

export async function getPublicAgent(pdsHost: string): Promise<AtpAgent> {
  return new AtpAgent({ service: ensureServiceUrl(pdsHost) });
}

/**
 * Resolve a Bluesky profile to get handle, display name, and avatar.
 * Uses the public Bluesky API — no authenticated agent needed.
 * The returned avatar is a full CDN URL.
 */
export async function resolveBlueskyProfile(did: string): Promise<{
  handle: string | null;
  displayName: string | null;
  avatar: string | null;
}> {
  try {
    const res = await fetch(
      `https://public.api.bsky.app/xrpc/app.bsky.actor.getProfile?actor=${encodeURIComponent(did)}`,
    );
    if (res.ok) {
      const data = (await res.json()) as any;
      return {
        handle: data.handle || null,
        displayName: data.displayName || null,
        avatar: data.avatar || null,
      };
    }
  } catch {
    logger.warn({ did }, 'Failed to resolve Bluesky profile for app DID');
  }
  return { handle: null, displayName: null, avatar: null };
}
