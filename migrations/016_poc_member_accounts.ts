import type { Kysely } from "kysely";
import { sql } from "kysely";

export async function up(db: Kysely<any>): Promise<void> {
  // Dev-only: app-passwords for member accounts so the PoC can act as them
  // (stand-in for real OAuth). Never used in production.
  await db.schema
    .createTable("poc_member_accounts")
    .addColumn("did", "text", (col) => col.primaryKey())
    .addColumn("handle", "text", (col) => col.notNull())
    .addColumn("pds_host", "text", (col) => col.notNull())
    .addColumn("app_password", "text", (col) => col.notNull())
    .addColumn("created_at", "timestamptz", (col) =>
      col.notNull().defaultTo(sql`NOW()`),
    )
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable("poc_member_accounts").execute();
}
