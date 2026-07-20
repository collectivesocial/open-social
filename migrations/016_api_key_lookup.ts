import { Kysely, sql } from 'kysely';

/**
 * Migration: Add a deterministic lookup column for API keys.
 *
 * API key hashes use scrypt with a per-key random salt, so the middleware
 * cannot look an app up by its stored hash — it had to scan every active app
 * and run scrypt against each one. `api_key_lookup` stores the SHA-256 hex of
 * the raw key (keys are 256-bit random values, so an unsalted digest is safe)
 * and lets auth fetch exactly one candidate row via the index.
 *
 * The column is nullable and not backfilled: existing rows only hold salted
 * scrypt hashes, from which the raw key (and therefore its SHA-256) cannot be
 * recovered. Auth falls back to the legacy scan for such rows and backfills
 * the column opportunistically on a successful match.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable('apps')
    .addColumn('api_key_lookup', 'varchar(64)')
    .execute();

  await sql`CREATE INDEX IF NOT EXISTS idx_apps_api_key_lookup ON apps (api_key_lookup)`.execute(
    db
  );
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP INDEX IF EXISTS idx_apps_api_key_lookup`.execute(db);
  await db.schema.alterTable('apps').dropColumn('api_key_lookup').execute();
}
