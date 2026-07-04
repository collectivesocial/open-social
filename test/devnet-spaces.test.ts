/**
 * Live devnet test: the full managing-app credential flow.
 *
 * Prereqs:
 *   - atproto repo's multi-pds dev-env up (:2581 introspect, :2582 PLC, :2583 primary PDS)
 *     `pnpm --filter @atproto/dev-env start:multi-pds` from the atproto repo.
 *   - open-social running on :3001 against the devnet DB, with
 *     OPENSOCIAL_SERVICE_DID=did:web:localhost%3A3001 (see .env.devnet), DB migrated
 *     (`migrate:devenv`), lexicons published (`publish:lexicons`), and community seeded
 *     (`seed:devenv`, which runs scripts/seed-devenv-community.ts).
 *
 * Run: npm run test:devnet
 */
import { describe, it, expect, beforeAll } from "vitest";

const PDS = process.env.PDS_URL ?? "http://localhost:2583";
const APP = process.env.APP_URL ?? "http://localhost:3001";

// Keep in sync with scripts/seed-devenv-community.ts:
const COMMUNITY = { handle: "democommunity.test" };
const ADMIN = { handle: "osadmin.test", password: "admin-devenv-pass" };
const MEMBER = { handle: "osmember.test", password: "member-devenv-pass" };
// alice.test is seeded by the atproto dev-env itself (bin-multi-pds.ts) and is
// never added to the community's roster, so it's a reliable non-member.
const NON_MEMBER = { handle: "alice.test", password: "alice-pass" };

// Keep in sync with the AuditAction union in src/services/auditLog.ts — used
// only to confirm a live record's `value.action` is a real audit action, not
// to exhaustively validate every possible action.
const KNOWN_AUDIT_ACTIONS = [
  "member.joined",
  "member.approved",
  "member.rejected",
  "member.removed",
  "member.left",
  "admin.promoted",
  "admin.demoted",
  "admin.transferred",
  "community.created",
  "community.deleted",
  "community.updated",
  "banner.uploaded",
  "avatar.uploaded",
  "settings.updated",
  "app.visibility.enabled",
  "app.visibility.disabled",
  "app.visibility.pending",
  "collection.permission.updated",
  "collection.permission.deleted",
  "role.created",
  "role.updated",
  "role.deleted",
  "role.assigned",
  "role.revoked",
  "hierarchy.requested",
  "hierarchy.invited",
  "hierarchy.approved",
  "hierarchy.accepted",
  "hierarchy.rejected",
  "hierarchy.revoked",
];

async function createSession(
  identifier: string,
  password: string,
): Promise<{ did: string; accessJwt: string }> {
  const res = await fetch(`${PDS}/xrpc/com.atproto.server.createSession`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ identifier, password }),
  });
  expect(res.ok).toBe(true);
  return res.json() as Promise<{ did: string; accessJwt: string }>;
}

type MintResult =
  | { ok: true; credential: string }
  | { ok: false; status: number; body: string };

async function mintCredential(
  session: { accessJwt: string },
  space: string,
): Promise<MintResult> {
  const tokenUrl = new URL(`${PDS}/xrpc/com.atproto.space.getDelegationToken`);
  tokenUrl.searchParams.set("space", space);
  const tokenRes = await fetch(tokenUrl, {
    headers: { authorization: `Bearer ${session.accessJwt}` },
  });
  if (!tokenRes.ok) {
    return { ok: false, status: tokenRes.status, body: await tokenRes.text() };
  }
  const { token } = await tokenRes.json();

  const credRes = await fetch(
    `${PDS}/xrpc/com.atproto.space.getSpaceCredential`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ space }),
    },
  );
  if (!credRes.ok) {
    return { ok: false, status: credRes.status, body: await credRes.text() };
  }
  const { credential } = await credRes.json();
  return { ok: true, credential };
}

async function fetchCommunities(): Promise<
  Array<{ did: string; handle: string; display_name: string }>
> {
  const { communities } = await fetch(`${APP}/api/poc/communities/`).then((r) =>
    r.json(),
  );
  return communities;
}

async function resolveHandleToDid(handle: string): Promise<string> {
  const url = new URL(`${PDS}/xrpc/com.atproto.identity.resolveHandle`);
  url.searchParams.set("handle", handle);
  const res = await fetch(url);
  expect(res.ok).toBe(true);
  const { did } = await res.json();
  return did;
}

// Shared across both describe blocks below (populated in the first
// describe's beforeAll, which runs before either describe's tests since
// vitest executes top-level describes in file order).
let communityDid: string;
let managementSpace: string;

describe("devnet: managing-app credential flow", () => {
  let postsSpace: string;
  let memberDid: string;

  beforeAll(async () => {
    // did.json is served, identifying OpenSocial as the managing app.
    const didDoc = await fetch(`${APP}/.well-known/did.json`).then((r) =>
      r.json(),
    );
    expect(didDoc.id).toBe("did:web:localhost%3A3001");

    // Find the seeded community and its posts space via the PoC surface.
    const communities = await fetchCommunities();
    const community =
      communities.find((c) => c.handle === COMMUNITY.handle) ?? communities[0];
    expect(community).toBeTruthy();
    communityDid = community.did;

    const { spaces } = await fetch(
      `${APP}/api/poc/communities/${encodeURIComponent(communityDid)}/spaces`,
    ).then((r) => r.json());
    const postsSpaceRow = spaces.find(
      (s: { kind: string }) => s.kind === "posts",
    );
    if (!postsSpaceRow) {
      throw new Error(
        `No space with kind "posts" for ${communityDid} — re-run seed:devenv. ` +
          `Got: ${JSON.stringify(spaces)}`,
      );
    }
    postsSpace = postsSpaceRow.space_uri;
    expect(postsSpace).toBeTruthy();

    const managementSpaceRow = spaces.find(
      (s: { kind: string }) => s.kind === "management",
    );
    if (!managementSpaceRow) {
      throw new Error(
        `No space with kind "management" for ${communityDid} — re-run seed:devenv. ` +
          `Got: ${JSON.stringify(spaces)}`,
      );
    }
    managementSpace = managementSpaceRow.space_uri;
    expect(managementSpace).toBeTruthy();

    // Resolve the seeded member's DID so the aggregated-posts assertion below
    // can check that a member-authored (cross-repo) post actually made it into
    // the feed, not just that the feed is non-empty.
    memberDid = await resolveHandleToDid(MEMBER.handle);
    expect(memberDid).toBeTruthy();
  });

  it("a member is authorized via checkUserAccess and receives a credential", async () => {
    const session = await createSession(MEMBER.handle, MEMBER.password);
    const result = await mintCredential(session, postsSpace);
    expect(result.ok, `mint failed: ${JSON.stringify(result)}`).toBe(true);
    if (result.ok) {
      // A real space-credential JWT, not just any truthy body.
      expect(typeof result.credential).toBe("string");
      expect(result.credential.length).toBeGreaterThan(0);
    }
  });

  it("a non-member is denied a credential", async () => {
    const session = await createSession(NON_MEMBER.handle, NON_MEMBER.password);
    const result = await mintCredential(session, postsSpace);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // The specific managing-app denial from the PDS — not just any failure
      // (a 500 from a broken flow must not pass this test).
      expect(result.status).toBe(400);
      expect(result.body).toMatch(/UserNotAuthorized/);
    }
  });

  it("aggregated posts include member-authored posts (credential-based cross-repo read)", async () => {
    const posts = await fetch(
      `${APP}/api/poc/communities/${encodeURIComponent(communityDid)}/posts`,
    ).then((r) => r.json().then((body) => body.posts));
    expect(Array.isArray(posts)).toBe(true);
    expect(posts.length).toBeGreaterThan(0);
    // Not just non-empty: a real cross-repo read landed a post actually
    // authored by the seeded member (read from the member's own PDS via a
    // space credential), not only the community's own posts.
    expect(posts.some((p: { author: string }) => p.author === memberDid)).toBe(
      true,
    );
  });
});

describe("devnet: management-space audit entries", () => {
  it("an admin mints a management-space credential and reads auditLogEntry records", async () => {
    const session = await createSession(ADMIN.handle, ADMIN.password);
    const result = await mintCredential(session, managementSpace);
    expect(result.ok, `mint failed: ${JSON.stringify(result)}`).toBe(true);
    if (!result.ok) return;

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

    // Unlike the SpaceClient wrapper's own listRecords (which only fetches
    // {collection, rkey, cid} and hydrates values via a separate getRecord
    // call), the raw com.atproto.space.listRecords response observed live
    // against the devnet PDS inlines the full record `value` on each entry —
    // so we can assert directly on it without a follow-up getRecord round trip.
    const record = body.records[0];
    expect(record.value).toBeTruthy();
    expect(record.value.$type).toBe("community.opensocial.auditLogEntry");
    expect(KNOWN_AUDIT_ACTIONS).toContain(record.value.action);
  });

  it("a non-admin member is denied a management-space credential", async () => {
    const session = await createSession(MEMBER.handle, MEMBER.password);
    const result = await mintCredential(session, managementSpace);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(400);
      expect(result.body).toMatch(/UserNotAuthorized/);
    }
  });
});
