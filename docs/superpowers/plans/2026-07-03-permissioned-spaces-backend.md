# Phase 1: Permissioned Spaces Backend (managing-app) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move OpenSocial's group + management spaces onto the current atproto `permissioned-data` branch APIs, with `policy=managing-app`: OpenSocial gets a `did:web` service identity, serves `com.atproto.simplespace.checkUserAccess`, mints space credentials for cross-repo reads, and deletes the pre-materialized `addMember` shims.

**Architecture:** Keep the thin fetch-based `SpaceClient` (decision: branch lex packages are unpublished/workspace-only; typed client is a follow-up) but migrate it to the branch's protocol/management split (`com.atproto.space.*` for records, `com.atproto.simplespace.*` for space management). Access decisions move from pre-materialized PDS member lists to credential-mint-time callouts: the group's PDS calls OpenSocial's `checkUserAccess` (service-auth JWT signed by the authority), and OpenSocial answers from the management-space roster + roles. Cross-repo reads (member-authored posts) authenticate with a space credential obtained via `getDelegationToken` → `getSpaceCredential`.

**Tech Stack:** Node 22, plain npm, Express 5, tsx, vitest (+supertest), Kysely/Postgres. New deps: none at runtime beyond already-published `@atproto/xrpc-server`, `@atproto/identity`, `@atproto/common`; dev-only `@atproto/crypto` for JWT tests.

## Global Constraints

- Node 22 required; the default shell is Node 18 — prepend nvm v22: `export PATH="$HOME/.nvm/versions/node/v22.14.0/bin:$PATH"` (adjust to installed v22; check `ls ~/.nvm/versions/node/`).
- Repo: `/Users/brittany/Documents/Collective/open-social` (npm, CJS, no `"type": "module"`). All commands run from the repo root unless stated.
- Unit tests: `npx vitest run <file>` (config includes `src/**/*.test.ts` only). Devnet tests: `npm run test:devnet` (includes `test/devnet-*.test.ts`, requires live dev-env + running app).
- Dev-env (for Task 10 only): atproto checkout `/Users/brittany/Documents/code/atproto` on branch `permissioned-data`; run `pnpm --filter @atproto/dev-env start:multi-pds` (PLC :2582, introspect :2581, primary PDS :2583). OpenSocial devnet env: `.env.devnet` (`PDS_URL=http://localhost:2583`, `PLC_URL=http://localhost:2582`, Postgres on :5434). App port: 3001.
- Husky/lint-staged runs prettier on commit — committed files may be reformatted; that's expected.
- Do NOT touch the legacy `com.atproto.repo.*` XRPC paths in `src/xrpc/members.ts` — that surface migrates in Phase 2.
- External API shapes referenced below come from the branch lexicons at `/Users/brittany/Documents/code/atproto/lexicons/com/atproto/{space,simplespace}/*.json`. If a call fails at devnet time, re-check the JSON there first — the branch is review-stage and may drift.

## File Structure

- `src/services/spaces.ts` — SpaceClient (modified: new NSIDs, config param, token-provider auth)
- `src/services/spaceCredentials.ts` — NEW: delegation-token → space-credential exchange + cache
- `src/services/serviceIdentity.ts` — NEW: did:web document builder + service id helpers
- `src/xrpc/serviceAuth.ts` — NEW: inbound service-auth JWT verification (`verifyJwt` + IdResolver)
- `src/xrpc/checkUserAccess.ts` — NEW: the `com.atproto.simplespace.checkUserAccess` handler + pure decision fn
- `src/xrpc/server.ts` — modified: mount checkUserAccess BEFORE api-key middleware
- `src/index.ts` — modified: serve `/.well-known/did.json`
- `src/config.ts` — modified: `serviceDid`/`serviceId`/`publicUrl`
- `src/services/membership.ts`, `src/services/posts.ts` — modified: shims removed, credential-based cross-repo reads
- `lexicons/community.opensocial.{management,posts,role,roleAssignment,post}.json` — NEW; `membership.json` — replaced
- `scripts/publish-lexicons.ts` — NEW
- `test/devnet-spaces.test.ts` — NEW

---

### Task 1: Migrate SpaceClient to the simplespace split

**Files:**
- Modify: `src/services/spaces.ts`
- Test: `src/services/spaces.client.test.ts` (new)

**Interfaces:**
- Produces: `SpaceClient.createSpace(ownerDid, type, skey?, config?: SpaceConfig): Promise<{uri: string}>` now calls `com.atproto.simplespace.createSpace`; `addMember`/`listMembers` call `com.atproto.simplespace.addMember`/`listMembers` (method `getMembers` RENAMED to `listMembers` — callers updated in this task); `SpaceClient.withToken(getToken: () => Promise<string>, pdsUrl: string): SpaceClient` static factory; exported types `SpaceConfig`, `SimplespacePolicy`.
- Consumes: existing `SpaceXrpcError`, `SpaceRecord`, `SpaceRecordRef` (unchanged).

- [ ] **Step 1: Write the failing test**

Create `src/services/spaces.client.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SpaceClient } from "./spaces";

const fetchMock = vi.fn();
const agent = {
  session: { accessJwt: "jwt-abc", did: "did:plc:community" },
} as any;

function jsonResponse(body: unknown) {
  return {
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

describe("SpaceClient (simplespace split)", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("createSpace calls com.atproto.simplespace.createSpace with did/type/config", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ uri: "ats://did:plc:community/community.opensocial.posts/abc" }));
    const client = new SpaceClient(agent, "http://pds.local");
    const config = {
      policy: "managing-app" as const,
      appAccess: { $type: "com.atproto.simplespace.defs#open" as const },
      managingApp: "did:web:localhost%3A3001#opensocial",
    };
    const res = await client.createSpace("did:plc:community", "community.opensocial.posts", undefined, config);
    expect(res.uri).toContain("community.opensocial.posts");
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("http://pds.local/xrpc/com.atproto.simplespace.createSpace");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({
      did: "did:plc:community",
      type: "community.opensocial.posts",
      config,
    });
    expect(init.headers.authorization).toBe("Bearer jwt-abc");
  });

  it("addMember calls com.atproto.simplespace.addMember", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({}));
    const client = new SpaceClient(agent, "http://pds.local");
    await client.addMember("ats://x/community.opensocial.posts/a", "did:plc:bob");
    const [url] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("http://pds.local/xrpc/com.atproto.simplespace.addMember");
  });

  it("listMembers calls com.atproto.simplespace.listMembers", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ members: [{ did: "did:plc:bob" }] }));
    const client = new SpaceClient(agent, "http://pds.local");
    const res = await client.listMembers("ats://x/community.opensocial.posts/a", {});
    expect(res.members).toEqual([{ did: "did:plc:bob" }]);
    const [url] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("/xrpc/com.atproto.simplespace.listMembers");
  });

  it("withToken authenticates with the provided token instead of an agent session", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ records: [] }));
    const client = SpaceClient.withToken(async () => "space-credential-jwt", "http://member-pds.local");
    await client.listRecords("ats://x/community.opensocial.posts/a", "community.opensocial.post", {}, "did:plc:bob");
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("http://member-pds.local/xrpc/com.atproto.space.listRecords");
    expect(init.headers.authorization).toBe("Bearer space-credential-jwt");
  });

  it("record CRUD still uses com.atproto.space.*", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ uri: "u", cid: "c" }));
    const client = new SpaceClient(agent, "http://pds.local");
    await client.createRecord("ats://x/t/a", "community.opensocial.post", { $type: "community.opensocial.post" });
    const [url] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("http://pds.local/xrpc/com.atproto.space.createRecord");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/services/spaces.client.test.ts`
Expected: FAIL — `createSpace` hits `com.atproto.space.createSpace` (old NSID), `listMembers`/`withToken` don't exist.

- [ ] **Step 3: Modify `src/services/spaces.ts`**

Changes (keep everything else, including `SpaceXrpcError`, `listRecordValues`, factories):

```ts
// New exported types near the top (after SpaceKind):
export type SimplespacePolicy = "public" | "member-list" | "managing-app";

export type SpaceAppAccess =
  | { $type: "com.atproto.simplespace.defs#open" }
  | { $type: "com.atproto.simplespace.defs#allowList"; allowed: string[] };

export interface SpaceConfig {
  policy: SimplespacePolicy;
  appAccess: SpaceAppAccess;
  managingApp?: string;
}
```

Replace the session-based auth with a token provider so `withToken` works. In the class:

```ts
export class SpaceClient {
  private getToken: () => Promise<string>;
  private did: string | null;

  constructor(agent: BskyAgent | null, private pdsUrl: string, tokenProvider?: () => Promise<string>) {
    if (tokenProvider) {
      this.getToken = tokenProvider;
      this.did = null;
    } else if (agent) {
      this.getToken = async () => {
        const token = (agent as any).session?.accessJwt;
        if (!token) throw new Error("community agent has no active session");
        return token;
      };
      this.did = null; // resolved lazily in ownDid()
      this.agent = agent;
    } else {
      throw new Error("SpaceClient needs an agent or a token provider");
    }
  }

  static withToken(getToken: () => Promise<string>, pdsUrl: string): SpaceClient {
    return new SpaceClient(null, pdsUrl, getToken);
  }
  // ...
}
```

(Adapt to the file's existing style: `private call` should `const token = await this.getToken()` instead of reading `session.accessJwt` inline; `ownDid()` keeps reading `(this.agent as any).session?.did` and throws a clear error when the client was built via `withToken` — token clients must always pass `repo` explicitly.)

NSID changes:

```ts
async createSpace(ownerDid: string, type: string, skey?: string, config?: SpaceConfig): Promise<{ uri: string }> {
  const body: Record<string, unknown> = { did: ownerDid, type };
  if (skey) body.skey = skey;
  if (config) body.config = config;
  const res = await this.call<{ uri: string }>("com.atproto.simplespace.createSpace", { method: "POST", body });
  if (!res) throw new Error("createSpace returned no body");
  return res;
}

async addMember(space: string, did: string): Promise<void> {
  await this.call("com.atproto.simplespace.addMember", { method: "POST", body: { space, did } });
}

async listMembers(space: string, opts: { limit?: number; cursor?: string } = {}): Promise<{ members: Array<{ did: string }>; cursor?: string }> {
  const res = await this.call<{ members: Array<{ did: string }>; cursor?: string }>(
    "com.atproto.simplespace.listMembers",
    { method: "GET", params: { space, ...opts } },
  );
  return res ?? { members: [] };
}
```

Delete the old `getMembers` method. Update its callers: grep with `grep -rn "getMembers" src/ scripts/` and rename each call site to `listMembers` (same shape).

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/services/spaces.client.test.ts && npx vitest run`
Expected: new file PASS; full unit suite PASS (fix any `getMembers` call sites the grep missed — the type checker helps: `npx tsc --noEmit`).

- [ ] **Step 5: Commit**

```bash
git add src/services/spaces.ts src/services/spaces.client.test.ts
git commit -m "feat: migrate SpaceClient to com.atproto.simplespace split with config + token auth"
```

---

### Task 2: Formalize lexicons + publish script

**Files:**
- Create: `lexicons/community.opensocial.management.json`, `lexicons/community.opensocial.posts.json`, `lexicons/community.opensocial.role.json`, `lexicons/community.opensocial.roleAssignment.json`, `lexicons/community.opensocial.post.json`
- Replace: `lexicons/community.opensocial.membership.json` (stale shape)
- Create: `scripts/publish-lexicons.ts`
- Modify: `package.json` (script `publish:lexicons`)
- Test: `src/lib/lexiconDocs.test.ts` + Create: `src/lib/lexiconDocs.ts`

**Interfaces:**
- Produces: `loadLexiconDocs(dir?): Promise<Array<{ id: string } & Record<string, unknown>>>` in `src/lib/lexiconDocs.ts`; npm script `publish:lexicons` (devnet-sourced).
- Naming decision (locked): keep the FLAT NSIDs the code already writes (`community.opensocial.role`, `.roleAssignment`, `.membership`, `.post`; space types `.management`, `.posts`). The nested `community.opensocial.community.*` contract lexicons arrive with Phase 2. Schemas below mirror what `src/services/{roles,membership,posts}.ts` actually write.

- [ ] **Step 1: Write the failing test**

Create `src/lib/lexiconDocs.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import path from "node:path";
import { loadLexiconDocs } from "./lexiconDocs";

describe("loadLexiconDocs", () => {
  it("loads every community.opensocial lexicon JSON with an id", async () => {
    const docs = await loadLexiconDocs(path.join(__dirname, "../../lexicons"));
    const ids = docs.map((d) => d.id);
    for (const required of [
      "community.opensocial.management",
      "community.opensocial.posts",
      "community.opensocial.role",
      "community.opensocial.roleAssignment",
      "community.opensocial.membership",
      "community.opensocial.post",
    ]) {
      expect(ids).toContain(required);
    }
    for (const d of docs) expect(d.lexicon).toBe(1);
  });

  it("space type declarations list their collections", async () => {
    const docs = await loadLexiconDocs(path.join(__dirname, "../../lexicons"));
    const mgmt = docs.find((d) => d.id === "community.opensocial.management") as any;
    expect(mgmt.defs.main.type).toBe("space");
    expect(mgmt.defs.main.collections).toContain("community.opensocial.membership");
    expect(mgmt.defs.main.collections).toContain("community.opensocial.role");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/lexiconDocs.test.ts`
Expected: FAIL — module and lexicon files don't exist.

- [ ] **Step 3: Create the lexicon JSONs**

`lexicons/community.opensocial.management.json`:

```json
{
  "lexicon": 1,
  "id": "community.opensocial.management",
  "defs": {
    "main": {
      "type": "space",
      "description": "A community's governance space: roster, roles, and admin records. Portable across management apps.",
      "key": "tid",
      "name": "Community Management",
      "collections": [
        "community.opensocial.membership",
        "community.opensocial.role",
        "community.opensocial.roleAssignment",
        "community.opensocial.membershipProof"
      ]
    }
  }
}
```

`lexicons/community.opensocial.posts.json`:

```json
{
  "lexicon": 1,
  "id": "community.opensocial.posts",
  "defs": {
    "main": {
      "type": "space",
      "description": "A community's shared content space. Members write posts into their own permissioned repos within it.",
      "key": "tid",
      "name": "Community Posts",
      "collections": ["community.opensocial.post"]
    }
  }
}
```

`lexicons/community.opensocial.role.json` (rkey is the role name — key `any`):

```json
{
  "lexicon": 1,
  "id": "community.opensocial.role",
  "defs": {
    "main": {
      "type": "record",
      "description": "A role definition within a community's management space. Record key is the role name.",
      "key": "any",
      "record": {
        "type": "object",
        "required": ["name", "displayName"],
        "properties": {
          "name": { "type": "string", "maxLength": 100 },
          "displayName": { "type": "string", "maxLength": 256 },
          "capabilities": { "type": "array", "items": { "type": "string", "maxLength": 100 } },
          "createdAt": { "type": "string", "format": "datetime" }
        }
      }
    }
  }
}
```

`lexicons/community.opensocial.roleAssignment.json`:

```json
{
  "lexicon": 1,
  "id": "community.opensocial.roleAssignment",
  "defs": {
    "main": {
      "type": "record",
      "description": "Assignment of a role to a subject DID, in the management space.",
      "key": "tid",
      "record": {
        "type": "object",
        "required": ["subject", "role", "createdAt"],
        "properties": {
          "subject": { "type": "string", "format": "did" },
          "role": { "type": "string", "maxLength": 100 },
          "assignedBy": { "type": "string", "format": "did" },
          "createdAt": { "type": "string", "format": "datetime" }
        }
      }
    }
  }
}
```

Replace `lexicons/community.opensocial.membership.json` (the roster record the code writes — NOT the old user-repo shape):

```json
{
  "lexicon": 1,
  "id": "community.opensocial.membership",
  "defs": {
    "main": {
      "type": "record",
      "description": "Roster source of truth: one membership record per member, authored by the community DID in the management space.",
      "key": "tid",
      "record": {
        "type": "object",
        "required": ["subject", "status", "joinedAt"],
        "properties": {
          "subject": { "type": "string", "format": "did" },
          "status": { "type": "string", "enum": ["active", "pending"] },
          "joinedAt": { "type": "string", "format": "datetime" },
          "approvedBy": { "type": "string", "format": "did" }
        }
      }
    }
  }
}
```

> NOTE: the old `membership.json` shape (`{community, joinedAt}` in the *user's* repo) is still written by the legacy `joinCommunity` XRPC. Renaming that legacy record NSID is Phase 2; this file documents the space-era shape which is what new code validates against. Flag this collision in the PR description.

`lexicons/community.opensocial.post.json`:

```json
{
  "lexicon": 1,
  "id": "community.opensocial.post",
  "defs": {
    "main": {
      "type": "record",
      "description": "A post in a community's posts space, written into the author's own permissioned repo.",
      "key": "tid",
      "record": {
        "type": "object",
        "required": ["text", "author", "createdAt"],
        "properties": {
          "text": { "type": "string", "maxLength": 3000, "maxGraphemes": 300 },
          "author": { "type": "string", "format": "did" },
          "createdAt": { "type": "string", "format": "datetime" }
        }
      }
    }
  }
}
```

- [ ] **Step 4: Create `src/lib/lexiconDocs.ts`**

```ts
import { promises as fs } from "node:fs";
import path from "node:path";

export interface LexiconDoc extends Record<string, unknown> {
  id: string;
  lexicon: number;
}

/** Load every lexicon JSON (files with a string `id`) under a directory. */
export async function loadLexiconDocs(
  dir: string = path.join(__dirname, "../../lexicons"),
): Promise<LexiconDoc[]> {
  const entries = await fs.readdir(dir);
  const docs: LexiconDoc[] = [];
  for (const entry of entries.filter((e) => e.endsWith(".json")).sort()) {
    const raw = await fs.readFile(path.join(dir, entry), "utf8");
    const doc = JSON.parse(raw);
    if (typeof doc.id === "string") docs.push(doc);
  }
  return docs;
}
```

- [ ] **Step 5: Run tests**

Run: `npx vitest run src/lib/lexiconDocs.test.ts`
Expected: PASS.

- [ ] **Step 6: Create `scripts/publish-lexicons.ts`**

Mirrors the community-app-demo pattern (introspect → createSession → idempotent putRecord of `com.atproto.lexicon.schema`):

```ts
/**
 * Publish this repo's community.opensocial.* lexicons to the dev-env
 * lexicon authority so PDSes can resolve our NSIDs.
 * Usage: npm run publish:lexicons  (sources .env.devnet)
 */
import { loadLexiconDocs } from "../src/lib/lexiconDocs";

const INTROSPECT_URL = process.env.DEV_INTROSPECT_URL ?? "http://localhost:2581";
const LEXICON_COLLECTION = "com.atproto.lexicon.schema";

async function getAuthority(): Promise<{ handle: string; password: string; pds: string }> {
  try {
    const res = await fetch(INTROSPECT_URL);
    const info = (await res.json()) as any;
    if (info?.lexiconAuthority) return info.lexiconAuthority;
  } catch {
    // fall through to defaults
  }
  return { handle: "lex-authority.test", password: "hunter2", pds: process.env.PDS_URL ?? "http://localhost:2583" };
}

async function main() {
  const authority = await getAuthority();
  const sessionRes = await fetch(`${authority.pds}/xrpc/com.atproto.server.createSession`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ identifier: authority.handle, password: authority.password }),
  });
  if (!sessionRes.ok) throw new Error(`createSession failed: ${sessionRes.status} ${await sessionRes.text()}`);
  const { accessJwt, did } = (await sessionRes.json()) as { accessJwt: string; did: string };

  const docs = await loadLexiconDocs();
  for (const doc of docs) {
    const res = await fetch(`${authority.pds}/xrpc/com.atproto.repo.putRecord`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${accessJwt}` },
      body: JSON.stringify({ repo: did, collection: LEXICON_COLLECTION, rkey: doc.id, record: doc, validate: false }),
    });
    if (!res.ok) throw new Error(`putRecord ${doc.id} failed: ${res.status} ${await res.text()}`);
    console.log(`published ${doc.id}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

Add to `package.json` scripts (same `.env.devnet`-sourcing style as the other devnet scripts):

```json
"publish:lexicons": "bash -c 'set -a && source .env.devnet && exec tsx scripts/publish-lexicons.ts'"
```

- [ ] **Step 7: Verify script compiles, run full suite**

Run: `npx tsc --noEmit && npx vitest run`
Expected: clean compile, all PASS. (Live publish is exercised in Task 10.)

- [ ] **Step 8: Commit**

```bash
git add lexicons/ scripts/publish-lexicons.ts src/lib/lexiconDocs.ts src/lib/lexiconDocs.test.ts package.json
git commit -m "feat: formalize space-era lexicons and add devnet lexicon publishing"
```

---

### Task 3: OpenSocial service identity (did:web + /.well-known/did.json)

**Files:**
- Create: `src/services/serviceIdentity.ts`
- Modify: `src/config.ts`, `src/index.ts`, `.env.devnet`
- Test: `src/services/serviceIdentity.test.ts`

**Interfaces:**
- Produces: `config.serviceDid?: string`, `config.serviceId?: string` (serviceDid + `#opensocial`), `config.publicUrl: string`; `buildServiceDidDoc({serviceDid, serviceEndpoint})` returning a DID document; GET `/.well-known/did.json` (only when `serviceDid` is set).
- Consumed by: Task 4 (aud check = `config.serviceId`), Task 6 (`managingApp` = `config.serviceId`).

- [ ] **Step 1: Write the failing test**

Create `src/services/serviceIdentity.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { buildServiceDidDoc } from "./serviceIdentity";

describe("buildServiceDidDoc", () => {
  it("builds a did:web document with the #opensocial service entry", () => {
    const doc = buildServiceDidDoc({
      serviceDid: "did:web:localhost%3A3001",
      serviceEndpoint: "http://localhost:3001",
    });
    expect(doc.id).toBe("did:web:localhost%3A3001");
    expect(doc["@context"]).toContain("https://www.w3.org/ns/did/v1");
    expect(doc.service).toEqual([
      {
        id: "#opensocial",
        type: "OpenSocialCommunityManagement",
        serviceEndpoint: "http://localhost:3001",
      },
    ]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/services/serviceIdentity.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement**

`src/services/serviceIdentity.ts`:

```ts
export interface ServiceDidDoc {
  "@context": string[];
  id: string;
  service: Array<{ id: string; type: string; serviceEndpoint: string }>;
}

export const OPENSOCIAL_SERVICE_FRAGMENT = "#opensocial";

/**
 * DID document for OpenSocial's own service identity (did:web).
 * The group PDS resolves `managingApp` (did + fragment) through this
 * document to find where to send checkUserAccess.
 */
export function buildServiceDidDoc(opts: { serviceDid: string; serviceEndpoint: string }): ServiceDidDoc {
  return {
    "@context": ["https://www.w3.org/ns/did/v1"],
    id: opts.serviceDid,
    service: [
      {
        id: OPENSOCIAL_SERVICE_FRAGMENT,
        type: "OpenSocialCommunityManagement",
        serviceEndpoint: opts.serviceEndpoint,
      },
    ],
  };
}
```

`src/config.ts` — add to the exported config object:

```ts
serviceDid: process.env.OPENSOCIAL_SERVICE_DID || undefined,
serviceId: process.env.OPENSOCIAL_SERVICE_DID ? `${process.env.OPENSOCIAL_SERVICE_DID}#opensocial` : undefined,
publicUrl: process.env.SERVICE_URL || `http://localhost:${process.env.PORT || 3001}`,
```

`src/index.ts` — before the routers are mounted:

```ts
import { buildServiceDidDoc } from "./services/serviceIdentity";
// ...
if (config.serviceDid) {
  app.get("/.well-known/did.json", (_req, res) => {
    res.json(buildServiceDidDoc({ serviceDid: config.serviceDid!, serviceEndpoint: config.publicUrl }));
  });
}
```

`.env.devnet` — add:

```
OPENSOCIAL_SERVICE_DID=did:web:localhost%3A3001
```

(`did:web:localhost%3A3001` resolves over plain http for localhost per `@atproto/identity`'s web resolver, from `http://localhost:3001/.well-known/did.json` — no HTTPS needed in devnet.)

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/services/serviceIdentity.test.ts && npx tsc --noEmit`
Expected: PASS, clean compile.

- [ ] **Step 5: Commit**

```bash
git add src/services/serviceIdentity.ts src/services/serviceIdentity.test.ts src/config.ts src/index.ts .env.devnet
git commit -m "feat: add did:web service identity and /.well-known/did.json"
```

---

### Task 4: Inbound service-auth verification

**Files:**
- Create: `src/xrpc/serviceAuth.ts`
- Modify: `package.json` (add devDependency `@atproto/crypto`, runtime dep `@atproto/common`)
- Test: `src/xrpc/serviceAuth.test.ts`

**Interfaces:**
- Produces: `verifyServiceAuth(authorizationHeader: string | undefined, lxm: string, opts?: { getSigningKey?: GetSigningKeyFn }): Promise<{ iss: string; aud: string }>` — throws `ServiceAuthError(401, message)` on any failure; verifies signature, `exp`, `aud === config.serviceId`, `lxm`.
- Consumes: `config.serviceId` (Task 3), `config.plcUrl` (existing).

- [ ] **Step 1: Install deps**

Run: `npm install @atproto/common && npm install -D @atproto/crypto`
Expected: both resolve from the public registry (published versions; service-auth JWT format is stable across branch/published).

- [ ] **Step 2: Write the failing test**

Create `src/xrpc/serviceAuth.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { Secp256k1Keypair } from "@atproto/crypto";
import { createServiceJwt } from "@atproto/xrpc-server";
import { verifyServiceAuth, ServiceAuthError } from "./serviceAuth";

const LXM = "com.atproto.simplespace.checkUserAccess";
const SERVICE_ID = "did:web:localhost%3A3001#opensocial";

// config.serviceId comes from env; set it for this suite.
process.env.OPENSOCIAL_SERVICE_DID = "did:web:localhost%3A3001";

async function makeJwt(overrides: Partial<{ aud: string; lxm: string }> = {}) {
  const keypair = await Secp256k1Keypair.create();
  const jwt = await createServiceJwt({
    iss: "did:plc:authority",
    aud: overrides.aud ?? SERVICE_ID,
    lxm: overrides.lxm ?? LXM,
    keypair,
  });
  const getSigningKey = async () => keypair.did();
  return { jwt, getSigningKey };
}

describe("verifyServiceAuth", () => {
  it("accepts a valid authority-signed JWT and returns iss", async () => {
    const { jwt, getSigningKey } = await makeJwt();
    const payload = await verifyServiceAuth(`Bearer ${jwt}`, LXM, { getSigningKey });
    expect(payload.iss).toBe("did:plc:authority");
  });

  it("rejects a missing header", async () => {
    await expect(verifyServiceAuth(undefined, LXM)).rejects.toBeInstanceOf(ServiceAuthError);
  });

  it("rejects a wrong audience", async () => {
    const { jwt, getSigningKey } = await makeJwt({ aud: "did:web:evil.example#other" });
    await expect(verifyServiceAuth(`Bearer ${jwt}`, LXM, { getSigningKey })).rejects.toBeInstanceOf(ServiceAuthError);
  });

  it("rejects a wrong lxm", async () => {
    const { jwt, getSigningKey } = await makeJwt({ lxm: "com.atproto.space.notifyWrite" });
    await expect(verifyServiceAuth(`Bearer ${jwt}`, LXM, { getSigningKey })).rejects.toBeInstanceOf(ServiceAuthError);
  });

  it("rejects a signature from a different key", async () => {
    const { jwt } = await makeJwt();
    const other = await Secp256k1Keypair.create();
    await expect(
      verifyServiceAuth(`Bearer ${jwt}`, LXM, { getSigningKey: async () => other.did() }),
    ).rejects.toBeInstanceOf(ServiceAuthError);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run src/xrpc/serviceAuth.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 4: Implement `src/xrpc/serviceAuth.ts`**

```ts
/**
 * Verify inbound AT Protocol service-auth JWTs (e.g. the group PDS calling
 * com.atproto.simplespace.checkUserAccess as the space authority).
 * Pattern follows packages/pds/src/auth-verifier.ts in the atproto repo.
 */
import { verifyJwt } from "@atproto/xrpc-server";
import { IdResolver, getDidKeyFromMultibase } from "@atproto/identity";
import { getVerificationMaterial } from "@atproto/common";
import { config } from "../config";

export class ServiceAuthError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export type GetSigningKeyFn = (iss: string, forceRefresh: boolean) => Promise<string>;

const idResolver = new IdResolver({ plcUrl: config.plcUrl });

const resolveSigningKey: GetSigningKeyFn = async (iss, forceRefresh) => {
  const [did] = iss.split("#");
  const didDoc = await idResolver.did.resolve(did, forceRefresh);
  if (!didDoc) throw new ServiceAuthError(401, `could not resolve iss did: ${did}`);
  const parsedKey = getVerificationMaterial(didDoc, "atproto");
  if (!parsedKey) throw new ServiceAuthError(401, "missing atproto key in did doc");
  const didKey = getDidKeyFromMultibase(parsedKey);
  if (!didKey) throw new ServiceAuthError(401, "bad atproto key in did doc");
  return didKey;
};

export async function verifyServiceAuth(
  authorizationHeader: string | undefined,
  lxm: string,
  opts: { getSigningKey?: GetSigningKeyFn } = {},
): Promise<{ iss: string; aud: string }> {
  if (!config.serviceId) throw new ServiceAuthError(500, "OPENSOCIAL_SERVICE_DID is not configured");
  if (!authorizationHeader?.startsWith("Bearer ")) {
    throw new ServiceAuthError(401, "missing service auth token");
  }
  const jwt = authorizationHeader.slice("Bearer ".length).trim();
  try {
    const payload = await verifyJwt(jwt, config.serviceId, lxm, opts.getSigningKey ?? resolveSigningKey);
    return { iss: payload.iss, aud: payload.aud };
  } catch (err) {
    if (err instanceof ServiceAuthError) throw err;
    throw new ServiceAuthError(401, `invalid service auth token: ${(err as Error).message}`);
  }
}
```

> If `config.serviceId` reads env at import time and the test sets env after import, adjust `config.ts` to read `OPENSOCIAL_SERVICE_DID` lazily via a getter, or set the env var in `src/test/setup.ts`. Prefer the setup-file approach: add `process.env.OPENSOCIAL_SERVICE_DID ??= "did:web:localhost%3A3001";` to `src/test/setup.ts`.

- [ ] **Step 5: Run tests**

Run: `npx vitest run src/xrpc/serviceAuth.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 6: Commit**

```bash
git add src/xrpc/serviceAuth.ts src/xrpc/serviceAuth.test.ts src/test/setup.ts package.json package-lock.json
git commit -m "feat: verify inbound service-auth JWTs against our service id"
```

---

### Task 5: checkUserAccess endpoint

**Files:**
- Create: `src/xrpc/checkUserAccess.ts`
- Modify: `src/xrpc/server.ts` (mount BEFORE rate-limit/api-key middleware)
- Test: `src/xrpc/checkUserAccess.test.ts`

**Interfaces:**
- Produces: pure `decideUserAccess({ kind, communityDid, user, roster, userCanManage }): boolean`; Express handler `GET /xrpc/com.atproto.simplespace.checkUserAccess?space=&user=&clientId=` → `{ authorized: boolean }`, authenticated via `verifyServiceAuth` (Task 4), issuer must equal the community DID that owns the space.
- Consumes: `getCommunitySpaceByUri(db, spaceUri)` (added here to `src/services/spaces.ts`), `listMemberships` + `Roster` (membership.ts), `actorCan` (roles.ts).

- [ ] **Step 1: Write the failing test**

Create `src/xrpc/checkUserAccess.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

const { mocks } = vi.hoisted(() => ({
  mocks: {
    verifyServiceAuth: vi.fn(),
    getCommunitySpaceByUri: vi.fn(),
    listMemberships: vi.fn(),
    actorCan: vi.fn(),
  },
}));

vi.mock("./serviceAuth", () => ({
  verifyServiceAuth: mocks.verifyServiceAuth,
  ServiceAuthError: class ServiceAuthError extends Error {
    constructor(public status: number, message: string) { super(message); }
  },
}));
vi.mock("../services/spaces", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getCommunitySpaceByUri: mocks.getCommunitySpaceByUri,
}));
vi.mock("../services/membership", () => ({ listMemberships: mocks.listMemberships }));
vi.mock("../services/roles", () => ({ actorCan: mocks.actorCan }));

import { decideUserAccess, createCheckUserAccessHandler } from "./checkUserAccess";

const SPACE = "ats://did:plc:comm/community.opensocial.posts/abc";

function appWith(handler: any) {
  const app = express();
  app.get("/xrpc/com.atproto.simplespace.checkUserAccess", handler);
  return app;
}

describe("decideUserAccess", () => {
  const roster = [
    { subject: "did:plc:member", status: "active" as const, joinedAt: "2026-01-01T00:00:00Z" },
    { subject: "did:plc:pending", status: "pending" as const, joinedAt: "2026-01-01T00:00:00Z" },
  ];

  it("authorizes the community itself for any space", () => {
    expect(decideUserAccess({ kind: "management", communityDid: "did:plc:comm", user: "did:plc:comm", roster: [], userCanManage: false })).toBe(true);
  });
  it("authorizes active members for the posts space", () => {
    expect(decideUserAccess({ kind: "posts", communityDid: "did:plc:comm", user: "did:plc:member", roster, userCanManage: false })).toBe(true);
  });
  it("rejects pending members for the posts space", () => {
    expect(decideUserAccess({ kind: "posts", communityDid: "did:plc:comm", user: "did:plc:pending", roster, userCanManage: false })).toBe(false);
  });
  it("authorizes only managers for the management space", () => {
    expect(decideUserAccess({ kind: "management", communityDid: "did:plc:comm", user: "did:plc:member", roster, userCanManage: false })).toBe(false);
    expect(decideUserAccess({ kind: "management", communityDid: "did:plc:comm", user: "did:plc:member", roster, userCanManage: true })).toBe(true);
  });
});

describe("checkUserAccess handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.verifyServiceAuth.mockResolvedValue({ iss: "did:plc:comm", aud: "did:web:localhost%3A3001#opensocial" });
    mocks.getCommunitySpaceByUri.mockResolvedValue({ community_did: "did:plc:comm", kind: "posts", space_uri: SPACE });
    mocks.listMemberships.mockResolvedValue([{ subject: "did:plc:member", status: "active", joinedAt: "x" }]);
    mocks.actorCan.mockResolvedValue(false);
  });

  it("authorizes an active member", async () => {
    const app = appWith(createCheckUserAccessHandler({} as any));
    const res = await request(app)
      .get("/xrpc/com.atproto.simplespace.checkUserAccess")
      .query({ space: SPACE, user: "did:plc:member" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ authorized: true });
  });

  it("rejects when the issuer is not the space's community", async () => {
    mocks.verifyServiceAuth.mockResolvedValue({ iss: "did:plc:someone-else", aud: "x" });
    const app = appWith(createCheckUserAccessHandler({} as any));
    const res = await request(app)
      .get("/xrpc/com.atproto.simplespace.checkUserAccess")
      .query({ space: SPACE, user: "did:plc:member" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ authorized: false });
  });

  it("answers authorized:false for unknown spaces", async () => {
    mocks.getCommunitySpaceByUri.mockResolvedValue(null);
    const app = appWith(createCheckUserAccessHandler({} as any));
    const res = await request(app)
      .get("/xrpc/com.atproto.simplespace.checkUserAccess")
      .query({ space: "ats://did:plc:x/t/unknown", user: "did:plc:member" });
    expect(res.body).toEqual({ authorized: false });
  });

  it("401s when service auth fails", async () => {
    const { ServiceAuthError } = await import("./serviceAuth");
    mocks.verifyServiceAuth.mockRejectedValue(new ServiceAuthError(401, "nope"));
    const app = appWith(createCheckUserAccessHandler({} as any));
    const res = await request(app)
      .get("/xrpc/com.atproto.simplespace.checkUserAccess")
      .query({ space: SPACE, user: "did:plc:member" });
    expect(res.status).toBe(401);
  });

  it("400s on missing params", async () => {
    const app = appWith(createCheckUserAccessHandler({} as any));
    const res = await request(app).get("/xrpc/com.atproto.simplespace.checkUserAccess");
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/xrpc/checkUserAccess.test.ts`
Expected: FAIL — module missing. (If supertest isn't installed: `npm install -D supertest @types/supertest`; check `package.json` first — routes tests may already use it.)

- [ ] **Step 3: Add `getCommunitySpaceByUri` to `src/services/spaces.ts`**

```ts
export async function getCommunitySpaceByUri(
  db: Kysely<Database>,
  spaceUri: string,
): Promise<{ community_did: string; kind: SpaceKind; space_uri: string } | null> {
  const row = await db
    .selectFrom("community_spaces")
    .select(["community_did", "kind", "space_uri"])
    .where("space_uri", "=", spaceUri)
    .executeTakeFirst();
  return (row as { community_did: string; kind: SpaceKind; space_uri: string }) ?? null;
}
```

- [ ] **Step 4: Implement `src/xrpc/checkUserAccess.ts`**

```ts
/**
 * com.atproto.simplespace.checkUserAccess — the mint-time callout.
 * The group's PDS (space authority) asks us whether `user` may receive a
 * space credential. Fail closed: any doubt => authorized: false.
 */
import type { Request, Response } from "express";
import type { Kysely } from "kysely";
import type { Database } from "../db";
import { verifyServiceAuth, ServiceAuthError } from "./serviceAuth";
import { getCommunitySpaceByUri, type SpaceKind } from "../services/spaces";
import { listMemberships, type Roster } from "../services/membership";
import { actorCan } from "../services/roles";
import { logger } from "../lib/logger";

export const CHECK_USER_ACCESS_LXM = "com.atproto.simplespace.checkUserAccess";

export function decideUserAccess(input: {
  kind: SpaceKind;
  communityDid: string;
  user: string;
  roster: Roster;
  userCanManage: boolean;
}): boolean {
  if (input.user === input.communityDid) return true;
  if (input.kind === "posts") {
    return input.roster.some((m) => m.subject === input.user && m.status === "active");
  }
  return input.userCanManage;
}

export function createCheckUserAccessHandler(db: Kysely<Database>) {
  return async (req: Request, res: Response) => {
    const space = req.query.space;
    const user = req.query.user;
    if (typeof space !== "string" || typeof user !== "string") {
      return res.status(400).json({ error: "InvalidRequest", message: "space and user are required" });
    }
    let iss: string;
    try {
      ({ iss } = await verifyServiceAuth(req.headers.authorization, CHECK_USER_ACCESS_LXM));
    } catch (err) {
      const status = err instanceof ServiceAuthError ? err.status : 401;
      return res.status(status).json({ error: "AuthRequired", message: (err as Error).message });
    }
    try {
      const spaceRow = await getCommunitySpaceByUri(db, space);
      if (!spaceRow || spaceRow.community_did !== iss.split("#")[0]) {
        return res.json({ authorized: false });
      }
      const [roster, userCanManage] = await Promise.all([
        listMemberships(db, spaceRow.community_did),
        actorCan(db, spaceRow.community_did, user, "manage"),
      ]);
      const authorized = decideUserAccess({
        kind: spaceRow.kind,
        communityDid: spaceRow.community_did,
        user,
        roster,
        userCanManage,
      });
      return res.json({ authorized });
    } catch (err) {
      logger.warn({ err, space, user }, "checkUserAccess failed; denying");
      return res.json({ authorized: false });
    }
  };
}
```

- [ ] **Step 5: Mount it in `src/xrpc/server.ts`**

In `createXrpcRouter(db)`, BEFORE `router.use(createRateLimiter(db))` / `router.use(createVerifyApiKey(db))`:

```ts
import { createCheckUserAccessHandler, CHECK_USER_ACCESS_LXM } from "./checkUserAccess";
// ...
// Service-auth method: called by group PDSes, not by API-key apps.
router.get(`/${CHECK_USER_ACCESS_LXM}`, createCheckUserAccessHandler(db));
```

- [ ] **Step 6: Run tests**

Run: `npx vitest run src/xrpc/checkUserAccess.test.ts && npx vitest run && npx tsc --noEmit`
Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
git add src/xrpc/checkUserAccess.ts src/xrpc/checkUserAccess.test.ts src/xrpc/server.ts src/services/spaces.ts
git commit -m "feat: serve com.atproto.simplespace.checkUserAccess with service auth"
```

---

### Task 6: Provision spaces with managing-app policy

**Files:**
- Modify: `src/services/spaces.ts` (`provisionCommunitySpaces`)
- Test: `src/services/spaces.provision.test.ts` (new)

**Interfaces:**
- Produces: `buildManagedSpaceConfig(serviceId: string): SpaceConfig`; `provisionCommunitySpaces` passes the config when `config.serviceId` is set (logs a warning and provisions with host defaults otherwise).
- Consumes: `SpaceClient.createSpace(ownerDid, type, skey?, config?)` (Task 1), `config.serviceId` (Task 3).

- [ ] **Step 1: Write the failing test**

Create `src/services/spaces.provision.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockClient, mockDb } = vi.hoisted(() => {
  const mockClient = { createSpace: vi.fn() };
  // Minimal kysely stub: no existing rows, capture inserts.
  const inserts: any[] = [];
  const mockDb = {
    inserts,
    selectFrom: () => ({ select: () => ({ where: () => ({ execute: async () => [] }) }) }),
    insertInto: () => ({
      values: (v: any) => ({ onConflict: () => ({ execute: async () => { inserts.push(v); } }) }),
    }),
  } as any;
  return { mockClient, mockDb };
});

vi.mock("./atproto", () => ({
  createCommunityAgent: vi.fn(async () => ({})),
  resolvePdsEndpoint: vi.fn(async () => "http://pds.local"),
  getMemberAgent: vi.fn(),
}));

import { provisionCommunitySpaces, buildManagedSpaceConfig, SpaceClient } from "./spaces";

vi.spyOn(SpaceClient.prototype as any, "createSpace").mockImplementation(mockClient.createSpace);

describe("provisionCommunitySpaces with managing-app", () => {
  beforeEach(() => {
    process.env.OPENSOCIAL_SERVICE_DID = "did:web:localhost%3A3001";
    mockClient.createSpace.mockReset();
    mockClient.createSpace.mockImplementation(async (_did: string, type: string) => ({
      uri: `ats://did:plc:comm/${type}/self`,
    }));
    mockDb.inserts.length = 0;
  });

  it("buildManagedSpaceConfig sets policy, open appAccess, and managingApp", () => {
    expect(buildManagedSpaceConfig("did:web:localhost%3A3001#opensocial")).toEqual({
      policy: "managing-app",
      appAccess: { $type: "com.atproto.simplespace.defs#open" },
      managingApp: "did:web:localhost%3A3001#opensocial",
    });
  });

  it("passes the managed config to createSpace for both kinds", async () => {
    await provisionCommunitySpaces(mockDb, "did:plc:comm");
    expect(mockClient.createSpace).toHaveBeenCalledTimes(2);
    for (const call of mockClient.createSpace.mock.calls) {
      expect(call[3]).toEqual(buildManagedSpaceConfig("did:web:localhost%3A3001#opensocial"));
    }
  });
});
```

> Note: `onConflict` in the stub must match the real call chain (`.onConflict((oc) => ...)` then `.execute()`); adjust the stub to the actual kysely usage in `provisionCommunitySpaces` (read it first — the chain is `insertInto("community_spaces").values({...}).onConflict((oc) => oc.columns([...]).doNothing()).execute()`).

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/services/spaces.provision.test.ts`
Expected: FAIL — `buildManagedSpaceConfig` doesn't exist; `createSpace` called without a config argument.

- [ ] **Step 3: Implement**

In `src/services/spaces.ts`:

```ts
import { config } from "../config";

export function buildManagedSpaceConfig(serviceId: string): SpaceConfig {
  return {
    policy: "managing-app",
    appAccess: { $type: "com.atproto.simplespace.defs#open" },
    managingApp: serviceId,
  };
}
```

In `provisionCommunitySpaces`, where `client.createSpace(communityDid, type)` is called:

```ts
const spaceConfig = config.serviceId ? buildManagedSpaceConfig(config.serviceId) : undefined;
if (!spaceConfig) {
  logger.warn("OPENSOCIAL_SERVICE_DID unset — provisioning spaces with host default policy (member-list)");
}
// ...
const created = await client.createSpace(communityDid, type, undefined, spaceConfig);
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/services/spaces.provision.test.ts && npx vitest run`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/spaces.ts src/services/spaces.provision.test.ts
git commit -m "feat: provision community spaces with managing-app policy"
```

---

### Task 7: Space credential service

**Files:**
- Create: `src/services/spaceCredentials.ts`
- Test: `src/services/spaceCredentials.test.ts`

**Interfaces:**
- Produces: `getCommunitySpaceCredential(db, communityDid, spaceUri): Promise<string>` (cached until 5 min before `exp`); `parseJwtExp(jwt): number` (ms epoch); `clearCredentialCache()` for tests.
- Consumes: `createCommunityAgent`, `resolvePdsEndpoint` (atproto.ts). Flow: `GET {pds}/xrpc/com.atproto.space.getDelegationToken?space=...` with the community session Bearer → `{ token }`; then `POST {pds}/xrpc/com.atproto.space.getSpaceCredential` with `authorization: Bearer <token>` and body `{ space }` → `{ credential }`.
- ⚠️ Field names `token`/`credential` must be confirmed against `/Users/brittany/Documents/code/atproto/lexicons/com/atproto/space/getDelegationToken.json` and `getSpaceCredential.json` before implementing — read both files first and adjust the code + tests to the actual output property names.

- [ ] **Step 1: Read the two lexicon JSONs (paths above) and note exact output field names**

Run: `cat /Users/brittany/Documents/code/atproto/lexicons/com/atproto/space/getDelegationToken.json /Users/brittany/Documents/code/atproto/lexicons/com/atproto/space/getSpaceCredential.json`

- [ ] **Step 2: Write the failing test**

Create `src/services/spaceCredentials.test.ts` (adjust field names per Step 1):

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("./atproto", () => ({
  createCommunityAgent: vi.fn(async () => ({ session: { accessJwt: "community-jwt", did: "did:plc:comm" } })),
  resolvePdsEndpoint: vi.fn(async () => "http://pds.local"),
}));

import { getCommunitySpaceCredential, parseJwtExp, clearCredentialCache } from "./spaceCredentials";

function fakeJwt(expSecondsFromNow: number): string {
  const payload = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + expSecondsFromNow })).toString("base64url");
  return `h.${payload}.s`;
}

const fetchMock = vi.fn();
const SPACE = "ats://did:plc:comm/community.opensocial.posts/abc";

describe("spaceCredentials", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockReset();
    clearCredentialCache();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("parseJwtExp reads exp in ms", () => {
    const jwt = fakeJwt(3600);
    expect(parseJwtExp(jwt)).toBeGreaterThan(Date.now() + 3000 * 1000);
  });

  it("exchanges delegation token for a credential", async () => {
    const credential = fakeJwt(7200);
    fetchMock
      .mockResolvedValueOnce({ ok: true, json: async () => ({ token: "delegation-jwt" }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ credential }) });
    const result = await getCommunitySpaceCredential({} as any, "did:plc:comm", SPACE);
    expect(result).toBe(credential);

    const [url1, init1] = fetchMock.mock.calls[0];
    expect(String(url1)).toContain("/xrpc/com.atproto.space.getDelegationToken");
    expect(String(url1)).toContain(encodeURIComponent(SPACE));
    expect(init1.headers.authorization).toBe("Bearer community-jwt");

    const [url2, init2] = fetchMock.mock.calls[1];
    expect(String(url2)).toContain("/xrpc/com.atproto.space.getSpaceCredential");
    expect(init2.method).toBe("POST");
    expect(init2.headers.authorization).toBe("Bearer delegation-jwt");
    expect(JSON.parse(init2.body)).toEqual({ space: SPACE });
  });

  it("caches until near expiry", async () => {
    const credential = fakeJwt(7200);
    fetchMock
      .mockResolvedValueOnce({ ok: true, json: async () => ({ token: "t" }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ credential }) });
    await getCommunitySpaceCredential({} as any, "did:plc:comm", SPACE);
    await getCommunitySpaceCredential({} as any, "did:plc:comm", SPACE);
    expect(fetchMock).toHaveBeenCalledTimes(2); // not 4
  });

  it("re-fetches when the cached credential is near expiry", async () => {
    const nearExpiry = fakeJwt(60); // < 5 min buffer
    const fresh = fakeJwt(7200);
    fetchMock
      .mockResolvedValueOnce({ ok: true, json: async () => ({ token: "t1" }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ credential: nearExpiry }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ token: "t2" }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ credential: fresh }) });
    await getCommunitySpaceCredential({} as any, "did:plc:comm", SPACE);
    const second = await getCommunitySpaceCredential({} as any, "did:plc:comm", SPACE);
    expect(second).toBe(fresh);
  });

  it("throws on a failed exchange", async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 401, text: async () => "denied" });
    await expect(getCommunitySpaceCredential({} as any, "did:plc:comm", SPACE)).rejects.toThrow(/getDelegationToken/);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run src/services/spaceCredentials.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 4: Implement `src/services/spaceCredentials.ts`**

```ts
/**
 * Obtain and cache space credentials for a community, for cross-repo reads
 * (member-authored records live on the member's PDS; reading them requires a
 * space credential rather than the community's own session).
 */
import type { Kysely } from "kysely";
import type { Database } from "../db";
import { createCommunityAgent, resolvePdsEndpoint } from "./atproto";

const EXPIRY_BUFFER_MS = 5 * 60 * 1000;
const cache = new Map<string, { credential: string; exp: number }>();

export function clearCredentialCache(): void {
  cache.clear();
}

export function parseJwtExp(jwt: string): number {
  const payload = JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString());
  return (payload.exp ?? 0) * 1000;
}

async function xrpcJson(url: string, init: RequestInit, label: string): Promise<any> {
  const res = await fetch(url, init);
  if (!res.ok) {
    throw new Error(`${label} failed: ${res.status} ${await res.text().catch(() => "")}`);
  }
  return res.json();
}

export async function getCommunitySpaceCredential(
  db: Kysely<Database>,
  communityDid: string,
  spaceUri: string,
): Promise<string> {
  const cached = cache.get(spaceUri);
  if (cached && cached.exp - EXPIRY_BUFFER_MS > Date.now()) return cached.credential;

  const agent = await createCommunityAgent(db, communityDid);
  const accessJwt = (agent as any).session?.accessJwt;
  if (!accessJwt) throw new Error("community agent has no active session");
  const pdsUrl = await resolvePdsEndpoint(communityDid);

  const tokenUrl = new URL("/xrpc/com.atproto.space.getDelegationToken", pdsUrl);
  tokenUrl.searchParams.set("space", spaceUri);
  const { token } = await xrpcJson(
    tokenUrl.toString(),
    { headers: { authorization: `Bearer ${accessJwt}` } },
    "getDelegationToken",
  );

  const { credential } = await xrpcJson(
    new URL("/xrpc/com.atproto.space.getSpaceCredential", pdsUrl).toString(),
    {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ space: spaceUri }),
    },
    "getSpaceCredential",
  );

  cache.set(spaceUri, { credential, exp: parseJwtExp(credential) });
  return credential;
}
```

(Adjust `token`/`credential` property names to what Step 1 found.)

- [ ] **Step 5: Run tests**

Run: `npx vitest run src/services/spaceCredentials.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/services/spaceCredentials.ts src/services/spaceCredentials.test.ts
git commit -m "feat: mint and cache space credentials for cross-repo reads"
```

---

### Task 8: Credential-based cross-repo reads in listCommunityPosts

**Files:**
- Modify: `src/services/posts.ts` (`listCommunityPosts`)
- Test: `src/services/posts.listing.test.ts` (new; existing `posts.test.ts` keeps its pure tests)

**Interfaces:**
- Consumes: `getCommunitySpaceCredential` (Task 7), `SpaceClient.withToken` (Task 1), `resolvePdsEndpoint` (atproto.ts), `listMemberships`.
- Produces: `listCommunityPosts(db, communityDid)` unchanged signature; internally: community's own records read with the community client as before; each OTHER author's records read from THAT author's PDS via `SpaceClient.withToken(credential)`. Per-author failures still logged-and-skipped.

- [ ] **Step 1: Write the failing test**

Create `src/services/posts.listing.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mocks } = vi.hoisted(() => ({
  mocks: {
    getSpaceClient: vi.fn(),
    getCommunitySpace: vi.fn(),
    withToken: vi.fn(),
    getCommunitySpaceCredential: vi.fn(),
    resolvePdsEndpoint: vi.fn(),
    listMemberships: vi.fn(),
  },
}));

vi.mock("./spaces", async (importOriginal) => {
  const actual = await importOriginal<any>();
  return {
    ...actual,
    getSpaceClient: mocks.getSpaceClient,
    getCommunitySpace: mocks.getCommunitySpace,
    SpaceClient: { ...actual.SpaceClient, withToken: mocks.withToken },
  };
});
vi.mock("./spaceCredentials", () => ({ getCommunitySpaceCredential: mocks.getCommunitySpaceCredential }));
vi.mock("./atproto", () => ({ resolvePdsEndpoint: mocks.resolvePdsEndpoint, createCommunityAgent: vi.fn(), getMemberAgent: vi.fn() }));
vi.mock("./membership", () => ({ listMemberships: mocks.listMemberships, isMember: vi.fn() }));

import { listCommunityPosts } from "./posts";

const SPACE = "ats://did:plc:comm/community.opensocial.posts/abc";

describe("listCommunityPosts cross-repo reads", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getCommunitySpace.mockResolvedValue(SPACE);
    mocks.listMemberships.mockResolvedValue([
      { subject: "did:plc:member", status: "active", joinedAt: "x" },
    ]);
    mocks.getCommunitySpaceCredential.mockResolvedValue("credential-jwt");
    mocks.resolvePdsEndpoint.mockResolvedValue("http://member-pds.local");
    const communityClient = {
      listRecordValues: vi.fn(async () => [
        { rkey: "1", cid: "c1", value: { text: "own post", author: "did:plc:comm", createdAt: "2026-01-02T00:00:00Z" } },
      ]),
    };
    const memberClient = {
      listRecordValues: vi.fn(async () => [
        { rkey: "2", cid: "c2", value: { text: "member post", author: "did:plc:member", createdAt: "2026-01-03T00:00:00Z" } },
      ]),
    };
    mocks.getSpaceClient.mockResolvedValue(communityClient);
    mocks.withToken.mockReturnValue(memberClient);
  });

  it("reads member repos from the member's PDS with a space credential", async () => {
    const posts = await listCommunityPosts({} as any, "did:plc:comm");
    expect(posts.map((p) => p.text)).toEqual(["member post", "own post"]); // newest first
    expect(mocks.getCommunitySpaceCredential).toHaveBeenCalledWith(expect.anything(), "did:plc:comm", SPACE);
    expect(mocks.resolvePdsEndpoint).toHaveBeenCalledWith("did:plc:member");
    expect(mocks.withToken).toHaveBeenCalledWith(expect.any(Function), "http://member-pds.local");
  });

  it("skips a member repo that fails and keeps the rest", async () => {
    mocks.withToken.mockReturnValue({ listRecordValues: vi.fn(async () => { throw new Error("boom"); }) });
    const posts = await listCommunityPosts({} as any, "did:plc:comm");
    expect(posts.map((p) => p.text)).toEqual(["own post"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/services/posts.listing.test.ts`
Expected: FAIL — current implementation reads every repo through the community client on the community PDS (no credential, no per-member PDS resolution).

- [ ] **Step 3: Modify `listCommunityPosts` in `src/services/posts.ts`**

Replace the fan-out body (keep `aggregateAndSortPosts` and the per-repo try/catch):

```ts
import { getCommunitySpaceCredential } from "./spaceCredentials";
import { resolvePdsEndpoint } from "./atproto";
import { SpaceClient } from "./spaces";
// ...
const ownerClient = await getSpaceClient(db, communityDid);
const roster = await listMemberships(db, communityDid);
const memberAuthors = roster.map((m) => m.subject).filter((s) => s !== communityDid);

// Community's own records: read with its own session on its own PDS.
const perAuthor: CommunityPost[][] = [];
try {
  const own = await ownerClient.listRecordValues<PostRecord>(space, POST, communityDid);
  perAuthor.push(own.map(toCommunityPost));
} catch (err) {
  logger.warn({ err, author: communityDid }, "failed to read community's own posts");
}

// Member records live on each member's PDS; reads require a space credential.
if (memberAuthors.length > 0) {
  const credential = await getCommunitySpaceCredential(db, communityDid, space);
  for (const author of memberAuthors) {
    try {
      const pdsUrl = await resolvePdsEndpoint(author);
      const client = SpaceClient.withToken(async () => credential, pdsUrl);
      const values = await client.listRecordValues<PostRecord>(space, POST, author);
      perAuthor.push(values.map(toCommunityPost));
    } catch (err) {
      logger.warn({ err, author }, "failed to read member repo; skipping");
    }
  }
}
return aggregateAndSortPosts(perAuthor);
```

(`toCommunityPost` = the existing mapping from `{rkey,cid,value}` to `CommunityPost`; extract it if inline. `PostRecord` = the existing value type used in the current fan-out.)

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/services/posts.listing.test.ts && npx vitest run`
Expected: PASS (including the untouched pure tests in `posts.test.ts`).

- [ ] **Step 5: Commit**

```bash
git add src/services/posts.ts src/services/posts.listing.test.ts
git commit -m "feat: read member repos from their own PDS with a space credential"
```

---

### Task 9: Remove the addMember shims

**Files:**
- Modify: `src/services/membership.ts`
- Test: `src/services/membership.roster.test.ts` (new)

**Interfaces:**
- `recordMembership(db, communityDid, subjectDid, opts?)` — same signature, but no longer calls `addMember` (the mint-time callout from Task 5 replaces pre-materialization). Also drops the `actorCan` import if now unused. `writeMembershipProof` similarly drops its `addMember` line (L153 area).
- The "call recordMembership after assigning roles" ordering caveat in the doc comment becomes obsolete — delete that comment text.

- [ ] **Step 1: Write the failing test**

Create `src/services/membership.roster.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mocks } = vi.hoisted(() => ({
  mocks: {
    getSpaceClient: vi.fn(),
    getCommunitySpace: vi.fn(),
    client: { createRecord: vi.fn(), addMember: vi.fn(), listRecords: vi.fn(), getRecord: vi.fn(), listRecordValues: vi.fn() },
  },
}));

vi.mock("./spaces", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getSpaceClient: mocks.getSpaceClient,
  getCommunitySpace: mocks.getCommunitySpace,
}));
vi.mock("./roles", () => ({ actorCan: vi.fn(async () => true) }));

import { recordMembership } from "./membership";

describe("recordMembership (post-shim)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getCommunitySpace.mockImplementation(async (_db: any, _did: string, kind: string) =>
      kind === "management" ? "ats://c/community.opensocial.management/m" : "ats://c/community.opensocial.posts/p",
    );
    mocks.getSpaceClient.mockResolvedValue(mocks.client);
    mocks.client.listRecordValues.mockResolvedValue([]); // empty roster
  });

  it("writes a membership record", async () => {
    await recordMembership({} as any, "did:plc:comm", "did:plc:new");
    expect(mocks.client.createRecord).toHaveBeenCalledWith(
      "ats://c/community.opensocial.management/m",
      "community.opensocial.membership",
      expect.objectContaining({ subject: "did:plc:new", status: "active" }),
    );
  });

  it("does NOT pre-materialize PDS member lists (no addMember)", async () => {
    await recordMembership({} as any, "did:plc:comm", "did:plc:new");
    expect(mocks.client.addMember).not.toHaveBeenCalled();
  });

  it("is idempotent for an existing subject", async () => {
    mocks.client.listRecordValues.mockResolvedValue([
      { rkey: "1", cid: "c", value: { subject: "did:plc:new", status: "active", joinedAt: "x" } },
    ]);
    await recordMembership({} as any, "did:plc:comm", "did:plc:new");
    expect(mocks.client.createRecord).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/services/membership.roster.test.ts`
Expected: FAIL — `addMember` IS called (the shim).

- [ ] **Step 3: Remove the shims in `src/services/membership.ts`**

- In `recordMembership`: delete the trailing shim block (the `// SHIM (delete when the protocol mint-callout lands)` comment, the `posts` addMember line, the `actorCan` lookup, and the `mgmt` addMember line — currently L296-304). Delete the now-unused `const posts = await getCommunitySpace(db, communityDid, "posts");` if nothing else uses it, and the `actorCan` import if unused.
- In `writeMembershipProof`: delete the `await client.addMember(space, memberDid).catch(() => {});` line (L153).
- Update the doc comment above `recordMembership` (L273-278): remove the "call after roles are assigned" ordering requirement, note that access is decided at credential-mint time via `checkUserAccess`.

- [ ] **Step 4: Run tests**

Run: `npx vitest run && npx tsc --noEmit`
Expected: all PASS; no unused-import errors.

- [ ] **Step 5: Commit**

```bash
git add src/services/membership.ts src/services/membership.roster.test.ts
git commit -m "feat: drop addMember pre-materialization shims; access now decided at mint time"
```

---

### Task 10: Devnet end-to-end verification

**Files:**
- Create: `test/devnet-spaces.test.ts`
- Modify: `package.json` if needed (test:devnet glob already covers `test/devnet-*.test.ts`)

**Interfaces:**
- Consumes: everything above, plus live infra. Seeded devnet accounts (from `scripts/seed-devenv-community.ts`): `democommunity.test`, `osadmin.test`, `osmember.test` (hardcoded dev passwords — read them from that script when writing assertions), plus dev-env's `alice.test` / password `alice-pass` (never a member).

- [ ] **Step 1: Boot the stack (three terminals, all Node 22)**

```bash
# 1. dev-env (atproto repo)
cd /Users/brittany/Documents/code/atproto && pnpm --filter @atproto/dev-env start:multi-pds
# 2. OpenSocial (this repo) — fresh DB, migrations, lexicons, seed, run
npm run db:reset && npm run migrate:devenv && npm run publish:lexicons && npm run seed:devenv && npm run dev:devnet
```

Note: `seed:devenv` calls `provisionCommunitySpaces`, which now creates the spaces with `policy=managing-app` (Task 6) — so the app must be seeded AFTER Tasks 1-9 land, and `.env.devnet` must have `OPENSOCIAL_SERVICE_DID` (Task 3).

- [ ] **Step 2: Write `test/devnet-spaces.test.ts`**

```ts
/**
 * Live devnet test: the full managing-app credential flow.
 * Prereqs: multi-pds dev-env up (:2581/:2582/:2583), opensocial running on :3001
 * with OPENSOCIAL_SERVICE_DID=did:web:localhost%3A3001, db seeded via seed:devenv.
 * Run: npm run test:devnet
 */
import { describe, it, expect, beforeAll } from "vitest";

const PDS = process.env.PDS_URL ?? "http://localhost:2583";
const APP = process.env.APP_URL ?? "http://localhost:3001";

// Keep in sync with scripts/seed-devenv-community.ts (lines 35-40):
const COMMUNITY = { handle: "democommunity.test" };
const MEMBER = { handle: "osmember.test", password: "member-devenv-pass" };
const NON_MEMBER = { handle: "alice.test", password: "alice-pass" };

async function createSession(identifier: string, password: string) {
  const res = await fetch(`${PDS}/xrpc/com.atproto.server.createSession`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ identifier, password }),
  });
  expect(res.ok).toBe(true);
  return res.json() as Promise<{ did: string; accessJwt: string }>;
}

async function mintCredential(session: { accessJwt: string }, space: string) {
  const tokenUrl = new URL(`${PDS}/xrpc/com.atproto.space.getDelegationToken`);
  tokenUrl.searchParams.set("space", space);
  const tokenRes = await fetch(tokenUrl, { headers: { authorization: `Bearer ${session.accessJwt}` } });
  if (!tokenRes.ok) return { ok: false as const, status: tokenRes.status, body: await tokenRes.text() };
  const { token } = await tokenRes.json();
  const credRes = await fetch(`${PDS}/xrpc/com.atproto.space.getSpaceCredential`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ space }),
  });
  if (!credRes.ok) return { ok: false as const, status: credRes.status, body: await credRes.text() };
  return { ok: true as const, ...(await credRes.json()) };
}

describe("devnet: managing-app credential flow", () => {
  let postsSpace: string;

  beforeAll(async () => {
    // did.json is served
    const didDoc = await fetch(`${APP}/.well-known/did.json`).then((r) => r.json());
    expect(didDoc.id).toBe("did:web:localhost%3A3001");
    // find the community's posts space via the PoC surface
    const communities = await fetch(`${APP}/api/poc/communities`).then((r) => r.json());
    const community = communities.find((c: any) => c.handle === COMMUNITY.handle) ?? communities[0];
    const spaces = await fetch(`${APP}/api/poc/communities/${community.did}/spaces`).then((r) => r.json());
    postsSpace = (spaces.find((s: any) => s.kind === "posts") ?? spaces[0]).space_uri ?? spaces[0].spaceUri;
    expect(postsSpace).toBeTruthy();
  });

  it("a member is authorized via checkUserAccess and receives a credential", async () => {
    const session = await createSession(MEMBER.handle, MEMBER.password);
    const result = await mintCredential(session, postsSpace);
    expect(result.ok).toBe(true);
  });

  it("a non-member is denied a credential", async () => {
    const session = await createSession(NON_MEMBER.handle, NON_MEMBER.password);
    const result = await mintCredential(session, postsSpace);
    expect(result.ok).toBe(false);
  });

  it("aggregated posts include member-authored posts (credential-based cross-repo read)", async () => {
    const communities = await fetch(`${APP}/api/poc/communities`).then((r) => r.json());
    const community = communities.find((c: any) => c.handle === COMMUNITY.handle) ?? communities[0];
    const posts = await fetch(`${APP}/api/poc/communities/${community.did}/posts`).then((r) => r.json());
    expect(Array.isArray(posts)).toBe(true);
    expect(posts.length).toBeGreaterThan(0);
  });
});
```

(Adapt the `/api/poc` response shapes to what the routes actually return — check `src/routes/poc.ts` GET handlers while writing.)

- [ ] **Step 3: Run the devnet suite**

Run: `npm run test:devnet`
Expected: PASS. If the member mint fails: check the opensocial logs for the inbound `checkUserAccess` call (it should show the PDS calling with service auth). Common failure points, in order: lexicons not published (`publish:lexicons`), `managingApp` did:web not resolving (is :3001 up? `curl http://localhost:3001/.well-known/did.json`), aud mismatch (OPENSOCIAL_SERVICE_DID env), stale spaces provisioned before Task 6 (re-run `db:reset`+`seed:devenv`), API shape drift (recheck the branch lexicon JSONs per Global Constraints).

- [ ] **Step 4: Full verification sweep**

Run: `npx vitest run && npx tsc --noEmit && npm run test:devnet`
Expected: everything green.

- [ ] **Step 5: Commit**

```bash
git add test/devnet-spaces.test.ts
git commit -m "test: devnet end-to-end managing-app credential flow"
```

---

## Out of scope (follow-up plans)

- Audit log into the management space (`auditLogEntry` records) — deferred by decision.
- open-social-web UI for spaces/roles/join-requests — separate plan.
- Typed `@atproto/lex` client — when branch packages are published (or if the repo converts to pnpm workspaces).
- Legacy `com.atproto.repo.*` joinCommunity/membershipProof XRPC surface — migrates with the Phase 2 contract.
- Full dual-system consolidation (legacy membershipProof path removal, Postgres role/permission tables demoted to cache) — depends on the legacy XRPC surface, so it lands with Phase 2.
- `blockedApps`/`appPermission` enforcement in `checkUserAccess` (`clientId` param is accepted but unused for now — client attestation is unverified on the branch anyway).

## Verification (definition of done)

1. `npx vitest run` — all unit tests pass.
2. `npx tsc --noEmit` — clean.
3. `npm run test:devnet` — live flow: member mints a credential through OpenSocial's `checkUserAccess`; non-member is denied; aggregated posts include member-authored records read cross-PDS with a credential.
4. Grep proves the shims are gone: `grep -rn "addMember" src/services/membership.ts` returns nothing.
