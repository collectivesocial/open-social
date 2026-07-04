#!/usr/bin/env tsx
/**
 * Demonstrate the permissioned-spaces membership lifecycle for the PoC.
 *
 * Exercises the membership service end-to-end and prints where the proof lives,
 * so you can see it land in (and leave) the community's management space:
 *
 *   write proof -> is-member? -> list proofs -> space member list -> remove -> is-member?
 *
 * Usage (DIDs are printed by `npm run seed:devenv`):
 *   npm run demo:membership <communityDid> <memberDid>
 *
 * Requires .env.devnet sourced and the atproto dev-env running (PDS 2583).
 */

import { createDb } from "../src/db";
import { config } from "../src/config";
import {
  writeMembershipProof,
  hasMembershipProof,
  listMembershipProofs,
  removeMembershipProof,
} from "../src/services/membership";
import { getCommunitySpace } from "../src/services/spaces";

async function main() {
  const communityDid = process.argv[2];
  const memberDid = process.argv[3];
  if (!communityDid || !memberDid) {
    console.error(
      "Usage: npm run demo:membership <communityDid> <memberDid>\n" +
        "(both DIDs are printed by `npm run seed:devenv`)",
    );
    process.exit(1);
  }

  const db = createDb(config.databaseUrl);
  try {
    const space = await getCommunitySpace(db, communityDid, "management");
    console.log(
      space
        ? `Backing store: MANAGEMENT SPACE ${space}`
        : "Backing store: legacy community repo (community not provisioned with spaces)",
    );

    console.log(`\n1. writeMembershipProof(${memberDid})`);
    await writeMembershipProof(db, communityDid, memberDid);

    console.log(
      "2. hasMembershipProof ->",
      await hasMembershipProof(db, communityDid, memberDid),
    );

    const proofs = await listMembershipProofs(db, communityDid);
    console.log(
      "3. listMembershipProofs ->",
      JSON.stringify(proofs.map((p) => p.value.memberDid)),
    );

    if (space) {
      // Space member lists (com.atproto.simplespace.listMembers) are no longer
      // pre-materialized — recordMembership doesn't call addMember. Access is
      // decided at credential-mint time via checkUserAccess against the
      // membership/roles records above, not a static member list.
      console.log(
        "4. space member list -> skipped (access is decided at credential-mint " +
          "time via checkUserAccess, not a pre-materialized member list)",
      );
    }

    console.log(
      "5. removeMembershipProof ->",
      await removeMembershipProof(db, communityDid, memberDid),
    );
    console.log(
      "6. hasMembershipProof after remove ->",
      await hasMembershipProof(db, communityDid, memberDid),
    );
  } finally {
    await db.destroy();
  }
}

main().catch((err) => {
  console.error("demo failed:", String(err));
  process.exit(1);
});
