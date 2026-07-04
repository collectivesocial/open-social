# Audit Log to Management Space — Design

**Date:** 2026-07-04
**Status:** Approved (follow-up to the Phase 1 permissioned-spaces backend; deferred item from `docs/superpowers/plans/2026-07-03-permissioned-spaces-backend.md`)

## Context

OpenSocial's audit log lives only in Postgres (`audit_log` table, written best-effort by `createAuditLogService` in `src/services/auditLog.ts`). The Atmospheric Groups roadmap (`docs/2026-07-03-atmospheric-groups-permissioned-spaces-plan.md` §2.6) calls for audit history to live in the community's **management space** so it is portable: if a community moves to a different management app, its audit history moves with its spaces. Additionally, the space-era governance paths (`recordMembership`, `assignRole`, `writeRoleDefinition`) currently produce no audit entries at all — only the legacy XRPC/route paths audit.

## Decisions (user-confirmed)

1. **Dual-write.** Every audit event writes an `auditLogEntry` record into the management space (portable source of truth) AND the existing Postgres row (fast queryable mirror). Both are independently best-effort, preserving today's never-throw contract. The `query()` read path is unchanged (Postgres).
2. **Governance audit points added** to the space paths: `recordMembership` → `member.joined`; `assignRole` → `role.assigned`; `writeRoleDefinition` → `role.created`. Posts stay un-audited (content, not governance).
3. **Mechanism: single choke point.** `createAuditLogService.log()` dual-writes internally; all existing and future callers get space records for free. (Rejected: a separate explicit space-audit service — drift risk; an async outbox — a worker moving part devnet-stage OpenSocial doesn't need.)

## Design

### Lexicon

New `lexicons/community.opensocial.auditLogEntry.json`: record, key `tid`, required `actor`, `action`, `createdAt`:

| Field       | Type                     | Notes                              |
| ----------- | ------------------------ | ---------------------------------- |
| `actor`     | did                      | maps from Postgres `admin_did`     |
| `action`    | string (≤100)            | the existing `AuditAction` strings |
| `target`    | did, optional            | maps from `target_did`             |
| `reason`    | string (≤2048), optional |                                    |
| `metadata`  | unknown, optional        |                                    |
| `createdAt` | datetime                 |                                    |

`community.opensocial.auditLogEntry` is added to the `management` space type's `collections` in `lexicons/community.opensocial.management.json`. The existing `publish:lexicons` script picks both up automatically.

Append-only enforcement via the `managementPermissions` permission set remains deferred: the atproto `permissioned-data` branch still drops `space:` permissions inside permission sets.

### Dual-write (`src/services/auditLog.ts`)

`log()` keeps its exact signature. After the Postgres insert (unchanged), best-effort space write:

1. `getCommunitySpace(db, communityDid, "management")` — if `null` (unprovisioned/legacy community), skip silently (debug log).
2. `getSpaceClient(db, communityDid)` → `createRecord(mgmt, "community.opensocial.auditLogEntry", { $type, actor, action, target?, reason?, metadata?, createdAt })`.
3. Any space-write failure: `logger.warn`, never throw. The Postgres write and space write fail independently — a space outage never loses the Postgres row and vice versa.

No import cycle: `auditLog.ts` → `spaces.ts` is a new edge; `spaces.ts` does not import `auditLog.ts`.

### New governance audit points

- `recordMembership` (src/services/membership.ts): after a new membership record is written (not on the idempotent-skip path), log `member.joined` with actor = `opts.approvedBy ?? subjectDid`, target = subjectDid.
- `assignRole` (src/services/roles.ts): after a new assignment (not on the idempotent-skip path), log `role.assigned` with actor = `assignedBy ?? communityDid`, target = subjectDid, metadata `{ role }`.
- `writeRoleDefinition` (src/services/roles.ts): log `role.created` with actor = communityDid, metadata `{ name, capabilities }`.

No double-logging: the legacy XRPC paths that already audit (`xrpc/members.ts`, routes) do not call these functions.

## Error handling

Unchanged contract: audit logging is best-effort everywhere and never fails the calling operation. Skip-silently when no management space exists.

## Testing

- **Unit (vitest, existing mock patterns):** dual-write happy path (space record shape asserted); no-management-space skip; space-write failure still writes Postgres; Postgres failure still writes space; the three new audit points fire with correct actor/target/metadata and NOT on idempotent-skip paths.
- **Devnet e2e (extend `test/devnet-spaces.test.ts`):** after seeding, the admin (`osadmin.test`, holds `manage`) mints a space credential for the **management** space via `getDelegationToken` → `getSpaceCredential` (exercising the admin-only management-space branch of `checkUserAccess` live) and `listRecords` on the community's repo shows `community.opensocial.auditLogEntry` records.

## Out of scope

- Reading audit entries back from the space (Postgres remains the query path).
- Backfilling historical Postgres rows into the space (devnet data is throwaway).
- Append-only permission-set enforcement (blocked on the atproto branch).
- Audit points for posts or space provisioning.
