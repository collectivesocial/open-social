/**
 * Spaces service (permissioned data Phase 1).
 *
 * A space is a named access boundary around one or more collections in the
 * community's repo. The registry lives in `community_spaces`; invite-only
 * spaces keep their invite list in `space_invites`.
 *
 * Space policies are enforced as an ADDITIONAL gate on top of the existing
 * per-app collection permissions — a space can only tighten access, never
 * loosen it. See `enforceSpaceBoundary`.
 */

import type { Kysely, Selectable } from "kysely";
import type { CommunitySpace, Database } from "../db";
import {
  ROLE_ADMIN,
  ROLE_MEMBER,
  satisfiesRole,
  type Operation,
} from "./permissions";
import { logger } from "../lib/logger";

export const SPACE_COLLECTION = "community.opensocial.space";
export const ANNOUNCEMENTS_SPACE_KEY = "announcements";
export const ANNOUNCEMENT_COLLECTION = "community.opensocial.announcement";

/** Read-access levels with special semantics (anything else is a custom role). */
export const READ_PUBLIC = "public";
export const READ_INVITE = "invite";

export type SpaceRow = Selectable<CommunitySpace>;

export function parseSpaceCollections(space: SpaceRow): string[] {
  try {
    const parsed = JSON.parse(space.collections);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export async function listSpaces(
  db: Kysely<Database>,
  communityDid: string,
): Promise<SpaceRow[]> {
  return db
    .selectFrom("community_spaces")
    .selectAll()
    .where("community_did", "=", communityDid)
    .orderBy("space_key", "asc")
    .execute();
}

export async function getSpace(
  db: Kysely<Database>,
  communityDid: string,
  spaceKey: string,
): Promise<SpaceRow | undefined> {
  return db
    .selectFrom("community_spaces")
    .selectAll()
    .where("community_did", "=", communityDid)
    .where("space_key", "=", spaceKey)
    .executeTakeFirst();
}

/**
 * Find the space (if any) that claims a collection. Collections can belong
 * to at most one space — enforced at space create/update time.
 */
export async function getSpaceForCollection(
  db: Kysely<Database>,
  communityDid: string,
  collection: string,
): Promise<SpaceRow | undefined> {
  const spaces = await listSpaces(db, communityDid);
  return spaces.find((s) => parseSpaceCollections(s).includes(collection));
}

export async function isInvited(
  db: Kysely<Database>,
  communityDid: string,
  spaceKey: string,
  userDid: string,
): Promise<boolean> {
  const row = await db
    .selectFrom("space_invites")
    .select("id")
    .where("community_did", "=", communityDid)
    .where("space_key", "=", spaceKey)
    .where("invitee_did", "=", userDid)
    .executeTakeFirst();
  return row !== undefined;
}

/**
 * Can a user with `userRoles` read records in this space?
 *
 * - admins can always read
 * - 'public'  → anyone
 * - 'member'  → member or admin
 * - 'admin'   → admins only
 * - 'invite'  → explicit invitees (and admins)
 * - custom    → that role (and admins)
 */
export async function canReadSpace(
  db: Kysely<Database>,
  space: SpaceRow,
  userDid: string,
  userRoles: string[],
): Promise<boolean> {
  if (userRoles.includes(ROLE_ADMIN)) return true;
  if (space.read_access === READ_PUBLIC) return true;
  if (space.read_access === READ_INVITE) {
    return isInvited(db, space.community_did, space.space_key, userDid);
  }
  if (space.read_access === ROLE_MEMBER) {
    return userRoles.includes(ROLE_MEMBER);
  }
  if (space.read_access === ROLE_ADMIN) {
    return false; // admin already handled above
  }
  return satisfiesRole(userRoles, space.read_access);
}

/** Can a user with `userRoles` write (create/update/delete) in this space? */
export function canWriteSpace(space: SpaceRow, userRoles: string[]): boolean {
  return satisfiesRole(userRoles, space.write_access);
}

export type SpaceBoundaryResult =
  | { allowed: true }
  | { allowed: false; reason: string };

/**
 * The space gate used by the record-access paths: if `collection` belongs
 * to a space, the space's policy must ALSO be satisfied (on top of the
 * per-app collection permissions). Collections outside any space are
 * unaffected.
 */
export async function enforceSpaceBoundary(
  db: Kysely<Database>,
  communityDid: string,
  collection: string,
  operation: Operation,
  userDid: string,
  userRoles: string[],
): Promise<SpaceBoundaryResult> {
  const space = await getSpaceForCollection(db, communityDid, collection);
  if (!space) return { allowed: true };

  if (operation === "read") {
    const ok = await canReadSpace(db, space, userDid, userRoles);
    if (!ok) {
      return {
        allowed: false,
        reason: `Collection belongs to space '${space.space_key}' (read access: ${space.read_access})`,
      };
    }
    return { allowed: true };
  }

  if (!canWriteSpace(space, userRoles)) {
    return {
      allowed: false,
      reason: `Collection belongs to space '${space.space_key}' (write access: ${space.write_access})`,
    };
  }
  return { allowed: true };
}

/**
 * Register the built-in spaces for a community (currently the announcement
 * space). Called at community creation; idempotent.
 */
export async function ensureDefaultSpaces(
  db: Kysely<Database>,
  communityDid: string,
  creatorDid: string,
): Promise<void> {
  try {
    await db
      .insertInto("community_spaces")
      .values({
        community_did: communityDid,
        space_key: ANNOUNCEMENTS_SPACE_KEY,
        name: "Announcements",
        description: "Group-only announcements from the community admins",
        space_type: SPACE_COLLECTION,
        read_access: ROLE_MEMBER,
        write_access: ROLE_ADMIN,
        collections: JSON.stringify([ANNOUNCEMENT_COLLECTION]),
        created_by: creatorDid,
      })
      .onConflict((oc) =>
        oc.columns(["community_did", "space_key"]).doNothing(),
      )
      .execute();
  } catch (err) {
    logger.warn(
      { error: err, communityDid },
      "Failed to seed default spaces for new community",
    );
  }
}
