import { z } from 'zod';
import { validateNSID } from '../lib/sanitize';

// Common schemas
export const didSchema = z.string().min(1, 'DID is required').startsWith('did:');
export const handleSchema = z.string().min(1, 'Handle is required');
export const cursorSchema = z.string().optional();
export const limitSchema = z.coerce.number().int().min(1).max(100).default(20);

// Collection/NSID schema - validates ATProto NSID format
export const nsidSchema = z.string().min(1, 'Collection is required').refine(
  (val) => validateNSID(val),
  { message: 'Collection must be a valid ATProto NSID (e.g., com.example.collectionName)' }
);

// App schemas
export const registerAppSchema = z.object({
  name: z.string().min(3).max(100).regex(/^[a-zA-Z0-9\s\-_]+$/, 'Name must be alphanumeric with spaces, hyphens, or underscores'),
  domain: z.string().min(1).regex(/^[a-zA-Z0-9][a-zA-Z0-9\-.]+\.[a-zA-Z]{2,}$/, 'Invalid domain format'),
});

export const updateAppSchema = z.object({
  name: z.string().min(3).max(100).regex(/^[a-zA-Z0-9\s\-_]+$/).optional(),
  domain: z.string().min(1).regex(/^[a-zA-Z0-9][a-zA-Z0-9\-.]+\.[a-zA-Z]{2,}$/).optional(),
  did: z.string().startsWith('did:').optional().nullable(),
}).refine(data => data.name || data.domain || data.did !== undefined, { message: 'At least one field (name, domain, or did) is required' });

// Community schemas
export const createCommunityApiKeySchema = z.object({
  did: didSchema,
  appPassword: z.string().min(1, 'App password is required'),
  displayName: z.string().min(1).max(64),
  creatorDid: didSchema,
  description: z.string().max(512).optional(),
});

export const createCommunityOAuthSchema = z.object({
  did: didSchema,
  appPassword: z.string().min(1, 'App password is required'),
  displayName: z.string().min(1).max(64),
  description: z.string().max(512).optional(),
});

// ── Cirrus "create-new" community schemas ────────────────────────────

/** Regex: lowercase alphanumeric + hyphens, 3-63 chars, can't start/end with hyphen */
const communityNameSchema = z
  .string()
  .min(3, 'Community name must be at least 3 characters')
  .max(63, 'Community name must be at most 63 characters')
  .regex(
    /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/,
    'Must be lowercase alphanumeric with hyphens; cannot start or end with a hyphen',
  );

/**
 * Schema for creating a brand-new community with a provisioned Cirrus PDS.
 * Used when mode === 'create-new' (OAuth path).
 */
export const createCommunityNewOAuthSchema = z.object({
  mode: z.literal('create-new'),
  communityName: communityNameSchema,
  displayName: z.string().min(1).max(64),
  description: z.string().max(512).optional(),
  customDomain: z.string().max(255).optional(),
});

/**
 * Schema for creating a brand-new community with a provisioned Cirrus PDS.
 * Used when mode === 'create-new' (API key path).
 */
export const createCommunityNewApiKeySchema = z.object({
  mode: z.literal('create-new'),
  communityName: communityNameSchema,
  displayName: z.string().min(1).max(64),
  creatorDid: didSchema,
  description: z.string().max(512).optional(),
  customDomain: z.string().max(255).optional(),
});

export const updateCommunityProfileSchema = z.object({
  displayName: z.string().min(1).max(64),
  description: z.string().max(512).optional(),
  type: z.enum(['open', 'admin-approved', 'private']).optional(),
  guidelines: z.string().max(3000).optional(),
});

export const searchCommunitiesSchema = z.object({
  query: z.string().optional(),
  userDid: didSchema.optional(),
  cursor: cursorSchema,
  limit: limitSchema,
});

// Member schemas
export const joinCommunitySchema = z.object({
  userDid: didSchema,
  membershipCid: z.string().optional(),
});

export const approveMemberSchema = z.object({
  adminDid: didSchema,
  memberDid: didSchema,
  reason: z.string().max(500).optional(),
});

export const rejectMemberSchema = z.object({
  adminDid: didSchema,
  memberDid: didSchema,
  reason: z.string().max(500).optional(),
});

export const removeMemberSchema = z.object({
  adminDid: didSchema,
  memberDid: didSchema,
  reason: z.string().max(500).optional(),
});

export const leaveCommunitySchema = z.object({
  userDid: didSchema,
});

export const listMembersSchema = z.object({
  adminDid: didSchema.optional(),
  public: z.string().optional(),
  search: z.string().optional(),
  cursor: cursorSchema,
  limit: limitSchema,
});

export const promoteMemberSchema = z.object({
  adminDid: didSchema,
  memberDid: didSchema,
});

export const demoteMemberSchema = z.object({
  adminDid: didSchema,
  memberDid: didSchema,
});

export const transferAdminSchema = z.object({
  currentOwnerDid: didSchema,
  newOwnerDid: didSchema,
});

export const deleteCommunitySchema = z.object({
  adminDid: didSchema,
});

// Record schemas
export const createRecordSchema = z.object({
  collection: nsidSchema,
  record: z.record(z.string(), z.any()).refine(r => r['$type'], { message: 'Record must include $type' }),
  userDid: didSchema,
  rkey: z.string().optional(),
});

export const updateRecordSchema = z.object({
  collection: nsidSchema,
  rkey: z.string().min(1, 'Record key is required'),
  record: z.record(z.string(), z.any()).refine(r => r['$type'], { message: 'Record must include $type' }),
  userDid: didSchema,
});

export const deleteRecordSchema = z.object({
  userDid: didSchema,
});

export const listRecordsSchema = z.object({
  limit: limitSchema,
  cursor: cursorSchema,
});

export const membershipCheckSchema = z.object({
  userDid: didSchema,
});

// Webhook schemas
export const createWebhookSchema = z.object({
  url: z.string().url('Must be a valid URL'),
  events: z.array(z.enum([
    'member.joined',
    'member.left',
    'member.approved',
    'member.rejected',
    'member.removed',
    'record.created',
    'record.updated',
    'record.deleted',
  ])).min(1, 'At least one event is required'),
  communityDid: didSchema.optional(),
});

export const updateWebhookSchema = z.object({
  url: z.string().url().optional(),
  events: z.array(z.enum([
    'member.joined',
    'member.left',
    'member.approved',
    'member.rejected',
    'member.removed',
    'record.created',
    'record.updated',
    'record.deleted',
  ])).min(1).optional(),
  active: z.boolean().optional(),
});

// Login schema
export const loginSchema = z.object({
  handle: z.string().min(1, 'Handle is required'),
});

// Audit log query
export const auditLogQuerySchema = z.object({
  adminDid: didSchema,
  cursor: cursorSchema,
  limit: limitSchema,
});

// ─── Permissions & moderation schemas ─────────────────────────────────

// Community settings
export const updateCommunitySettingsSchema = z.object({
  adminDid: didSchema,
  appVisibilityDefault: z.enum(['open', 'approval_required']).optional(),
  blockedAppIds: z.array(z.string()).optional(),
});

// App visibility management
export const updateAppVisibilitySchema = z.object({
  adminDid: didSchema,
  status: z.enum(['enabled', 'disabled', 'pending']),
});

// Collection permission schemas
export const collectionPermissionLevelSchema = z.enum(['admin', 'member']).or(z.string().min(1));

export const setCollectionPermissionSchema = z.object({
  adminDid: didSchema,
  collection: nsidSchema,
  canCreate: collectionPermissionLevelSchema.optional(),
  canRead: collectionPermissionLevelSchema.optional(),
  canUpdate: collectionPermissionLevelSchema.optional(),
  canDelete: collectionPermissionLevelSchema.optional(),
});

export const deleteCollectionPermissionSchema = z.object({
  adminDid: didSchema,
  collection: nsidSchema,
});

// App default permissions (used during registration)
export const appDefaultPermissionSchema = z.object({
  collection: nsidSchema,
  defaultCanCreate: collectionPermissionLevelSchema.default('member'),
  defaultCanRead: collectionPermissionLevelSchema.default('member'),
  defaultCanUpdate: collectionPermissionLevelSchema.default('member'),
  defaultCanDelete: collectionPermissionLevelSchema.default('admin'),
});

export const registerAppWithPermissionsSchema = registerAppSchema.extend({
  did: z.string().startsWith('did:').optional().nullable(),
  defaultPermissions: z.array(appDefaultPermissionSchema).optional(),
});

// Role schemas
export const createRoleSchema = z.object({
  adminDid: didSchema,
  name: z.string().min(1).max(100).regex(/^[a-z0-9_-]+$/, 'Role name must be lowercase alphanumeric with hyphens or underscores'),
  displayName: z.string().min(1).max(255),
  description: z.string().max(500).optional(),
  visible: z.boolean().default(false),
});

export const updateRoleSchema = z.object({
  adminDid: didSchema,
  displayName: z.string().min(1).max(255).optional(),
  description: z.string().max(500).optional(),
  visible: z.boolean().optional(),
}).refine(data => data.displayName || data.description !== undefined || data.visible !== undefined, {
  message: 'At least one field is required',
});

export const deleteRoleSchema = z.object({
  adminDid: didSchema,
});

export const assignRoleSchema = z.object({
  adminDid: didSchema,
  memberDid: didSchema,
  roleName: z.string().min(1),
});

export const revokeRoleSchema = z.object({
  adminDid: didSchema,
  memberDid: didSchema,
  roleName: z.string().min(1),
});
