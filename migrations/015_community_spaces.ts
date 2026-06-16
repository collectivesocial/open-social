import type { Kysely } from "kysely";
import { sql } from "kysely";

export async function up(db: Kysely<any>): Promise<void> {
  // Maps a community to the permissioned space(s) provisioned for it.
  // One row per (community_did, kind).
  await db.schema
    .createTable("community_spaces")
    .addColumn("id", "serial", (col) => col.primaryKey())
    .addColumn("community_did", "text", (col) => col.notNull())
    .addColumn("kind", "text", (col) => col.notNull())
    .addColumn("space_uri", "text", (col) => col.notNull())
    .addColumn("created_at", "timestamptz", (col) =>
      col.notNull().defaultTo(sql`NOW()`),
    )
    .addUniqueConstraint("community_spaces_did_kind_unique", [
      "community_did",
      "kind",
    ])
    .execute();

  await db.schema
    .createIndex("idx_community_spaces_did")
    .on("community_spaces")
    .column("community_did")
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable("community_spaces").execute();
}
