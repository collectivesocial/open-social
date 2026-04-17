import { Kysely, sql } from 'kysely';

/**
 * Migration: Add optional DID to developer apps.
 *
 * Allows a developer to link an AT Protocol identity (e.g. a Bluesky account)
 * to their app. When a DID is linked, the system resolves the profile picture
 * from that identity and uses it as the app logo everywhere it appears.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`
    ALTER TABLE apps
      ADD COLUMN IF NOT EXISTS did varchar(255)
  `.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`
    ALTER TABLE apps
      DROP COLUMN IF EXISTS did
  `.execute(db);
}
