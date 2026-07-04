/**
 * Membership-proof storage for communities.
 *
 * A membership proof attests that a DID belongs to a community. This module is
 * the single place that decides WHERE that proof lives:
 *
 *   - If the community has a provisioned management space (see
 *     `services/spaces.ts`), the proof is a record in that permissioned space
 *     and the member is added to the space's member list.
 *   - Otherwise it falls back to the legacy location: a plain record in the
 *     community account's repo (com.atproto.repo.*).
 *
 * This lets existing communities (on PDSes without permissioned-data support)
 * keep working unchanged, while provisioned communities exercise the space
 * integration. The proof record shape is identical in both locations.
 */
import type { Kysely } from "kysely";
import type { Database } from "../db";
import { createCommunityAgent } from "./atproto";
import { getCommunitySpace, getSpaceClient } from "./spaces";

const MEMBERSHIP_PROOF = "community.opensocial.membershipProof";

interface ProofValue {
  memberDid: string;
  [k: string]: unknown;
}

/** rkey is the last path segment of a record (repo or space) URI. */
function rkeyOf(uri: string): string {
  return uri.split("/").pop()!;
}

/**
 * Fetch every membership-proof record from a permissioned space as
 * `{ rkey, value }`. com.atproto.space.listRecords returns only metadata
 * (collection/rkey/cid) with no value, so each rkey is hydrated via getRecord.
 */
async function listSpaceProofs(
  db: Kysely<Database>,
  communityDid: string,
  space: string,
): Promise<Array<{ rkey: string; value: ProofValue }>> {
  const client = await getSpaceClient(db, communityDid);
  const out: Array<{ rkey: string; value: ProofValue }> = [];
  let cursor: string | undefined;
  do {
    const { records, cursor: next } = await client.listRecords(
      space,
      MEMBERSHIP_PROOF,
      { limit: 100, cursor },
    );
    for (const ref of records) {
      const full = await client.getRecord<ProofValue>(
        space,
        MEMBERSHIP_PROOF,
        ref.rkey,
      );
      if (full?.value) out.push({ rkey: ref.rkey, value: full.value });
    }
    cursor = next;
  } while (cursor);
  return out;
}

/** Whether `memberDid` has a membership proof in `communityDid`. */
export async function hasMembershipProof(
  db: Kysely<Database>,
  communityDid: string,
  memberDid: string,
  communityAgent?: any,
): Promise<boolean> {
  const space = await getCommunitySpace(db, communityDid, "management");
  if (space) {
    const proofs = await listSpaceProofs(db, communityDid, space);
    return proofs.some((p) => p.value.memberDid === memberDid);
  }

  // Legacy: proofs live in the community account's repo.
  const agent =
    communityAgent ?? (await createCommunityAgent(db, communityDid));
  let cursor: string | undefined;
  do {
    const res = await agent.api.com.atproto.repo.listRecords({
      repo: communityDid,
      collection: MEMBERSHIP_PROOF,
      limit: 100,
      cursor,
    });
    if (res.data.records.some((r: any) => r.value.memberDid === memberDid)) {
      return true;
    }
    cursor = res.data.cursor;
  } while (cursor);
  return false;
}

/**
 * List membership-proof records (up to `max`) for a community, from the
 * management space when provisioned, else the legacy repo. Each entry exposes
 * `{ uri, value }` so callers can read `value.memberDid` / `value.confirmedAt`
 * and derive the rkey from `uri` — identical shape for both backends.
 */
export async function listMembershipProofs(
  db: Kysely<Database>,
  communityDid: string,
  max = 1000,
): Promise<Array<{ uri: string; value: any }>> {
  const out: Array<{ uri: string; value: any }> = [];

  const space = await getCommunitySpace(db, communityDid, "management");
  if (space) {
    const proofs = await listSpaceProofs(db, communityDid, space);
    return proofs.slice(0, max).map((p) => ({ uri: p.rkey, value: p.value }));
  }

  const agent = await createCommunityAgent(db, communityDid);
  let cursor: string | undefined;
  do {
    const res = await agent.api.com.atproto.repo.listRecords({
      repo: communityDid,
      collection: MEMBERSHIP_PROOF,
      limit: 100,
      cursor,
    });
    out.push(
      ...res.data.records.map((r: any) => ({ uri: r.uri, value: r.value })),
    );
    cursor = res.data.cursor;
  } while (cursor && out.length < max);
  return out;
}

/** Record a membership proof for `memberDid` in `communityDid`. */
export async function writeMembershipProof(
  db: Kysely<Database>,
  communityDid: string,
  memberDid: string,
  cid = "",
): Promise<void> {
  const record = {
    $type: MEMBERSHIP_PROOF,
    memberDid,
    cid,
    confirmedAt: new Date().toISOString(),
  };

  const space = await getCommunitySpace(db, communityDid, "management");
  if (space) {
    const client = await getSpaceClient(db, communityDid);
    await client.createRecord(space, MEMBERSHIP_PROOF, record);
    return;
  }

  const agent = await createCommunityAgent(db, communityDid);
  await agent.api.com.atproto.repo.createRecord({
    repo: communityDid,
    collection: MEMBERSHIP_PROOF,
    record,
  });
}

/** Remove `memberDid`'s membership proof. Returns true if one was found. */
export async function removeMembershipProof(
  db: Kysely<Database>,
  communityDid: string,
  memberDid: string,
): Promise<boolean> {
  const space = await getCommunitySpace(db, communityDid, "management");
  if (space) {
    const proofs = await listSpaceProofs(db, communityDid, space);
    const match = proofs.find((p) => p.value.memberDid === memberDid);
    if (!match) return false;
    const client = await getSpaceClient(db, communityDid);
    await client.deleteRecord(space, MEMBERSHIP_PROOF, match.rkey);
    return true;
  }

  const agent = await createCommunityAgent(db, communityDid);
  let cursor: string | undefined;
  let proof: any = null;
  do {
    const res = await agent.api.com.atproto.repo.listRecords({
      repo: communityDid,
      collection: MEMBERSHIP_PROOF,
      limit: 100,
      cursor,
    });
    proof = res.data.records.find((r: any) => r.value.memberDid === memberDid);
    cursor = res.data.cursor;
  } while (cursor && !proof);
  if (!proof) return false;
  await agent.api.com.atproto.repo.deleteRecord({
    repo: communityDid,
    collection: MEMBERSHIP_PROOF,
    rkey: rkeyOf(proof.uri),
  });
  return true;
}

// ─── Roster records (source of truth) ────────────────────────────────────────

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
 * Record a membership (source of truth). Access is decided at credential-mint
 * time via checkUserAccess; pre-materialization via space member lists is no
 * longer needed. Idempotent on subject.
 */
export async function recordMembership(
  db: Kysely<Database>,
  communityDid: string,
  subjectDid: string,
  opts: { approvedBy?: string } = {},
): Promise<void> {
  const mgmt = await managementSpaceUri(db, communityDid);
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
}
