/**
 * Permissions service.
 *
 * Centralises all permission checks that were previously hardcoded or
 * scattered across route files.  Every check hits the database (with a
 * thin in-memory cache for admin / membership status fetched from the PDS).
 */

import type { Kysely } from "kysely";
import type { Database } from "../db";
import { isAdminInList } from "../lib/adminUtils";
import { adminCache, memberCache, memberRolesCache } from "../lib/cache";

// ─── Built-in role names ──────────────────────────────────────────────

export const ROLE_ADMIN = "admin";
export const ROLE_MEMBER = "member";

/** Ordered from most to least privileged — used for "minimum role" checks. */
const BUILT_IN_ROLE_HIERARCHY: readonly string[] = [ROLE_ADMIN, ROLE_MEMBER];

// ─── App visibility ───────────────────────────────────────────────────

export type VisibilityResult =
  | { allowed: true }
  | { allowed: false; reason: string };

/**
 * Determine whether `appId` is allowed to interact with `communityDid`.
 *
 * Resolution order:
 * 1. Explicit row in `community_app_visibility` → use that status.
 * 2. Community in `community_settings.blocked_app_ids` → blocked.
 * 3. Fall through to `community_settings.app_visibility_default`
 *    ('open' → allowed, 'approval_required' → not allowed unless explicit row).
 * 4. If no settings row exists at all → default to open (safe for existing data).
 */
export async function checkAppVisibility(
  db: Kysely<Database>,
  communityDid: string,
  appId: string,
): Promise<VisibilityResult> {
  // 1. Explicit override?
  const override = await db
    .selectFrom("community_app_visibility")
    .select("status")
    .where("community_did", "=", communityDid)
    .where("app_id", "=", appId)
    .executeTakeFirst();

  if (override) {
    if (override.status === "enabled") return { allowed: true };
    return {
      allowed: false,
      reason: `App is ${override.status} for this community`,
    };
  }

  // 2 & 3. Community-level settings
  const settings = await db
    .selectFrom("community_settings")
    .selectAll()
    .where("community_did", "=", communityDid)
    .executeTakeFirst();

  if (settings) {
    // Check blocked list
    try {
      const blocked: string[] = JSON.parse(settings.blocked_app_ids);
      if (blocked.includes(appId)) {
        return { allowed: false, reason: "App is blocked by this community" };
      }
    } catch {
      /* malformed JSON — treat as empty */
    }

    if (settings.app_visibility_default === "approval_required") {
      return {
        allowed: false,
        reason: "Community requires admin approval for apps",
      };
    }
  }

  // 4. No settings row → default open
  return { allowed: true };
}

// ─── Collection permissions ───────────────────────────────────────────

export type Operation = "create" | "read" | "update" | "delete";

/**
 * Get the minimum required role for a given (community, app, collection, operation).
 *
 * Returns `null` if no permission row exists — meaning the collection is
 * **not accessible** through this app for this community.
 */
export async function getRequiredRole(
  db: Kysely<Database>,
  communityDid: string,
  appId: string,
  collection: string,
  operation: Operation,
): Promise<string | null> {
  const col = `can_${operation}` as const;

  const row = await db
    .selectFrom("community_app_collection_permissions")
    .select(col)
    .where("community_did", "=", communityDid)
    .where("app_id", "=", appId)
    .where("collection", "=", collection)
    .executeTakeFirst();

  if (!row) return null; // no permission row → not accessible
  return (row as any)[col] as string;
}

// ─── Role resolution ──────────────────────────────────────────────────

/**
 * Get the effective roles for a user in a community.
 *
 * Always includes 'member' if the user is a confirmed member,
 * and 'admin' if they appear in the admins record.
 * Also includes any custom roles from community_member_roles.
 */
export async function getUserRoles(
  db: Kysely<Database>,
  communityDid: string,
  userDid: string,
  communityAgent: any,
): Promise<string[]> {
  // Check cache first
  const cacheKey = `${communityDid}:${userDid}`;
  const cached = memberRolesCache.get(cacheKey);
  if (cached) return cached;

  const roles: string[] = [];

  // Check membership (PDS)
  const isMem = await checkMembership(communityAgent, communityDid, userDid);
  if (isMem) roles.push(ROLE_MEMBER);

  // Check admin (PDS)
  const isAdm = await checkAdmin(communityAgent, communityDid, userDid);
  if (isAdm) roles.push(ROLE_ADMIN);

  // Custom roles from database
  const customRoles = await db
    .selectFrom("community_member_roles")
    .select("role_name")
    .where("community_did", "=", communityDid)
    .where("member_did", "=", userDid)
    .execute();

  for (const r of customRoles) {
    if (!roles.includes(r.role_name)) {
      roles.push(r.role_name);
    }
  }

  memberRolesCache.set(cacheKey, roles);
  return roles;
}

/**
 * Check whether a set of user roles satisfies the required role for an operation.
 *
 * - 'admin' is satisfied only if user has 'admin'.
 * - 'member' is satisfied if user has 'member' or 'admin'.
 * - A custom role name is satisfied if user has that exact role, OR 'admin'.
 */
export function satisfiesRole(
  userRoles: string[],
  requiredRole: string,
): boolean {
  // Admin can do anything
  if (userRoles.includes(ROLE_ADMIN)) return true;

  // Built-in 'member' role
  if (requiredRole === ROLE_MEMBER) {
    return userRoles.includes(ROLE_MEMBER);
  }

  // Built-in 'admin' role (already covered above, but explicit)
  if (requiredRole === ROLE_ADMIN) {
    return false; // we already checked admin above
  }

  // Custom role — exact match
  return userRoles.includes(requiredRole);
}

// ─── PDS helpers (cached) ─────────────────────────────────────────────

export async function checkMembership(
  communityAgent: any,
  communityDid: string,
  userDid: string,
): Promise<boolean> {
  const cacheKey = `${communityDid}:${userDid}`;
  const cached = memberCache.get(cacheKey);
  if (cached !== undefined) return cached;

  let cursor: string | undefined;
  let found = false;
  do {
    const response = await communityAgent.api.com.atproto.repo.listRecords({
      repo: communityDid,
      collection: "community.opensocial.membershipProof",
      limit: 100,
      cursor,
    });
    found = response.data.records.some(
      (r: any) => r.value.memberDid === userDid,
    );
    cursor = response.data.cursor;
  } while (cursor && !found);

  memberCache.set(cacheKey, found);
  return found;
}

/**
 * Locate a member's membershipProof record, returning its uri/rkey so callers
 * can delete it. Always scans the live collection (deletions must not act on
 * cached data) but warms the membership cache with what it learns.
 */
export async function findMembershipProof(
  communityAgent: any,
  communityDid: string,
  memberDid: string,
): Promise<{ uri: string; rkey: string } | null> {
  let cursor: string | undefined;
  do {
    const response = await communityAgent.api.com.atproto.repo.listRecords({
      repo: communityDid,
      collection: "community.opensocial.membershipProof",
      limit: 100,
      cursor,
    });
    const record = response.data.records.find(
      (r: any) => r.value.memberDid === memberDid,
    );
    if (record) {
      memberCache.set(`${communityDid}:${memberDid}`, true);
      return { uri: record.uri, rkey: record.uri.split("/").pop()! };
    }
    cursor = response.data.cursor;
  } while (cursor);

  memberCache.set(`${communityDid}:${memberDid}`, false);
  return null;
}

export async function checkAdmin(
  communityAgent: any,
  communityDid: string,
  userDid: string,
): Promise<boolean> {
  const cacheKey = `${communityDid}:${userDid}`;
  const cached = adminCache.get(cacheKey);
  if (cached !== undefined) return cached;

  try {
    const adminsResponse = await communityAgent.api.com.atproto.repo.getRecord({
      repo: communityDid,
      collection: "community.opensocial.admins",
      rkey: "self",
    });
    const admins = (adminsResponse.data.value as any).admins || [];
    const result = isAdminInList(userDid, admins);
    adminCache.set(cacheKey, result);
    return result;
  } catch {
    adminCache.set(cacheKey, false);
    return false;
  }
}

// ─── Seed collection permissions ──────────────────────────────────────

/**
 * When an app is enabled for a community, copy the app's default permissions
 * into the community_app_collection_permissions table.
 * Existing overrides are NOT touched.
 */
export async function seedCollectionPermissions(
  db: Kysely<Database>,
  communityDid: string,
  appId: string,
): Promise<void> {
  const defaults = await db
    .selectFrom("app_default_permissions")
    .selectAll()
    .where("app_id", "=", appId)
    .execute();

  for (const d of defaults) {
    // Only insert if no override exists yet
    const existing = await db
      .selectFrom("community_app_collection_permissions")
      .select("id")
      .where("community_did", "=", communityDid)
      .where("app_id", "=", appId)
      .where("collection", "=", d.collection)
      .executeTakeFirst();

    if (!existing) {
      await db
        .insertInto("community_app_collection_permissions")
        .values({
          community_did: communityDid,
          app_id: appId,
          collection: d.collection,
          can_create: d.default_can_create,
          can_read: d.default_can_read,
          can_update: d.default_can_update,
          can_delete: d.default_can_delete,
        })
        .execute();
    }
  }
}
