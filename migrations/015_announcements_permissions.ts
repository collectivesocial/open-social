import { Kysely } from "kysely";

/**
 * Migration: Seed default permissions for the group-only announcement space
 * (`community.opensocial.announcement`).
 *
 * Announcements are the first group-only space in Open Social: only admins
 * may create/update/delete announcements, and only members may read them.
 * The member-level read permission is what makes the space group-only —
 * unlike sharedDocument/sharedEvent, reads are permission-checked.
 */

const SYSTEM_APP_ID = "app_system";
const ANNOUNCEMENT_COLLECTION = "community.opensocial.announcement";

export async function up(db: Kysely<any>): Promise<void> {
  // 1. Seed default permissions so new communities inherit them via
  //    seedCollectionPermissions() at creation time.
  await db
    .insertInto("app_default_permissions")
    .values({
      app_id: SYSTEM_APP_ID,
      collection: ANNOUNCEMENT_COLLECTION,
      default_can_create: "admin",
      default_can_read: "member",
      default_can_update: "admin",
      default_can_delete: "admin",
    })
    .onConflict((oc) => oc.columns(["app_id", "collection"]).doNothing())
    .execute();

  // 2. Seed per-community permissions for all existing communities
  const communities = await db
    .selectFrom("communities")
    .select("did")
    .execute();

  for (const community of communities) {
    await db
      .insertInto("community_app_collection_permissions")
      .values({
        community_did: community.did,
        app_id: SYSTEM_APP_ID,
        collection: ANNOUNCEMENT_COLLECTION,
        can_create: "admin",
        can_read: "member",
        can_update: "admin",
        can_delete: "admin",
      })
      .onConflict((oc) =>
        oc.columns(["community_did", "app_id", "collection"]).doNothing(),
      )
      .execute();
  }
}

export async function down(db: Kysely<any>): Promise<void> {
  await db
    .deleteFrom("community_app_collection_permissions")
    .where("app_id", "=", SYSTEM_APP_ID)
    .where("collection", "=", ANNOUNCEMENT_COLLECTION)
    .execute();

  await db
    .deleteFrom("app_default_permissions")
    .where("app_id", "=", SYSTEM_APP_ID)
    .where("collection", "=", ANNOUNCEMENT_COLLECTION)
    .execute();
}
