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

/** Whether `memberDid` has a membership proof in `communityDid`. */
export async function hasMembershipProof(
  db: Kysely<Database>,
  communityDid: string,
  memberDid: string,
  communityAgent?: any,
): Promise<boolean> {
  const space = await getCommunitySpace(db, communityDid, "management");
  if (space) {
    const client = await getSpaceClient(db, communityDid);
    let cursor: string | undefined;
    do {
      const { records, cursor: next } = await client.listRecords<ProofValue>(
        space,
        MEMBERSHIP_PROOF,
        { limit: 100, cursor },
      );
      if (records.some((r) => r.value.memberDid === memberDid)) return true;
      cursor = next;
    } while (cursor);
    return false;
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
    const client = await getSpaceClient(db, communityDid);
    let cursor: string | undefined;
    do {
      const { records, cursor: next } = await client.listRecords<ProofValue>(
        space,
        MEMBERSHIP_PROOF,
        { limit: 100, cursor },
      );
      out.push(...records.map((r) => ({ uri: r.uri, value: r.value })));
      cursor = next;
    } while (cursor && out.length < max);
    return out;
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
    // Grant the member access to the permissioned space, then record the proof.
    await client.addMember(space, memberDid).catch(() => {});
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
    const client = await getSpaceClient(db, communityDid);
    let cursor: string | undefined;
    do {
      const { records, cursor: next } = await client.listRecords<ProofValue>(
        space,
        MEMBERSHIP_PROOF,
        { limit: 100, cursor },
      );
      const match = records.find((r) => r.value.memberDid === memberDid);
      if (match) {
        await client.deleteRecord(space, MEMBERSHIP_PROOF, rkeyOf(match.uri));
        return true;
      }
      cursor = next;
    } while (cursor);
    return false;
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
