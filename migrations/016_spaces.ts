import { Kysely, sql } from "kysely";

/**
 * Migration: first-class spaces (permissioned data Phase 1).
 *
 * A space is a named access boundary around one or more collections in the
 * community's repo. `community_spaces` is the registry; `space_invites`
 * holds the explicit invite list for invite-only spaces.
 *
 * Backfills an 'announcements' space for every existing community so the
 * group-only announcement space becomes registry row #1 instead of a
 * special case.
 */

const ANNOUNCEMENT_COLLECTION = "community.opensocial.announcement";

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable("community_spaces")
    .addColumn("id", "serial", (c) => c.primaryKey())
    .addColumn("community_did", "text", (c) => c.notNull())
    .addColumn("space_key", "text", (c) => c.notNull())
    .addColumn("name", "text", (c) => c.notNull())
    .addColumn("description", "text")
    .addColumn("space_type", "text", (c) =>
      c.notNull().defaultTo("community.opensocial.space"),
    )
    .addColumn("read_access", "text", (c) => c.notNull().defaultTo("member"))
    .addColumn("write_access", "text", (c) => c.notNull().defaultTo("admin"))
    .addColumn("collections", "text", (c) => c.notNull().defaultTo("[]"))
    .addColumn("created_by", "text", (c) => c.notNull())
    .addColumn("created_at", "timestamptz", (c) =>
      c.notNull().defaultTo(sql`now()`),
    )
    .addColumn("updated_at", "timestamptz", (c) =>
      c.notNull().defaultTo(sql`now()`),
    )
    .execute();

  await db.schema
    .createIndex("community_spaces_did_key_uniq")
    .on("community_spaces")
    .columns(["community_did", "space_key"])
    .unique()
    .execute();

  await db.schema
    .createTable("space_invites")
    .addColumn("id", "serial", (c) => c.primaryKey())
    .addColumn("community_did", "text", (c) => c.notNull())
    .addColumn("space_key", "text", (c) => c.notNull())
    .addColumn("invitee_did", "text", (c) => c.notNull())
    .addColumn("invited_by", "text", (c) => c.notNull())
    .addColumn("created_at", "timestamptz", (c) =>
      c.notNull().defaultTo(sql`now()`),
    )
    .execute();

  await db.schema
    .createIndex("space_invites_did_key_invitee_uniq")
    .on("space_invites")
    .columns(["community_did", "space_key", "invitee_did"])
    .unique()
    .execute();

  // Backfill: register the announcement space for existing communities.
  const communities = await db
    .selectFrom("communities")
    .select("did")
    .execute();

  for (const community of communities) {
    await db
      .insertInto("community_spaces")
      .values({
        community_did: community.did,
        space_key: "announcements",
        name: "Announcements",
        description: "Group-only announcements from the community admins",
        space_type: "community.opensocial.space",
        read_access: "member",
        write_access: "admin",
        collections: JSON.stringify([ANNOUNCEMENT_COLLECTION]),
        created_by: community.did,
      })
      .onConflict((oc) =>
        oc.columns(["community_did", "space_key"]).doNothing(),
      )
      .execute();
  }
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable("space_invites").execute();
  await db.schema.dropTable("community_spaces").execute();
}
