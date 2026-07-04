# Audit Log to Management Space Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Dual-write audit events into the community's management space as `community.opensocial.auditLogEntry` records (portable audit history), and add governance audit points to the space-era membership/role paths.

**Architecture:** Single choke point — `createAuditLogService(db).log()` keeps its signature and best-effort contract, writing Postgres (unchanged) and then, independently best-effort, a space record via `getCommunitySpace`/`getSpaceClient`. `recordMembership`, `assignRole`, and `writeRoleDefinition` gain audit calls (on their non-idempotent paths only). Read path (`query()`) untouched.

**Tech Stack:** Node 22, plain npm, CJS, Express 5, vitest, Kysely/Postgres, hand-rolled `SpaceClient` (fetch).

**Spec:** `docs/superpowers/specs/2026-07-04-audit-log-to-space-design.md` — binding for field mappings and semantics.

## Global Constraints

- Node 22 required (default shell is Node 18): `export PATH="$HOME/.nvm/versions/node/$(ls ~/.nvm/versions/node/ | grep v22 | head -1)/bin:$PATH"` in every shell.
- Repo: `/Users/brittany/Documents/Collective/open-social`, branch created from `docs/atmospheric-groups-permissioned-spaces-plan`. Commit directly to the feature branch.
- Audit logging NEVER throws to callers; Postgres write and space write fail independently (each has its own catch). No management space → skip space write silently (debug-level log).
- Space record shape (exact): `{ $type: "community.opensocial.auditLogEntry", actor, action, target?, reason?, metadata?, createdAt }` — `actor` from `params.adminDid`, `target` from `params.targetDid`, optional fields OMITTED when absent (not null).
- Unit tests: `npx vitest run <file>`; full suite `npx vitest run` + `npx tsc --noEmit` before each commit. One pre-existing Postgres-dependent failure in `src/routes/community-membership.test.ts` (ECONNREFUSED :5432) is acceptable; nothing else may fail.
- Husky/lint-staged runs prettier on commit — reformatting is expected.

## File Structure

- `lexicons/community.opensocial.auditLogEntry.json` — NEW record lexicon
- `lexicons/community.opensocial.management.json` — modified: add auditLogEntry to `collections`
- `src/lib/lexiconDocs.test.ts` — modified: assert the new lexicon loads + is listed
- `src/services/auditLog.ts` — modified: dual-write
- `src/services/auditLog.space.test.ts` — NEW: dual-write unit tests
- `src/services/membership.ts` — modified: `member.joined` audit point
- `src/services/membership.roster.test.ts` — modified: audit-point tests (mock `./auditLog`)
- `src/services/roles.ts` — modified: `role.assigned` / `role.created` audit points
- `src/services/roles.audit.test.ts` — NEW: audit-point tests (mock `./auditLog`)
- `test/devnet-spaces.test.ts` — modified: admin management-space credential + auditLogEntry live assertions

---

### Task 1: auditLogEntry lexicon

**Files:**

- Create: `lexicons/community.opensocial.auditLogEntry.json`
- Modify: `lexicons/community.opensocial.management.json` (collections array)
- Test: `src/lib/lexiconDocs.test.ts`

**Interfaces:**

- Produces: NSID `community.opensocial.auditLogEntry` resolvable after `npm run publish:lexicons`; management space type declares it.
- Consumes: `loadLexiconDocs` (src/lib/lexiconDocs.ts, existing).

- [ ] **Step 1: Extend the failing test**

In `src/lib/lexiconDocs.test.ts`, add `"community.opensocial.auditLogEntry"` to the `required` list in the first test, and in the second test add:

```ts
expect(mgmt.defs.main.collections).toContain(
  "community.opensocial.auditLogEntry",
);
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/lib/lexiconDocs.test.ts`
Expected: FAIL — id not found / collections missing entry.

- [ ] **Step 3: Create the lexicon and update management collections**

`lexicons/community.opensocial.auditLogEntry.json`:

```json
{
  "lexicon": 1,
  "id": "community.opensocial.auditLogEntry",
  "defs": {
    "main": {
      "type": "record",
      "description": "An append-only audit log entry in a community's management space. Mirrors the management app's audit trail so it is portable across management apps.",
      "key": "tid",
      "record": {
        "type": "object",
        "required": ["actor", "action", "createdAt"],
        "properties": {
          "actor": { "type": "string", "format": "did" },
          "action": { "type": "string", "maxLength": 100 },
          "target": { "type": "string", "format": "did" },
          "reason": { "type": "string", "maxLength": 2048 },
          "metadata": { "type": "unknown" },
          "createdAt": { "type": "string", "format": "datetime" }
        }
      }
    }
  }
}
```

In `lexicons/community.opensocial.management.json`, add `"community.opensocial.auditLogEntry"` to `defs.main.collections`.

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/lib/lexiconDocs.test.ts && npx vitest run && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lexicons/community.opensocial.auditLogEntry.json lexicons/community.opensocial.management.json src/lib/lexiconDocs.test.ts
git commit -m "feat: add community.opensocial.auditLogEntry lexicon to the management space"
```

---

### Task 2: Dual-write in the audit service

**Files:**

- Modify: `src/services/auditLog.ts`
- Test: `src/services/auditLog.space.test.ts` (new)

**Interfaces:**

- Consumes: `getCommunitySpace(db, communityDid, "management"): Promise<string | null>` and `getSpaceClient(db, communityDid): Promise<SpaceClient>` from `src/services/spaces.ts`; `SpaceClient.createRecord(space, collection, record): Promise<{uri, cid}>`.
- Produces: `createAuditLogService(db).log(params)` — SAME signature, now dual-writing. Exported constant `AUDIT_LOG_ENTRY = "community.opensocial.auditLogEntry"`.

- [ ] **Step 1: Write the failing test**

Create `src/services/auditLog.space.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mocks } = vi.hoisted(() => ({
  mocks: {
    getCommunitySpace: vi.fn(),
    getSpaceClient: vi.fn(),
    client: { createRecord: vi.fn(async () => ({ uri: "u", cid: "c" })) },
  },
}));

vi.mock("./spaces", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getCommunitySpace: mocks.getCommunitySpace,
  getSpaceClient: mocks.getSpaceClient,
}));

import { createAuditLogService, AUDIT_LOG_ENTRY } from "./auditLog";

const MGMT = "ats://did:plc:comm/community.opensocial.management/m";

function stubDb(opts: { failInsert?: boolean } = {}) {
  const execute = opts.failInsert
    ? vi.fn(async () => {
        throw new Error("pg down");
      })
    : vi.fn(async () => []);
  const values = vi.fn(() => ({ execute }));
  const insertInto = vi.fn(() => ({ values }));
  return { db: { insertInto } as any, insertInto, values, execute };
}

describe("audit log dual-write", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getCommunitySpace.mockResolvedValue(MGMT);
    mocks.getSpaceClient.mockResolvedValue(mocks.client);
    mocks.client.createRecord.mockClear();
    mocks.client.createRecord.mockResolvedValue({ uri: "u", cid: "c" });
  });

  it("writes Postgres AND an auditLogEntry record into the management space", async () => {
    const { db, insertInto } = stubDb();
    await createAuditLogService(db).log({
      communityDid: "did:plc:comm",
      adminDid: "did:plc:admin",
      action: "member.approved",
      targetDid: "did:plc:new",
      reason: "welcome",
      metadata: { via: "test" },
    });
    expect(insertInto).toHaveBeenCalledWith("audit_log");
    expect(mocks.client.createRecord).toHaveBeenCalledTimes(1);
    const [space, collection, record] = mocks.client.createRecord.mock.calls[0];
    expect(space).toBe(MGMT);
    expect(collection).toBe(AUDIT_LOG_ENTRY);
    expect(record).toEqual({
      $type: AUDIT_LOG_ENTRY,
      actor: "did:plc:admin",
      action: "member.approved",
      target: "did:plc:new",
      reason: "welcome",
      metadata: { via: "test" },
      createdAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    });
  });

  it("omits optional fields when absent (no nulls)", async () => {
    const { db } = stubDb();
    await createAuditLogService(db).log({
      communityDid: "did:plc:comm",
      adminDid: "did:plc:admin",
      action: "community.updated",
    });
    const record = mocks.client.createRecord.mock.calls[0][2];
    expect(record).not.toHaveProperty("target");
    expect(record).not.toHaveProperty("reason");
    expect(record).not.toHaveProperty("metadata");
  });

  it("skips the space write when no management space is provisioned", async () => {
    mocks.getCommunitySpace.mockResolvedValue(null);
    const { db, insertInto } = stubDb();
    await createAuditLogService(db).log({
      communityDid: "did:plc:legacy",
      adminDid: "did:plc:admin",
      action: "member.joined",
    });
    expect(insertInto).toHaveBeenCalled();
    expect(mocks.getSpaceClient).not.toHaveBeenCalled();
    expect(mocks.client.createRecord).not.toHaveBeenCalled();
  });

  it("still writes the space record when the Postgres insert fails", async () => {
    const { db } = stubDb({ failInsert: true });
    await expect(
      createAuditLogService(db).log({
        communityDid: "did:plc:comm",
        adminDid: "did:plc:admin",
        action: "member.joined",
      }),
    ).resolves.toBeUndefined();
    expect(mocks.client.createRecord).toHaveBeenCalledTimes(1);
  });

  it("still writes Postgres and never throws when the space write fails", async () => {
    mocks.client.createRecord.mockRejectedValue(new Error("space down"));
    const { db, insertInto } = stubDb();
    await expect(
      createAuditLogService(db).log({
        communityDid: "did:plc:comm",
        adminDid: "did:plc:admin",
        action: "member.joined",
      }),
    ).resolves.toBeUndefined();
    expect(insertInto).toHaveBeenCalled();
  });

  it("never throws when the space lookup itself fails", async () => {
    mocks.getCommunitySpace.mockRejectedValue(new Error("db blip"));
    const { db } = stubDb();
    await expect(
      createAuditLogService(db).log({
        communityDid: "did:plc:comm",
        adminDid: "did:plc:admin",
        action: "member.joined",
      }),
    ).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/services/auditLog.space.test.ts`
Expected: FAIL — `AUDIT_LOG_ENTRY` not exported; `createRecord` never called.

- [ ] **Step 3: Implement dual-write in `src/services/auditLog.ts`**

Add imports and constant at the top:

```ts
import { getCommunitySpace, getSpaceClient } from "./spaces";

export const AUDIT_LOG_ENTRY = "community.opensocial.auditLogEntry";
```

Inside `createAuditLogService`, add a private helper and call it from `log` after the Postgres try/catch (NOT inside it):

```ts
async function writeSpaceEntry(params: {
  communityDid: string;
  adminDid: string;
  action: AuditAction;
  targetDid?: string;
  reason?: string;
  metadata?: Record<string, any>;
}) {
  try {
    const mgmt = await getCommunitySpace(db, params.communityDid, "management");
    if (!mgmt) {
      logger.debug(
        { communityDid: params.communityDid, action: params.action },
        "no management space; skipping space audit entry",
      );
      return;
    }
    const client = await getSpaceClient(db, params.communityDid);
    await client.createRecord(mgmt, AUDIT_LOG_ENTRY, {
      $type: AUDIT_LOG_ENTRY,
      actor: params.adminDid,
      action: params.action,
      ...(params.targetDid ? { target: params.targetDid } : {}),
      ...(params.reason ? { reason: params.reason } : {}),
      ...(params.metadata ? { metadata: params.metadata } : {}),
      createdAt: new Date().toISOString(),
    });
  } catch (err) {
    logger.warn(
      { error: err, communityDid: params.communityDid, action: params.action },
      "Failed to write audit log entry to management space",
    );
  }
}
```

And at the end of `log(...)` (after the existing try/catch around the Postgres insert):

```ts
await writeSpaceEntry(params);
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/services/auditLog.space.test.ts && npx vitest run && npx tsc --noEmit`
Expected: all PASS (plus the known pre-existing Postgres failure).

- [ ] **Step 5: Commit**

```bash
git add src/services/auditLog.ts src/services/auditLog.space.test.ts
git commit -m "feat: dual-write audit entries into the management space"
```

---

### Task 3: Governance audit points

**Files:**

- Modify: `src/services/membership.ts` (`recordMembership`)
- Modify: `src/services/roles.ts` (`assignRole`, `writeRoleDefinition`)
- Test: `src/services/membership.roster.test.ts` (extend), `src/services/roles.audit.test.ts` (new)

**Interfaces:**

- Consumes: `createAuditLogService(db).log(...)` (Task 2 — but only the pre-existing signature, so this task does not depend on Task 2's internals).
- Produces: `member.joined`, `role.assigned`, `role.created` audit events from the space paths. Audit fires ONLY on the non-idempotent path (a record was actually written).

- [ ] **Step 1: Write the failing tests**

In `src/services/membership.roster.test.ts`, add to the hoisted mocks a `logSpy: vi.fn()`, mock the audit module alongside the existing mocks:

```ts
vi.mock("./auditLog", () => ({
  createAuditLogService: () => ({ log: mocks.logSpy }),
}));
```

Add two tests to the existing describe:

```ts
it("logs member.joined for a new member", async () => {
  await recordMembership({} as any, "did:plc:comm", "did:plc:new", {
    approvedBy: "did:plc:admin",
  });
  expect(mocks.logSpy).toHaveBeenCalledWith(
    expect.objectContaining({
      communityDid: "did:plc:comm",
      adminDid: "did:plc:admin",
      action: "member.joined",
      targetDid: "did:plc:new",
    }),
  );
});

it("does not log member.joined on the idempotent path", async () => {
  mocks.client.listRecordValues.mockResolvedValue([
    {
      rkey: "1",
      cid: "c",
      value: { subject: "did:plc:new", status: "active", joinedAt: "x" },
    },
  ]);
  await recordMembership({} as any, "did:plc:comm", "did:plc:new");
  expect(mocks.logSpy).not.toHaveBeenCalled();
});
```

(Also assert in the first new test that with NO `approvedBy`, `adminDid` falls back to the subject: add a third test calling without opts and expecting `adminDid: "did:plc:new"`.)

Create `src/services/roles.audit.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mocks } = vi.hoisted(() => ({
  mocks: {
    getSpaceClient: vi.fn(),
    getCommunitySpace: vi.fn(),
    logSpy: vi.fn(),
    client: {
      putRecord: vi.fn(async () => ({ uri: "u", cid: "c" })),
      createRecord: vi.fn(async () => ({ uri: "u", cid: "c" })),
      listRecordValues: vi.fn(async () => []),
    },
  },
}));

vi.mock("./spaces", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getSpaceClient: mocks.getSpaceClient,
  getCommunitySpace: mocks.getCommunitySpace,
}));
vi.mock("./auditLog", () => ({
  createAuditLogService: () => ({ log: mocks.logSpy }),
}));

import { writeRoleDefinition, assignRole } from "./roles";

describe("role governance audit points", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getCommunitySpace.mockResolvedValue(
      "ats://c/community.opensocial.management/m",
    );
    mocks.getSpaceClient.mockResolvedValue(mocks.client);
    mocks.client.listRecordValues.mockResolvedValue([]);
  });

  it("writeRoleDefinition logs role.created with name and capabilities", async () => {
    await writeRoleDefinition(
      {} as any,
      "did:plc:comm",
      "moderator",
      "Moderator",
      ["post"],
    );
    expect(mocks.logSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        communityDid: "did:plc:comm",
        adminDid: "did:plc:comm",
        action: "role.created",
        metadata: { name: "moderator", capabilities: ["post"] },
      }),
    );
  });

  it("assignRole logs role.assigned with actor fallback to community DID", async () => {
    await assignRole({} as any, "did:plc:comm", "did:plc:bob", "moderator");
    expect(mocks.logSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        adminDid: "did:plc:comm",
        action: "role.assigned",
        targetDid: "did:plc:bob",
        metadata: { role: "moderator" },
      }),
    );
  });

  it("assignRole logs the assigner as actor when provided", async () => {
    await assignRole(
      {} as any,
      "did:plc:comm",
      "did:plc:bob",
      "moderator",
      "did:plc:admin",
    );
    expect(mocks.logSpy).toHaveBeenCalledWith(
      expect.objectContaining({ adminDid: "did:plc:admin" }),
    );
  });

  it("assignRole does not log on the idempotent path (assignment already exists)", async () => {
    mocks.client.listRecordValues.mockResolvedValue([
      {
        rkey: "1",
        cid: "c",
        value: { subject: "did:plc:bob", role: "moderator" },
      },
    ]);
    await assignRole({} as any, "did:plc:comm", "did:plc:bob", "moderator");
    expect(mocks.logSpy).not.toHaveBeenCalled();
  });
});
```

NOTE: before finalizing these tests, READ `src/services/roles.ts` — match the actual parameter order of `writeRoleDefinition(db, communityDid, name, displayName, capabilities)` and `assignRole(db, communityDid, subjectDid, roleName, assignedBy?)`, and the actual idempotency mechanism (it lists existing assignments); adjust the mocked `client` methods to the ones the real code calls (`putRecord` for role definitions, `createRecord` for assignments, `listRecordValues` for the idempotency check). If `writeRoleDefinition` is an upsert with no idempotent skip, `role.created` fires on every call — that matches the spec (it maps to both create and update today; keep `role.created` per spec).

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/services/membership.roster.test.ts src/services/roles.audit.test.ts`
Expected: FAIL — `logSpy` never called.

- [ ] **Step 3: Implement the audit points**

In `src/services/membership.ts` — import `createAuditLogService` from `./auditLog`; inside `recordMembership`, ONLY inside the `if (!roster.some(...))` branch, after the `createRecord` call:

```ts
await createAuditLogService(db).log({
  communityDid,
  adminDid: opts.approvedBy ?? subjectDid,
  action: "member.joined",
  targetDid: subjectDid,
});
```

In `src/services/roles.ts` — import `createAuditLogService` from `./auditLog`.

In `writeRoleDefinition`, after the `putRecord`:

```ts
await createAuditLogService(db).log({
  communityDid,
  adminDid: communityDid,
  action: "role.created",
  metadata: { name, capabilities },
});
```

In `assignRole`, ONLY on the path where a new assignment record is created (after its `createRecord`):

```ts
await createAuditLogService(db).log({
  communityDid,
  adminDid: assignedBy ?? communityDid,
  action: "role.assigned",
  targetDid: subjectDid,
  metadata: { role: roleName },
});
```

(Adapt local variable names to the actual function signatures.)

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/services/membership.roster.test.ts src/services/roles.audit.test.ts && npx vitest run && npx tsc --noEmit`
Expected: all PASS. If pre-existing membership tests now fail because `createAuditLogService` is not mocked in some other test file that calls `recordMembership`/`assignRole` (e.g. via routes tests), mock `./auditLog` there the same way — audit is best-effort so real code would swallow, but mocked DBs may make the Postgres stub throw noisily; check test output is pristine.

- [ ] **Step 5: Commit**

```bash
git add src/services/membership.ts src/services/roles.ts src/services/membership.roster.test.ts src/services/roles.audit.test.ts
git commit -m "feat: audit governance operations on the space paths"
```

---

### Task 4: Devnet e2e — admin reads audit entries from the management space

**Files:**

- Modify: `test/devnet-spaces.test.ts`

**Interfaces:**

- Consumes: seeded accounts (`osadmin.test` / `admin-devenv-pass` has the `admin` role with `manage`; `osmember.test` / `member-devenv-pass` does not), the existing `createSession`/`mintCredential` helpers in the test file, PoC route `GET /api/poc/communities/:did/spaces` for the management space URI.
- Produces: live proof that (a) `checkUserAccess` authorizes admins — and denies non-admins — for the management space, and (b) seeded governance operations produced `auditLogEntry` records readable with a space credential.

- [ ] **Step 1: Refresh the devnet state**

The stack should still be running (dev-env :2581/:2582/:2583, devnet Postgres :5433, app :3001 — check with `curl -s http://localhost:2581/ | head -c 100`, `curl -s http://localhost:3001/health`; restart per the boot steps in `docs/superpowers/plans/2026-07-03-permissioned-spaces-backend.md` Task 10 if not). Then, because Tasks 1-3 changed lexicons and seeding-time behavior, re-publish and re-seed:

```bash
npm run db:reset && npm run migrate:devenv && npm run publish:lexicons && npm run seed:devenv
```

Restart the app (`npm run dev:devnet`, background) so it runs the new code. Seeding calls `writeRoleDefinition` ×2, `assignRole` ×2, and `recordMembership` ×2 — so the management space should now contain auditLogEntry records.

- [ ] **Step 2: Add the failing tests**

In `test/devnet-spaces.test.ts`, extend `beforeAll` to also capture the management space URI (`spaces.find((s) => s.kind === "management")` — throw loudly if absent, same pattern as the posts lookup). Add a new describe:

```ts
describe("devnet: management-space audit entries", () => {
  it("an admin mints a management-space credential and reads auditLogEntry records", async () => {
    const session = await createSession(ADMIN.handle, ADMIN.password);
    const result = await mintCredential(session, managementSpace);
    expect(result.ok).toBe(true);
    const url = new URL(`${PDS}/xrpc/com.atproto.space.listRecords`);
    url.searchParams.set("space", managementSpace);
    url.searchParams.set("repo", communityDid);
    url.searchParams.set("collection", "community.opensocial.auditLogEntry");
    const res = await fetch(url, {
      headers: { authorization: `Bearer ${result.credential}` },
    });
    expect(res.ok).toBe(true);
    const body = await res.json();
    expect(Array.isArray(body.records)).toBe(true);
    expect(body.records.length).toBeGreaterThan(0);
  });

  it("a non-admin member is denied a management-space credential", async () => {
    const session = await createSession(MEMBER.handle, MEMBER.password);
    const result = await mintCredential(session, managementSpace);
    expect(result.ok).toBe(false);
    expect(result.status).toBe(400);
    expect(result.body).toMatch(/UserNotAuthorized/);
  });
});
```

Add `const ADMIN = { handle: "osadmin.test", password: "admin-devenv-pass" };` next to the existing account constants (keep-in-sync comment applies). `communityDid` is already resolved in `beforeAll`. Adapt the `listRecords` response-shape assertion if the live response differs (record the actual shape in your report); if record values are inlined, additionally assert one record's `value.action` is a known audit action string.

- [ ] **Step 3: Run to verify the new tests exercise reality**

Run: `npm run test:devnet`
Expected: all devnet-spaces tests PASS (including the two new ones) with devnet-smoke skipped. If the admin mint fails, triage per the Task 10 list in the Phase 1 plan (app logs show the checkUserAccess call; verify the admin actually has the `manage` capability after seeding).

- [ ] **Step 4: Full verification sweep**

Run: `npx vitest run && npx tsc --noEmit && npm run test:devnet`
Expected: green (modulo the known pre-existing :5432 Postgres failure).

- [ ] **Step 5: Commit**

```bash
git add test/devnet-spaces.test.ts
git commit -m "test: live audit-entry reads from the management space via admin credential"
```

---

## Verification (definition of done)

1. `npx vitest run` + `npx tsc --noEmit` clean (modulo known pre-existing failure).
2. `npm run test:devnet` green: admin reads live `auditLogEntry` records with a management-space credential; non-admin member is denied that credential with `400 UserNotAuthorized`.
3. Every existing audit call site (legacy XRPC + routes) now dual-writes with zero call-site changes — verified by the choke-point design (only `auditLog.ts` changed).
