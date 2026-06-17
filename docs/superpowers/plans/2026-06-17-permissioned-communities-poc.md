# Permissioned-Spaces Communities PoC — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Evolve the OpenSocial permissioned-spaces PoC so the community roster is sourced from on-protocol membership _records_ (not the protocol member list), members author posts into their _own_ repos, and the community feed is the aggregate across member repos — all on the dev-env.

**Architecture:** Two spaces per community — an admin-only `management` space holding governance + roster records (the source of truth + migration artifact), and a `posts` modality space whose member list is a throwaway dev-env shim. OpenSocial is the access authority. Posts are written per-member-repo and aggregated on read. A dev-only `/api/poc/*` router + act-as switcher drives it without real OAuth.

**Tech Stack:** TypeScript, Express, Kysely (Postgres), `@atproto/api` `BskyAgent`, raw XRPC to `com.atproto.space.*` (atproto `permissioned-data` dev-env, PDS @ `http://localhost:2583`), Vitest. Frontend: Vite + React + Chakra UI v3.

**Spec:** `docs/2026-06-17-permissioned-communities-poc-design.md`

**Deviation from spec (intentional):** the spec says "rename `membershipProof` → `membership`." The proof functions are used by the production `src/routes/members.ts`, so instead we **add** new roster-record functions (`recordMembership`/`listMemberships`/`isMember`) alongside the untouched proof API, and point only the PoC seed + `/poc` endpoints at them. Roles stay in `roleAssignment` records (single source for "what role"); the new `membership` record carries `status`/`joinedAt`/`approvedBy` only.

**Conventions to follow:**

- Node 22 required for `tsx`/`pnpm` (project memory). Backend dev runs via `npm run dev:devenv`; DB/migrate via `npm run migrate:devenv`; seed via `npm run seed:devenv` (each sources `.env.devnet`).
- Open the web app at `http://127.0.0.1:5174/poc` (not `localhost`).
- Migrations live in `migrations/NNN_*.ts` (Kysely `FileMigrationProvider`, `up`/`down` exports).
- Tests are `*.test.ts` beside the source; run with `npm test` (`vitest run`) or `npx vitest run <path>`.

---

## File structure

**Backend (`open-social`):**

- `migrations/016_poc_member_accounts.ts` — _create_ — dev table holding member app-passwords for act-as writes.
- `src/db.ts` — _modify_ — add `PocMemberAccount` interface + map entry; fix `CommunitySpace.kind` comment.
- `src/services/atproto.ts` — _modify_ — add `getMemberAgent(db, did)`.
- `src/services/spaces.ts` — _modify_ — drop `content` from provisioning (`management` + `posts` only); add `getMemberSpaceClient(db, memberDid)`.
- `src/services/membership.ts` — _modify_ — add roster-record functions (`recordMembership`, `listMemberships`, `isMember`) + pure `applyMembershipVisibility` helper. Leave proof functions untouched.
- `src/services/posts.ts` — _modify_ — add pure `aggregateAndSortPosts`, `createMemberPost` (own-repo), and fan-out `listCommunityPosts`.
- `src/routes/poc.ts` — _modify_ — reframe endpoints to mirror the contract (`isCommunityMember`, members-from-records, member-authored posting + `asCommunity` flag, `joinCommunity`, `listCommunitySpaces`).
- `scripts/seed-devenv-community.ts` — _modify_ — provision 2 spaces, persist member app-passwords, use `recordMembership`, seed member-authored posts.

**Frontend (`open-social-web`):**

- `src/pages/PocPage.tsx` — _modify_ — compose-as-member by default + "post as community" affordance (gated on `post`); feed already shows attribution.

---

## Task 1: Branch setup

**Files:** none (git only)

- [ ] **Step 1: Cut the branch in both repos from `poc/permissioned-spaces`**

```bash
cd /Users/brittany/Documents/Collective/open-social
git checkout poc/permissioned-spaces && git pull --ff-only 2>/dev/null; git checkout -b poc/communities-records-model

cd /Users/brittany/Documents/Collective/open-social-web
git checkout poc/permissioned-spaces && git pull --ff-only 2>/dev/null; git checkout -b poc/communities-records-model
```

- [ ] **Step 2: Confirm both repos are on the new branch**

Run: `git -C /Users/brittany/Documents/Collective/open-social branch --show-current && git -C /Users/brittany/Documents/Collective/open-social-web branch --show-current`
Expected: `poc/communities-records-model` printed twice.

---

## Task 2: Cross-repo read spike (decides the shape of the feed read)

The fan-out feed read (Task 7) reads each member's repo in the community's posts space. We must confirm whether the **community (owner) agent** can read another member's repo via `com.atproto.space.listRecords`/`getRecord` on today's dev-env, or whether a minted space credential is required.

**Files:** `scripts/spike-cross-repo-read.ts` (create, temporary — deleted in Step 4)

- [ ] **Step 1: Ensure the dev-env + current seed are running**

```bash
# In the atproto repo: make run-dev-env   (PDS @ http://localhost:2583)
# os-pg postgres up on 5434
cd /Users/brittany/Documents/Collective/open-social
npm run migrate:devenv up
npm run seed:devenv   # prints community + admin + member DIDs
```

Copy the printed `community` and `member` DIDs for the next step.

- [ ] **Step 2: Write the spike script**

```typescript
#!/usr/bin/env tsx
// TEMPORARY spike — deleted after recording the outcome in the plan.
import { createDb } from "../src/db";
import { config } from "../src/config";
import { getCommunitySpace, getSpaceClient } from "../src/services/spaces";

const [communityDid, memberDid] = process.argv.slice(2);

async function main() {
  const db = createDb(config.databaseUrl);
  const posts = await getCommunitySpace(db, communityDid, "posts");
  console.log("posts space:", posts);
  const client = await getSpaceClient(db, communityDid); // authed as OWNER
  // Write a record into the MEMBER's repo is not what we test here; we test
  // whether the OWNER can READ a member repo. First seed one member post via
  // the member agent (Task 4 helper not yet built), so for the spike just try
  // to list the member's repo in the posts space as the owner:
  try {
    const recs = await client.listRecords(
      posts!,
      "community.opensocial.post",
      {},
      memberDid,
    );
    console.log("OWNER read member repo OK:", JSON.stringify(recs));
  } catch (err: any) {
    console.log("OWNER read member repo FAILED:", err?.status, err?.message);
  }
  await db.destroy();
}
main();
```

- [ ] **Step 3: Run it and record the result**

Run: `bash -c 'set -a && source .env.devnet && exec tsx scripts/spike-cross-repo-read.ts <COMMUNITY_DID> <MEMBER_DID>'`
Expected: either `OWNER read member repo OK: …` or `… FAILED: <status>`.

**Decision rule (write the answer into Task 7 Step 3 before implementing it):**

- **OK** → `listCommunityPosts` reads member repos with the owner `SpaceClient` (the plan's default in Task 7).
- **FAILED** → in Task 7, mint a space credential for the posts space first (owner calls `getMemberGrant` + `getSpaceCredential` for itself) and pass it on reads. Add a `SpaceClient.withCredential(jwt)` path that sends `authorization: Bearer <space-credential>` instead of the session token.

- [ ] **Step 4: Delete the spike script and commit nothing**

```bash
rm scripts/spike-cross-repo-read.ts
```

(No commit — this task only records a decision in the plan text.)

---

## Task 3: PoC member-accounts table

So the dev-only `/poc` endpoints can write "as a member" without real OAuth, persist each member account's app-password (encrypted) keyed by DID.

**Files:**

- Create: `migrations/016_poc_member_accounts.ts`
- Modify: `src/db.ts` (add interface + map entry near `CommunitySpace`)

- [ ] **Step 1: Write the migration**

```typescript
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
```

- [ ] **Step 2: Add the DB types**

In `src/db.ts`, add this interface next to `CommunitySpace` (around line 233) and update its `kind` comment:

```typescript
// Update the existing CommunitySpace.kind comment to drop "content":
//   /** 'management' | 'posts' */

export interface PocMemberAccount {
  did: string;
  handle: string;
  pds_host: string;
  app_password: string;
  created_at: Generated<Date>;
}
```

Then add to the `Database` map (after `community_spaces:`):

```typescript
poc_member_accounts: PocMemberAccount;
```

- [ ] **Step 3: Run the migration**

Run: `npm run migrate:devenv up`
Expected: log line `Migration "016_poc_member_accounts" was executed successfully`.

- [ ] **Step 4: Typecheck + commit**

Run: `npx tsc --noEmit`
Expected: no errors.

```bash
git add migrations/016_poc_member_accounts.ts src/db.ts
git commit -m "feat(poc): add poc_member_accounts table for act-as writes"
```

---

## Task 4: Member agent + member space client

**Files:**

- Modify: `src/services/atproto.ts` (add `getMemberAgent`)
- Modify: `src/services/spaces.ts` (add `getMemberSpaceClient`; import `getMemberAgent`)

- [ ] **Step 1: Add `getMemberAgent` to `src/services/atproto.ts`**

Add after `createCommunityAgent` (it reuses `resolveAuthServer`, `decryptIfNeeded`, `BskyAgent` already in this file):

```typescript
/**
 * Build an agent for a PoC *member* account (dev-only). Mirrors
 * createCommunityAgent but reads credentials from `poc_member_accounts`.
 * Used so the /poc act-as switcher can write into a member's own repo.
 */
export async function getMemberAgent(
  db: Kysely<Database>,
  did: string,
): Promise<BskyAgent> {
  const acct = await db
    .selectFrom("poc_member_accounts")
    .select(["handle", "pds_host", "app_password"])
    .where("did", "=", did)
    .executeTakeFirst();
  if (!acct) throw new Error(`No PoC member account for ${did}`);

  const authServerUrl = await resolveAuthServer(did, acct.pds_host);
  const agent = new BskyAgent({ service: authServerUrl });
  await agent.login({
    identifier: did,
    password: decryptIfNeeded(acct.app_password),
  });
  return agent;
}
```

- [ ] **Step 2: Add `getMemberSpaceClient` to `src/services/spaces.ts`**

Update the import line `import { createCommunityAgent, resolvePdsEndpoint } from "./atproto";` to also import `getMemberAgent`, then add near `getSpaceClient`:

```typescript
/**
 * Build a SpaceClient authenticated as a *member* (not the community), so the
 * member can write records into their OWN repo within a community space.
 */
export async function getMemberSpaceClient(
  db: Kysely<Database>,
  memberDid: string,
): Promise<SpaceClient> {
  const agent = await getMemberAgent(db, memberDid);
  const acct = await db
    .selectFrom("poc_member_accounts")
    .select("pds_host")
    .where("did", "=", memberDid)
    .executeTakeFirst();
  const pdsUrl = await resolvePdsEndpoint(memberDid, acct?.pds_host);
  return new SpaceClient(agent, pdsUrl);
}
```

- [ ] **Step 3: Typecheck + commit**

Run: `npx tsc --noEmit`
Expected: no errors.

```bash
git add src/services/atproto.ts src/services/spaces.ts
git commit -m "feat(poc): add member agent + member space client for own-repo writes"
```

---

## Task 5: Roster from membership records (+ visibility helper)

Add the new roster-record source of truth. Roles continue to live in `roleAssignment` records (`services/roles.ts`).

**Files:**

- Modify: `src/services/membership.ts`
- Test: `src/services/membership.test.ts` (create)

- [ ] **Step 1: Write the failing test for the pure visibility helper**

Create `src/services/membership.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { applyMembershipVisibility, type Roster } from "./membership";

const roster: Roster = [
  { subject: "did:plc:a", status: "active", joinedAt: "2026-01-01T00:00:00Z" },
  { subject: "did:plc:b", status: "active", joinedAt: "2026-01-02T00:00:00Z" },
];

describe("applyMembershipVisibility", () => {
  it("public: returns the full roster to anyone", () => {
    expect(
      applyMembershipVisibility(
        roster,
        { isMember: false, isAdmin: false },
        "public",
      ),
    ).toHaveLength(2);
  });
  it("internal: full roster to members, empty to non-members", () => {
    expect(
      applyMembershipVisibility(
        roster,
        { isMember: true, isAdmin: false },
        "internal",
      ),
    ).toHaveLength(2);
    expect(
      applyMembershipVisibility(
        roster,
        { isMember: false, isAdmin: false },
        "internal",
      ),
    ).toHaveLength(0);
  });
  it("admin-only: full roster to admins, empty otherwise", () => {
    expect(
      applyMembershipVisibility(
        roster,
        { isMember: true, isAdmin: true },
        "admin-only",
      ),
    ).toHaveLength(2);
    expect(
      applyMembershipVisibility(
        roster,
        { isMember: true, isAdmin: false },
        "admin-only",
      ),
    ).toHaveLength(0);
  });
  it("none: always empty", () => {
    expect(
      applyMembershipVisibility(
        roster,
        { isMember: true, isAdmin: true },
        "none",
      ),
    ).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run src/services/membership.test.ts`
Expected: FAIL — `applyMembershipVisibility` / `Roster` not exported.

- [ ] **Step 3: Implement the roster functions + helper**

Add to `src/services/membership.ts` (keep all existing proof functions). Add imports at top: `import { actorCan } from "./roles";` and ensure `getSpaceClient` is imported (it already is).

```typescript
const MEMBERSHIP = "community.opensocial.membership";

export type MemberVisibility = "public" | "internal" | "admin-only" | "none";

export interface MembershipRecord {
  subject: string;
  status: "active" | "pending";
  joinedAt: string;
}
export type Roster = MembershipRecord[];

/** Pure visibility gate for the roster (the getCommunityMembers contract). */
export function applyMembershipVisibility(
  roster: Roster,
  viewer: { isMember: boolean; isAdmin: boolean },
  visibility: MemberVisibility,
): Roster {
  switch (visibility) {
    case "public":
      return roster;
    case "internal":
      return viewer.isMember ? roster : [];
    case "admin-only":
      return viewer.isAdmin ? roster : [];
    case "none":
      return [];
  }
}

async function managementSpaceUri(
  db: Kysely<Database>,
  communityDid: string,
): Promise<string> {
  const space = await getCommunitySpace(db, communityDid, "management");
  if (!space)
    throw new Error(`Community ${communityDid} has no management space.`);
  return space;
}

/** The roster: membership records from the management space (source of truth). */
export async function listMemberships(
  db: Kysely<Database>,
  communityDid: string,
): Promise<Roster> {
  const space = await managementSpaceUri(db, communityDid);
  const client = await getSpaceClient(db, communityDid);
  const recs = await client.listRecordValues<MembershipRecord>(
    space,
    MEMBERSHIP,
  );
  return recs.map((r) => ({
    subject: r.value.subject,
    status: r.value.status ?? "active",
    joinedAt: r.value.joinedAt,
  }));
}

/** Whether `did` is an active member (per the records, not the protocol list). */
export async function isMember(
  db: Kysely<Database>,
  communityDid: string,
  did: string,
): Promise<boolean> {
  const roster = await listMemberships(db, communityDid);
  return roster.some((m) => m.subject === did && m.status === "active");
}

/**
 * Record a membership (source of truth) and derive space access (dev-env shim):
 * every member is added to the posts space; admins (with the "manage"
 * capability) are additionally added to the admin-only management space.
 * Idempotent on subject. Call AFTER assigning roles so the admin check works.
 */
export async function recordMembership(
  db: Kysely<Database>,
  communityDid: string,
  subjectDid: string,
  opts: { approvedBy?: string } = {},
): Promise<void> {
  const mgmt = await managementSpaceUri(db, communityDid);
  const posts = await getCommunitySpace(db, communityDid, "posts");
  const client = await getSpaceClient(db, communityDid);

  const roster = await listMemberships(db, communityDid);
  if (!roster.some((m) => m.subject === subjectDid)) {
    await client.createRecord(mgmt, MEMBERSHIP, {
      $type: MEMBERSHIP,
      subject: subjectDid,
      status: "active",
      joinedAt: new Date().toISOString(),
      ...(opts.approvedBy ? { approvedBy: opts.approvedBy } : {}),
    });
  }

  // SHIM (delete when the protocol mint-callout lands): pre-materialize the
  // access decision into the space member lists the dev-env mints from.
  if (posts) await client.addMember(posts, subjectDid).catch(() => {});
  const isAdmin = await actorCan(db, communityDid, subjectDid, "manage");
  if (isAdmin) await client.addMember(mgmt, subjectDid).catch(() => {});
}
```

- [ ] **Step 4: Run the test to confirm it passes**

Run: `npx vitest run src/services/membership.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Typecheck + commit**

Run: `npx tsc --noEmit`
Expected: no errors.

```bash
git add src/services/membership.ts src/services/membership.test.ts
git commit -m "feat(poc): membership records as roster source of truth + visibility gate"
```

---

## Task 6: Provision only management + posts

**Files:** Modify `src/services/spaces.ts`

- [ ] **Step 1: Drop the `content` space**

In `src/services/spaces.ts`:

- Remove the `CONTENT_SPACE_TYPE` export.
- Change `SpaceKind` to `export type SpaceKind = "management" | "posts";`
- Remove the `content:` entry from `SPACE_TYPE_BY_KIND`.

Resulting map:

```typescript
const SPACE_TYPE_BY_KIND: Record<SpaceKind, string> = {
  management: MANAGEMENT_SPACE_TYPE,
  posts: POSTS_SPACE_TYPE,
};
```

`provisionCommunitySpaces` iterates `SPACE_TYPE_BY_KIND`, so it now provisions exactly these two — no other change needed there.

- [ ] **Step 2: Confirm no remaining references to `content`/`CONTENT_SPACE_TYPE`**

Run: `grep -rn "CONTENT_SPACE_TYPE\|\"content\"\|'content'" src/services src/routes scripts | grep -v node_modules`
Expected: no matches (or only unrelated ones). Fix any leftover `content` kind usage.

- [ ] **Step 3: Typecheck + commit**

Run: `npx tsc --noEmit`
Expected: no errors.

```bash
git add src/services/spaces.ts
git commit -m "feat(poc): provision management + posts spaces only (drop content)"
```

---

## Task 7: Member-authored posts + aggregate feed

**Files:**

- Modify: `src/services/posts.ts`
- Test: `src/services/posts.test.ts` (create)

- [ ] **Step 1: Write the failing test for the pure aggregator**

Create `src/services/posts.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { aggregateAndSortPosts, type CommunityPost } from "./posts";

const p = (rkey: string, author: string, createdAt: string): CommunityPost => ({
  rkey,
  author,
  text: rkey,
  createdAt,
});

describe("aggregateAndSortPosts", () => {
  it("flattens per-author lists and sorts newest first", () => {
    const out = aggregateAndSortPosts([
      [p("a", "did:plc:1", "2026-01-02T00:00:00Z")],
      [
        p("b", "did:plc:2", "2026-01-01T00:00:00Z"),
        p("c", "did:plc:2", "2026-01-03T00:00:00Z"),
      ],
    ]);
    expect(out.map((x) => x.rkey)).toEqual(["c", "a", "b"]);
  });

  it("handles empty input", () => {
    expect(aggregateAndSortPosts([])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run src/services/posts.test.ts`
Expected: FAIL — `aggregateAndSortPosts` not exported.

- [ ] **Step 3: Implement aggregator, member posting, and fan-out read**

In `src/services/posts.ts`: add imports `import { getSpaceClient, getMemberSpaceClient, getCommunitySpace } from "./spaces";` (replace the existing spaces import) and `import { isMember, listMemberships } from "./membership";` (keep `actorCan` import).

Add the pure helper:

```typescript
/** Flatten per-author post lists and sort newest-first. Pure (unit-tested). */
export function aggregateAndSortPosts(
  perAuthor: CommunityPost[][],
): CommunityPost[] {
  return perAuthor.flat().sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}
```

Add member-authored posting (write into the member's OWN repo):

```typescript
/**
 * Post as a member, into the member's own repo within the community posts
 * space. Any active member may do this — no special capability required.
 */
export async function createMemberPost(
  db: Kysely<Database>,
  communityDid: string,
  authorDid: string,
  text: string,
): Promise<{ uri: string; cid: string }> {
  if (!(await isMember(db, communityDid, authorDid))) {
    throw new NotAllowedError("Only community members can post.");
  }
  const space = await postsSpace(db, communityDid);
  const client = await getMemberSpaceClient(db, authorDid); // authed AS the member
  // repo defaults to the member agent's own DID -> the member's repo.
  return client.createRecord(space, POST, {
    $type: POST,
    text,
    author: authorDid,
    createdAt: new Date().toISOString(),
  });
}
```

Replace `listCommunityPosts` with the fan-out version. **Per the Task 2 spike decision**, the default below reads member repos with the owner client; if the spike said FAILED, mint a credential first (see Task 2 Step 3):

```typescript
/**
 * The community feed: aggregate posts across every member's repo in the posts
 * space, plus the community's own repo (for "post as community"). Enumerates
 * authors from the membership records (stands in for the future "list writers"
 * primitive).
 */
export async function listCommunityPosts(
  db: Kysely<Database>,
  communityDid: string,
): Promise<CommunityPost[]> {
  const space = await postsSpace(db, communityDid);
  const client = await getSpaceClient(db, communityDid); // owner reads
  const roster = await listMemberships(db, communityDid);
  const authors = [communityDid, ...roster.map((m) => m.subject)];

  const perAuthor = await Promise.all(
    authors.map(async (repo) => {
      try {
        const recs = await client.listRecordValues<{
          text: string;
          author?: string;
          createdAt: string;
        }>(space, POST, repo);
        return recs.map((r) => ({
          rkey: r.rkey,
          author: r.value.author ?? repo,
          text: r.value.text,
          createdAt: r.value.createdAt,
        }));
      } catch {
        return [] as CommunityPost[];
      }
    }),
  );
  return aggregateAndSortPosts(perAuthor);
}
```

Keep the existing `createCommunityPost` (repo = community, gated by `actorCan('post')`) unchanged — it is the distinct "post as community" action.

- [ ] **Step 4: Run the test to confirm it passes**

Run: `npx vitest run src/services/posts.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Typecheck + commit**

Run: `npx tsc --noEmit`
Expected: no errors.

```bash
git add src/services/posts.ts src/services/posts.test.ts
git commit -m "feat(poc): member-authored posts + aggregate feed across member repos"
```

---

## Task 8: Reframe the /poc endpoints around the contract

**Files:** Modify `src/routes/poc.ts`

- [ ] **Step 1: Update imports + members endpoint to read records**

Replace the `roles`/`posts`/`spaces` imports and `/members` handler. New imports block:

```typescript
import { getCommunitySpace, getSpaceClient } from "../services/spaces";
import { listRoleAssignments, listRoleDefinitions } from "../services/roles";
import {
  listMemberships,
  isMember,
  recordMembership,
  applyMembershipVisibility,
} from "../services/membership";
import {
  createCommunityPost,
  createMemberPost,
  listCommunityPosts,
  NotAllowedError,
} from "../services/posts";
```

Replace the `/:did/members` handler so the roster comes from membership records (not `getMembers`), with roles overlaid and a visibility gate (default `internal`; the act-as viewer is treated as a member):

```typescript
// Roster from membership records (source of truth) + roles overlaid.
router.get("/:did/members", async (req, res) => {
  const communityDid = decodeURIComponent(req.params.did);
  try {
    const mgmt = await getCommunitySpace(db, communityDid, "management");
    if (!mgmt) return res.json({ members: [], provisioned: false });

    const [roster, assignments] = await Promise.all([
      listMemberships(db, communityDid),
      listRoleAssignments(db, communityDid),
    ]);
    const rolesByDid = new Map<string, string[]>();
    for (const a of assignments) {
      const list = rolesByDid.get(a.subject) ?? [];
      list.push(a.role);
      rolesByDid.set(a.subject, list);
    }
    // Act-as viewer is always a member; default visibility = internal.
    const visible = applyMembershipVisibility(
      roster,
      { isMember: true, isAdmin: true },
      "internal",
    );
    res.json({
      provisioned: true,
      members: visible.map((m) => ({
        did: m.subject,
        roles: rolesByDid.get(m.subject) ?? [],
      })),
    });
  } catch (err) {
    logger.error({ err, communityDid }, "poc/members failed");
    res.status(500).json({ error: "Failed to load members" });
  }
});
```

- [ ] **Step 2: Add `isCommunityMember`, `joinCommunity`, and `spaces` endpoints**

Add these handlers inside `createPocRouter` (before `return router;`):

```typescript
// Contract: isCommunityMember (authenticated-user-scoped via ?actorDid).
router.get("/:did/isMember", async (req, res) => {
  const communityDid = decodeURIComponent(req.params.did);
  const actorDid = String(req.query.actorDid ?? "");
  if (!actorDid) return res.status(400).json({ error: "actorDid required" });
  try {
    const member = await isMember(db, communityDid, actorDid);
    const assignments = await listRoleAssignments(db, communityDid);
    const role = assignments.find((a) => a.subject === actorDid)?.role;
    res.json({ isMember: member, ...(role ? { role } : {}) });
  } catch (err) {
    logger.error({ err, communityDid }, "poc/isMember failed");
    res.status(500).json({ error: "Failed" });
  }
});

// Contract: joinCommunity (open join for the PoC).
router.post("/:did/join", async (req, res) => {
  const communityDid = decodeURIComponent(req.params.did);
  const { actorDid } = req.body ?? {};
  if (!actorDid) return res.status(400).json({ error: "actorDid required" });
  try {
    await recordMembership(db, communityDid, actorDid);
    res.status(201).json({ status: "active" });
  } catch (err) {
    logger.error({ err, communityDid }, "poc/join failed");
    res.status(500).json({ error: "Failed to join" });
  }
});

// Contract: listCommunitySpaces.
router.get("/:did/spaces", async (req, res) => {
  const communityDid = decodeURIComponent(req.params.did);
  const rows = await db
    .selectFrom("community_spaces")
    .select(["kind", "space_uri"])
    .where("community_did", "=", communityDid)
    .execute();
  res.json({ spaces: rows });
});
```

- [ ] **Step 3: Update POST /:did/posts to default to member-authored**

Replace the `POST /:did/posts` handler:

```typescript
// Post as the acting member by default; asCommunity=true posts on behalf of
// the community (role-gated by the "post" capability).
router.post("/:did/posts", async (req, res) => {
  const communityDid = decodeURIComponent(req.params.did);
  const { actorDid, text, asCommunity } = req.body ?? {};
  if (!actorDid || typeof text !== "string" || text.trim().length === 0) {
    return res.status(400).json({ error: "actorDid and text are required" });
  }
  try {
    const result = asCommunity
      ? await createCommunityPost(db, communityDid, actorDid, text.trim())
      : await createMemberPost(db, communityDid, actorDid, text.trim());
    res.status(201).json(result);
  } catch (err) {
    if (err instanceof NotAllowedError) {
      return res.status(403).json({ error: err.message });
    }
    logger.error({ err, communityDid }, "poc/posts create failed");
    res.status(500).json({ error: "Failed to create post" });
  }
});
```

The `GET /:did/roles` and `GET /:did/posts` handlers are unchanged.

- [ ] **Step 4: Typecheck + commit**

Run: `npx tsc --noEmit`
Expected: no errors.

```bash
git add src/routes/poc.ts
git commit -m "feat(poc): contract-shaped endpoints (isMember, join, spaces, member-authored posts)"
```

---

## Task 9: Update the seed

**Files:** Modify `scripts/seed-devenv-community.ts`

- [ ] **Step 1: Persist member app-passwords**

Add `import { createMemberPost } from "../src/services/posts";` and `import { recordMembership } from "../src/services/membership";` (replace the `writeMembershipProof` import). After the accounts are created and the community row is upserted, mint + store an app-password for admin and member. Add this helper above `main` (reuses the `encrypt` import already present):

```typescript
async function persistMemberAccount(
  db: ReturnType<typeof createDb>,
  pdsUrl: string,
  acct: CreatedAccount,
): Promise<void> {
  const agent = new BskyAgent({ service: pdsUrl });
  await agent.login({ identifier: acct.did, password: acct.password });
  const appPassword = (
    await agent.com.atproto.server.createAppPassword({
      name: `poc-${Date.now()}`,
    })
  ).data.password;
  await db
    .insertInto("poc_member_accounts")
    .values({
      did: acct.did,
      handle: acct.handle,
      pds_host: pdsUrl,
      app_password: encrypt(appPassword),
    })
    .onConflict((oc) =>
      oc.column("did").doUpdateSet({
        handle: acct.handle,
        pds_host: pdsUrl,
        app_password: encrypt(appPassword),
      }),
    )
    .execute();
}
```

Call it inside the `try` block right after the community row upsert:

```typescript
await persistMemberAccount(db, pdsUrl, admin);
await persistMemberAccount(db, pdsUrl, member);
```

- [ ] **Step 2: Use recordMembership + seed member-authored posts**

Replace the two `writeMembershipProof(...)` calls with `recordMembership` (after the `assignRole` calls so the admin check works), then seed one post per member into their own repo:

```typescript
// Roster records (source of truth) + derived space access.
await recordMembership(db, community.did, admin.did, {
  approvedBy: community.did,
});
await recordMembership(db, community.did, member.did, {
  approvedBy: community.did,
});

// Seed member-authored posts so the aggregate feed is visible immediately.
console.log("Seeding member-authored posts...");
await createMemberPost(
  db,
  community.did,
  admin.did,
  "Hello from the admin — posting as myself.",
);
await createMemberPost(
  db,
  community.did,
  member.did,
  "And hello from a regular member!",
);
```

Update the spaces log block to print only `management` + `posts` (drop the `content` line if present).

- [ ] **Step 3: Re-run migrate + seed against the dev-env**

Run:

```bash
npm run migrate:devenv up
npm run seed:devenv
```

Expected: completes with the "✅ Seeded" banner; no errors. Note the printed community/admin/member DIDs.

- [ ] **Step 4: Commit**

```bash
git add scripts/seed-devenv-community.ts
git commit -m "feat(poc): seed roster records, member creds, and member-authored posts"
```

---

## Task 10: Frontend — compose as member, with "post as community"

**Files:** Modify `open-social-web/src/pages/PocPage.tsx`

- [ ] **Step 1: Add an `asCommunity` toggle to the composer**

In `PocPage.tsx`, add state near the other `useState`s:

```tsx
const [asCommunity, setAsCommunity] = useState(false);
```

`actorRoles` already exists. Replace the composer's helper `Text` + add a toggle. The "post as community" option should only be enabled when the actor has the `post` capability (admins). Use the existing `actorRoles.includes('admin')` signal:

```tsx
<Box borderWidth="1px" borderRadius="md" p={4}>
  <Heading size="sm" mb={2}>
    {asCommunity ? "Post on behalf of the community" : "Post as yourself"}
  </Heading>
  <HStack mb={2} gap={3}>
    <Button
      size="xs"
      variant={asCommunity ? "outline" : "solid"}
      onClick={() => setAsCommunity(false)}
    >
      As {short(actor ?? "")}
    </Button>
    <Button
      size="xs"
      variant={asCommunity ? "solid" : "outline"}
      disabled={!actorRoles.includes("admin")}
      onClick={() => setAsCommunity(true)}
    >
      As community {actorRoles.includes("admin") ? "" : "(needs post role)"}
    </Button>
  </HStack>
  <Textarea
    value={text}
    onChange={(e) => setText(e.target.value)}
    placeholder={
      asCommunity
        ? "Posting on behalf of the community…"
        : "Posting as yourself…"
    }
    mb={2}
  />
  <HStack>
    <Button onClick={submit} loading={posting} disabled={!text.trim()}>
      Post
    </Button>
    {notice && (
      <Text fontSize="sm" color="green.fg">
        {notice}
      </Text>
    )}
  </HStack>
</Box>
```

- [ ] **Step 2: Send the `asCommunity` flag and reset it after switching actor**

In `submit`, include the flag in the POST body:

```tsx
          body: JSON.stringify({ actorDid: actor, text, asCommunity }),
```

In the act-as switcher's `onClick`, also reset the toggle: add `setAsCommunity(false);` alongside the existing `setActor`/`setError`/`setNotice` calls.

- [ ] **Step 3: Label the feed heading to reflect the aggregate**

Change the posts heading from `Posts space ({posts.length})` to make the aggregate explicit:

```tsx
<Heading size="sm" mb={2}>
  Community feed — aggregated across member repos ({posts.length})
</Heading>
```

- [ ] **Step 4: Build the web app to verify it compiles**

Run: `cd /Users/brittany/Documents/Collective/open-social-web && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
cd /Users/brittany/Documents/Collective/open-social-web
git add src/pages/PocPage.tsx
git commit -m "feat(poc): compose as member by default, with post-as-community toggle"
```

---

## Task 11: End-to-end demo verification

**Files:** none

- [ ] **Step 1: Bring everything up**

```bash
# atproto repo:  make run-dev-env   (PDS @ :2583)
# os-pg on :5434
cd /Users/brittany/Documents/Collective/open-social
npm run migrate:devenv up && npm run seed:devenv
npm run dev:devenv      # backend
# separate shell:
cd /Users/brittany/Documents/Collective/open-social-web && npm run dev
```

- [ ] **Step 2: Verify the aggregate feed (the headline)**

Open `http://127.0.0.1:5174/poc`. Expected: the feed shows **two** seeded posts — one attributed to the admin DID, one to the member DID — proving per-member-repo authorship aggregated on read.

- [ ] **Step 3: Verify member posting**

Act as the member (`osmember`), compose "test from member", Post. Expected: 201; the post appears attributed to the member.

- [ ] **Step 4: Verify the as-community gate**

Still as the member, the "As community" button is **disabled**. Switch to admin (`osadmin`); "As community" is enabled; posting that way succeeds (writes the community repo) and appears in the feed.

- [ ] **Step 5: Verify the roster source + space assignment**

```bash
COMMUNITY=<community_did>
curl -s "http://localhost:3001/api/poc/communities/$COMMUNITY/members" | jq
curl -s "http://localhost:3001/api/poc/communities/$COMMUNITY/spaces" | jq
curl -s "http://localhost:3001/api/poc/communities/$COMMUNITY/isMember?actorDid=<member_did>" | jq
```

Expected: `/members` lists admin + member from the membership records with roles overlaid; `/spaces` lists `management` + `posts`; `/isMember` returns `{isMember:true, role:"member"}`.

- [ ] **Step 6: Confirm management space is admin-only**

The member must NOT be on the management space member list (only the posts space). Verify with the seed DIDs:

```bash
# As the community owner, the management space member list should contain the
# community + admin, but NOT the plain member.
```

Inspect via a quick `tsx` one-liner using `getSpaceClient(...).getMembers(managementUri)` if needed. Expected: member absent from management; present on posts.

---

## Self-review notes (completed during planning)

- **Spec coverage:** deltas #1–#9 map to Tasks 6, 5, 5, 7, 7, 8, 3/9, 10, 9 respectively; open questions #1/#2 → Tasks 2 and 3. Dev-env shims (addMember, author enumeration, act-as creds) are implemented in Tasks 5/7/9 with in-code "delete when…" comments.
- **Deviation:** `membershipProof` is kept (production `routes/members.ts` depends on it); new `membership` records added alongside. Stated at top.
- **Type consistency:** `CommunityPost`, `Roster`/`MembershipRecord`, `aggregateAndSortPosts`, `applyMembershipVisibility`, `recordMembership`, `listMemberships`, `isMember`, `createMemberPost`, `getMemberAgent`, `getMemberSpaceClient` are defined once and referenced consistently across tasks.
- **Known risk:** Task 7's fan-out read depends on the Task 2 spike outcome — the plan branches explicitly there.
