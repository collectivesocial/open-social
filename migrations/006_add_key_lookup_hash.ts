import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  // Add a fast SHA-256 lookup column so the auth middleware can find the
  // correct app row by key without scanning every row with scrypt.
  await db.schema
    .alterTable('apps')
    .addColumn('key_lookup_hash', 'varchar(64)', (col) => col.unique())
    .execute();

  // Index for constant-time API key lookups.
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_apps_key_lookup_hash ON apps (key_lookup_hash)`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP INDEX IF EXISTS idx_apps_key_lookup_hash`.execute(db);
  await db.schema.alterTable('apps').dropColumn('key_lookup_hash').execute();
}
