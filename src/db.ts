import { Generated, Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";
import type { AuthState, AuthSession } from "./models/auth";

export interface Community {
  did: string;
  handle: string;
  display_name: string;
  pds_host: string;
  app_password: string;
  created_at: Generated<Date>;
  // Cached metadata (refreshed every 24h)
  description: string | null;
  avatar_url: string | null;
  community_type: string | null;
  member_count: number | null;
  metadata_fetched_at: Date | null;
}

export interface App {
  id: Generated<number>;
  app_id: string;
  name: string;
  domain: string;
  creator_did: string;
  api_key: string;
  auth_method: "api_key" | "http_signature" | "both";
  cimd_url: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  status: string;
}

export interface RateLimit {
  id: Generated<number>;
  app_id: string;
  max_requests: number;
  window_ms: number;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface Webhook {
  id: Generated<number>;
  app_id: string;
  url: string;
  events: string; // JSON array of event names
  secret: string | null;
  community_did: string | null;
  active: boolean;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface AuditLogEntry {
  id: Generated<number>;
  community_did: string;
  admin_did: string;
  action: string;
  target_did: string | null;
  reason: string | null;
  metadata: string | null; // JSON
  created_at: Generated<Date>;
}

export interface PendingMember {
  id: Generated<number>;
  community_did: string;
  user_did: string;
  status: string; // 'pending' | 'approved' | 'rejected'
  reason: string | null;
  reviewed_by: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

// ─── Permissions & moderation tables ─────────────────────────────────

/**
 * Community-level settings that govern default behaviour for app visibility.
 * One row per community.
 */
export interface CommunitySettings {
  id: Generated<number>;
  community_did: string;
  /** 'open' = auto-enabled on all apps, 'approval_required' = admin must approve each app */
  app_visibility_default: string;
  /** JSON array of app_ids this community has explicitly blocked */
  blocked_app_ids: string; // JSON text — e.g. '["app_abc","app_def"]'
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

/**
 * Per app-community visibility override.
 * A missing row means "use the community's default policy".
 */
export interface CommunityAppVisibility {
  id: Generated<number>;
  community_did: string;
  app_id: string;
  /** 'enabled' | 'disabled' | 'pending' */
  status: string;
  requested_by: string | null;
  reviewed_by: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

/**
 * Custom roles defined by a community.
 * Every community implicitly has "admin" and "member" built-in roles.
 */
export interface CommunityRole {
  id: Generated<number>;
  community_did: string;
  /** Machine-readable name, unique per community (e.g. 'moderator', 'curator') */
  name: string;
  /** Human-readable label shown in UI */
  display_name: string;
  /** Optional description */
  description: string | null;
  /** Whether this role name is publicly visible on member profiles */
  visible: boolean;
  /** Whether holders of this role can view the community audit log */
  can_view_audit_log: boolean;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

/**
 * Assigns a role to a member in a community.
 * A member may hold multiple roles.
 */
export interface CommunityMemberRole {
  id: Generated<number>;
  community_did: string;
  member_did: string;
  /** References community_roles.name (or built-in 'admin'/'member') */
  role_name: string;
  assigned_by: string;
  created_at: Generated<Date>;
}

/**
 * Default collection permissions declared by an app at registration time.
 * Copied into community_app_collection_permissions when an app is enabled for a community.
 */
export interface AppDefaultPermission {
  id: Generated<number>;
  app_id: string;
  collection: string;
  /** Which role is required: 'admin' | 'member' | role name */
  default_can_create: string;
  default_can_read: string;
  default_can_update: string;
  default_can_delete: string;
  created_at: Generated<Date>;
}

/**
 * Per app + community + collection permission overrides.
 * If no row exists for a (community, app, collection) the collection cannot be
 * accessed through that app — explicit opt-in.
 */
export interface CommunityAppCollectionPermission {
  id: Generated<number>;
  community_did: string;
  app_id: string;
  collection: string;
  /** Which role is the minimum required: 'admin' | 'member' | custom role name */
  can_create: string;
  can_read: string;
  can_update: string;
  can_delete: string;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

/**
 * Tracks pending parent/child hierarchy requests so the target community can
 * discover incoming proposals.  Analogous to `pending_members`.
 */
export interface PendingHierarchyRequest {
  id: Generated<number>;
  requester_did: string;
  target_did: string;
  /** 'parent' | 'child' — the role of the requester in the proposed relationship */
  requester_role: string;
  requester_record_rkey: string;
  admin_did: string;
  created_at: Generated<Date>;
}

/**
 * Cached DID documents, persisted across process restarts so we can avoid
 * re-hitting the PLC directory on every login.  Backed by the `did_cache`
 * table introduced in migration 007.
 */
export interface DidCacheEntry {
  did: string;
  /** Raw DID document JSON (Postgres `jsonb`). */
  doc: unknown;
  updated_at: Generated<Date>;
  expires_at: Date;
}

export interface EventLogEntry {
  id: Generated<number>;
  event_type: string;
  community_did: string | null;
  payload: unknown; // jsonb
  created_at: Generated<Date>;
}

export interface StreamToken {
  id: Generated<number>;
  token: string;
  app_id: number;
  community_did: string | null;
  expires_at: Date;
  created_at: Generated<Date>;
}

/**
 * Permissioned spaces provisioned for a community.
 *
 * Maps a community to the AT Protocol permissioned space (com.atproto.space.*)
 * that holds a given kind of data — `management` (governance + membership +
 * hierarchy) or `content` (shared content + community documents). One row per
 * (community_did, kind). See `services/spaces.ts`.
 */
export interface CommunitySpace {
  id: Generated<number>;
  community_did: string;
  /** 'management' | 'posts' */
  kind: string;
  /** The space URI returned by com.atproto.simplespace.createSpace. */
  space_uri: string;
  created_at: Generated<Date>;
}

/**
 * Dev-only member accounts for PoC.
 *
 * Stores app-passwords for member DIDs so the PoC `/poc` endpoints can write
 * "as a member" without real OAuth. Encrypted password persisted, keyed by DID.
 * Never used in production.
 */
export interface PocMemberAccount {
  did: string;
  handle: string;
  pds_host: string;
  app_password: string;
  created_at: Generated<Date>;
}

// ─── Database type map ───────────────────────────────────────────────

export interface Database {
  auth_state: AuthState;
  auth_session: AuthSession;
  communities: Community;
  apps: App;
  rate_limits: RateLimit;
  webhooks: Webhook;
  audit_log: AuditLogEntry;
  pending_members: PendingMember;
  community_settings: CommunitySettings;
  community_app_visibility: CommunityAppVisibility;
  community_roles: CommunityRole;
  community_member_roles: CommunityMemberRole;
  app_default_permissions: AppDefaultPermission;
  community_app_collection_permissions: CommunityAppCollectionPermission;
  pending_hierarchy_requests: PendingHierarchyRequest;
  did_cache: DidCacheEntry;
  event_log: EventLogEntry;
  stream_tokens: StreamToken;
  community_spaces: CommunitySpace;
  poc_member_accounts: PocMemberAccount;
}

export function createDb(connectionString: string): Kysely<Database> {
  return new Kysely<Database>({
    dialect: new PostgresDialect({
      pool: new Pool({
        connectionString,
      }),
    }),
  });
}
