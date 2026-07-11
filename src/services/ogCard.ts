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
  } catch (err) {
    // Profile record missing or PDS unreachable — card still renders.
    logger.debug(
      { error: err, did },
      "No community profile record for OG card",
    );
  }

  if (!avatarUrl) {
    avatarUrl = await fetchBlueskyAvatar(did);
  }

  return { displayName, description, avatarUrl };
}
