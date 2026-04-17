import { Kysely, sql } from 'kysely';

/**
 * Migration: Add Cirrus PDS provisioning support.
 *
 * - Extends the `communities` table with columns that track whether
 *   the community is hosted on a Cirrus (Cloudflare Worker) PDS vs.
 *   an external PDS, along with deployment metadata.
 * - Creates a `community_secrets` table for encrypted storage of
 *   signing keys, auth tokens, and other PDS secrets.
 */
export async function up(db: Kysely<any>): Promise<void> {
  // ── Extend communities table ──────────────────────────────────────

  await sql`
    ALTER TABLE communities
      ADD COLUMN IF NOT EXISTS pds_type varchar(20) NOT NULL DEFAULT 'external',
      ADD COLUMN IF NOT EXISTS worker_name varchar(255),
      ADD COLUMN IF NOT EXISTS r2_bucket_name varchar(255),
      ADD COLUMN IF NOT EXISTS provisioning_status varchar(20) NOT NULL DEFAULT 'active',
      ADD COLUMN IF NOT EXISTS provisioned_at timestamp
  `.execute(db);

  // Add a check constraint for valid pds_type values
  await sql`
    ALTER TABLE communities
      ADD CONSTRAINT chk_pds_type CHECK (pds_type IN ('cirrus', 'external'))
  `.execute(db);

  // Add a check constraint for valid provisioning_status values
  await sql`
    ALTER TABLE communities
      ADD CONSTRAINT chk_provisioning_status CHECK (
        provisioning_status IN ('pending', 'provisioning', 'active', 'failed', 'deprovisioning')
      )
  `.execute(db);

  // ── Community secrets table ───────────────────────────────────────

  await sql`
    CREATE TABLE IF NOT EXISTS community_secrets (
      id serial PRIMARY KEY,
      community_did varchar(255) NOT NULL REFERENCES communities(did) ON DELETE CASCADE,
      secret_name varchar(100) NOT NULL,
      encrypted_value text NOT NULL,
      created_at timestamp NOT NULL DEFAULT now(),
      rotated_at timestamp,
      UNIQUE (community_did, secret_name)
    )
  `.execute(db);

  // Index for fast lookups by community
  await sql`
    CREATE INDEX IF NOT EXISTS idx_community_secrets_did
      ON community_secrets (community_did)
  `.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  // ── Drop community_secrets ────────────────────────────────────────
  await sql`DROP TABLE IF EXISTS community_secrets`.execute(db);

  // ── Remove added columns and constraints from communities ─────────
  await sql`ALTER TABLE communities DROP CONSTRAINT IF EXISTS chk_provisioning_status`.execute(db);
  await sql`ALTER TABLE communities DROP CONSTRAINT IF EXISTS chk_pds_type`.execute(db);
  await sql`
    ALTER TABLE communities
      DROP COLUMN IF EXISTS provisioned_at,
      DROP COLUMN IF EXISTS provisioning_status,
      DROP COLUMN IF EXISTS r2_bucket_name,
      DROP COLUMN IF EXISTS worker_name,
      DROP COLUMN IF EXISTS pds_type
  `.execute(db);
}
