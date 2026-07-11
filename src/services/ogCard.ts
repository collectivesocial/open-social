import { BskyAgent } from "@atproto/api";
import type { Kysely } from "kysely";
import type { Database } from "../db";
import { resolvePdsEndpoint } from "./atproto";
import { blobToUrl, fetchBlueskyAvatar } from "../lib/avatar";
import { logger } from "../lib/logger";

export interface CommunityCardData {
  displayName: string;
  description?: string;
  avatarUrl?: string;
}

interface ProfileRecordValue {
  displayName?: string;
  description?: string;
  avatar?: unknown;
}

/**
 * Deny-by-default vetting for avatar URLs before they're passed to a
 * server-side fetch. `getCommunityCardData` sources avatar URLs from data a
 * community controls (its own profile record) or from Bluesky's CDN, and
 * the profile record's `avatar` field can be an arbitrary string (see
 * `blobToUrl`). Without this check a malicious community could point the
 * crawler-triggered avatar fetch at an internal host or the cloud metadata
 * endpoint (SSRF), with the response re-served as a publicly cacheable PNG.
 *
 * Only allows:
 *  - `cdn.bsky.app` (the public Bluesky avatar CDN), or
 *  - the exact hostname of the community's own registered `pdsHost`.
 *
 * If `pdsHost` itself doesn't parse as a URL, only `cdn.bsky.app` is
 * allowed.
 */
export function isAllowedAvatarUrl(url: string, pdsHost: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return false;
  }

  if (parsed.hostname === "cdn.bsky.app") return true;

  try {
    const pds = new URL(pdsHost);
    return parsed.hostname === pds.hostname;
  } catch {
    return false;
  }
}

function safeHostname(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "(unparseable)";
  }
}

/**
 * Minimal community lookup for OG share cards. Reads the DB row plus the
 * public community profile record (no app-password agent — crawler traffic
 * must never depend on community credentials). Returns null when the
 * community doesn't exist.
 */
export async function getCommunityCardData(
  db: Kysely<Database>,
  did: string,
): Promise<CommunityCardData | null> {
  const community = await db
    .selectFrom("communities")
    .select(["did", "handle", "display_name", "pds_host"])
    .where("did", "=", did)
    .executeTakeFirst();

  if (!community) return null;

  let displayName = community.display_name || community.handle;
  let description: string | undefined;
  let avatarUrl: string | undefined;

  try {
    const pdsUrl = await resolvePdsEndpoint(did, community.pds_host);
    const agent = new BskyAgent({ service: pdsUrl });
    const record = await agent.api.com.atproto.repo.getRecord({
      repo: did,
      collection: "community.opensocial.profile",
      rkey: "self",
    });
    const profile = record.data.value as ProfileRecordValue;
    if (profile.displayName) displayName = profile.displayName;
    if (profile.description) description = profile.description;
    avatarUrl = blobToUrl(profile.avatar, did, community.pds_host);
    if (avatarUrl && !isAllowedAvatarUrl(avatarUrl, community.pds_host)) {
      logger.warn(
        { did, host: safeHostname(avatarUrl) },
        "Rejected community profile avatar URL (not an allowed host)",
      );
      avatarUrl = undefined;
    }
  } catch (err) {
    // Profile record missing or PDS unreachable — card still renders.
    logger.debug(
      { error: err, did },
      "No community profile record for OG card",
    );
  }

  if (!avatarUrl) {
    const blueskyAvatar = await fetchBlueskyAvatar(did);
    if (blueskyAvatar) {
      if (isAllowedAvatarUrl(blueskyAvatar, community.pds_host)) {
        avatarUrl = blueskyAvatar;
      } else {
        logger.warn(
          { did, host: safeHostname(blueskyAvatar) },
          "Rejected Bluesky avatar URL (not an allowed host)",
        );
      }
    }
  }

  return { displayName, description, avatarUrl };
}
