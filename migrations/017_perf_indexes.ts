import { Kysely, sql } from 'kysely';

/**
 * Migration: Indexes for hot query paths that previously seq-scanned.
 *
 * - audit_log is queried as `WHERE community_did = ? ORDER BY created_at DESC`
 *   and grows unbounded.
 * - pending_members is point-looked-up by (community_did, user_did) on every
 *   join/approve/reject/membership check, and listed by
 *   (community_did, status) ordered by created_at.
 * - webhooks is filtered by `active` and `community_did` on every dispatched
 *   event (i.e. every membership/record mutation).
 */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`CREATE INDEX IF NOT EXISTS idx_audit_log_community_created ON audit_log (community_did, created_at DESC)`.execute(
    db
  );
  await sql`CREATE INDEX IF NOT EXISTS idx_pending_members_community_user ON pending_members (community_did, user_did)`.execute(
    db
  );
  await sql`CREATE INDEX IF NOT EXISTS idx_pending_members_community_status_created ON pending_members (community_did, status, created_at)`.execute(
    db
  );
  await sql`CREATE INDEX IF NOT EXISTS idx_webhooks_active_community ON webhooks (active, community_did)`.execute(
    db
  );
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP INDEX IF EXISTS idx_webhooks_active_community`.execute(db);
  await sql`DROP INDEX IF EXISTS idx_pending_members_community_status_created`.execute(db);
  await sql`DROP INDEX IF EXISTS idx_pending_members_community_user`.execute(db);
  await sql`DROP INDEX IF EXISTS idx_audit_log_community_created`.execute(db);
}
