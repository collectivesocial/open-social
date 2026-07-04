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
const MEMBER = { handle: "osmember.test", password: "member-devenv-pass" };
// alice.test is seeded by the atproto dev-env itself (bin-multi-pds.ts) and is
// never added to the community's roster, so it's a reliable non-member.
const NON_MEMBER = { handle: "alice.test", password: "alice-pass" };

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

describe("devnet: managing-app credential flow", () => {
  let communityDid: string;
  let postsSpace: string;

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
    const postsSpaceRow =
      spaces.find((s: { kind: string }) => s.kind === "posts") ?? spaces[0];
    postsSpace = postsSpaceRow.space_uri;
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
    const posts = await fetch(
      `${APP}/api/poc/communities/${encodeURIComponent(communityDid)}/posts`,
    ).then((r) => r.json().then((body) => body.posts));
    expect(Array.isArray(posts)).toBe(true);
    expect(posts.length).toBeGreaterThan(0);
  });
});
