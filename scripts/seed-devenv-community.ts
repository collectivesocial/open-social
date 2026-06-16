#!/usr/bin/env tsx
/**
 * Seed a community (and a test member) into the atproto **dev-env** for the
 * permissioned-spaces PoC.
 *
 * Unlike `seed-devnet-community.ts` (which reads accounts.json from the stock
 * `atproto-devnet` docker stack), this script targets the atproto repo's
 * `packages/dev-env` PDS — the one built from the `permissioned-data` branch,
 * which is the only local PDS that serves `com.atproto.space.*`. It:
 *
 *   1. Creates a community account + a test member account on the dev-env PDS
 *      (handle domain `.test`, no invite code required).
 *   2. Inserts the community (DID, handle, encrypted app password, pds_host)
 *      into open-social's `communities` table.
 *   3. Creates the community's profile + admins records in its repo.
 *
 * After this, run:  npm run migrate:up  →  npm run provision:spaces  →  join as
 * the member to watch a membershipProof land in the permissioned space.
 *
 * Requires .env.devnet (DATABASE_URL, ENCRYPTION_KEY, PDS_URL=http://localhost:2583).
 * Override handles with COMMUNITY_HANDLE / MEMBER_HANDLE if they already exist.
 */

import { BskyAgent } from "@atproto/api";
import { createDb } from "../src/db";
import { encrypt } from "../src/lib/crypto";
import { config } from "../src/config";

const COMMUNITY_HANDLE = process.env.COMMUNITY_HANDLE || "community.test";
const MEMBER_HANDLE = process.env.MEMBER_HANDLE || "member.test";
const COMMUNITY_PASSWORD = "community-devenv-pass";
const MEMBER_PASSWORD = "member-devenv-pass";

interface CreatedAccount {
  did: string;
  handle: string;
  password: string;
}

/** Create an account on the dev-env PDS. Returns its DID + login password. */
async function createAccount(
  pdsUrl: string,
  handle: string,
  password: string,
): Promise<CreatedAccount> {
  const agent = new BskyAgent({ service: pdsUrl });
  try {
    await agent.createAccount({
      handle,
      email: `${handle.replace(/\./g, "-")}@test.local`,
      password,
    });
  } catch (err: any) {
    const msg = err?.message ?? String(err);
    throw new Error(
      `Failed to create account "${handle}" on ${pdsUrl}: ${msg}\n` +
        "If the handle is taken, restart the dev-env (make run-dev-env) for a " +
        "clean slate, or pass COMMUNITY_HANDLE / MEMBER_HANDLE to use different handles.",
    );
  }
  const did = agent.session?.did;
  if (!did) throw new Error(`createAccount for ${handle} returned no DID`);
  return { did, handle, password };
}

async function main() {
  const pdsUrl = config.pdsUrl;
  if (!config.databaseUrl) {
    console.error("ERROR: DATABASE_URL is not set. Source .env.devnet first.");
    process.exit(1);
  }
  if (!pdsUrl || pdsUrl.includes("3002") || pdsUrl.includes("bsky.social")) {
    console.error(
      `ERROR: PDS_URL is "${pdsUrl}". This script needs the space-capable ` +
        "atproto dev-env PDS (http://localhost:2583). Set PDS_URL in .env.devnet " +
        "and make sure `make run-dev-env` is running in your atproto repo.",
    );
    process.exit(1);
  }

  console.log(`Dev-env PDS: ${pdsUrl}`);

  // 1. Create accounts on the dev-env PDS.
  console.log(`Creating community account (${COMMUNITY_HANDLE})...`);
  const community = await createAccount(
    pdsUrl,
    COMMUNITY_HANDLE,
    COMMUNITY_PASSWORD,
  );
  console.log(`  community DID: ${community.did}`);

  console.log(`Creating test member account (${MEMBER_HANDLE})...`);
  const member = await createAccount(pdsUrl, MEMBER_HANDLE, MEMBER_PASSWORD);
  console.log(`  member DID:    ${member.did}`);

  // 2. Mint an app password for the community so open-social can act as it.
  const communityAgent = new BskyAgent({ service: pdsUrl });
  await communityAgent.login({
    identifier: community.did,
    password: community.password,
  });
  const appPasswordRes =
    await communityAgent.com.atproto.server.createAppPassword({
      name: "open-social",
    });
  const appPassword = appPasswordRes.data.password;

  // 3. Upsert the community row in open-social's database.
  const db = createDb(config.databaseUrl);
  try {
    const existing = await db
      .selectFrom("communities")
      .select("did")
      .where("did", "=", community.did)
      .executeTakeFirst();

    if (existing) {
      console.log("Community already in DB — updating credentials.");
      await db
        .updateTable("communities")
        .set({
          handle: community.handle,
          display_name: COMMUNITY_HANDLE,
          pds_host: pdsUrl,
          app_password: encrypt(appPassword),
        })
        .where("did", "=", community.did)
        .execute();
    } else {
      console.log("Inserting community into DB...");
      await db
        .insertInto("communities")
        .values({
          did: community.did,
          handle: community.handle,
          display_name: COMMUNITY_HANDLE,
          pds_host: pdsUrl,
          app_password: encrypt(appPassword),
          created_at: new Date(),
        })
        .execute();
    }

    // 4. Create profile + admins records in the community's repo. The community
    //    is its own admin for the PoC; type `open` so joins are self-service.
    console.log("Creating profile + admins records...");
    await communityAgent.com.atproto.repo.putRecord({
      repo: community.did,
      collection: "community.opensocial.profile",
      rkey: "self",
      record: {
        $type: "community.opensocial.profile",
        displayName: COMMUNITY_HANDLE,
        description: "Dev-env PoC community (permissioned spaces)",
        type: "open",
        createdAt: new Date().toISOString(),
      },
    });
    await communityAgent.com.atproto.repo.putRecord({
      repo: community.did,
      collection: "community.opensocial.admins",
      rkey: "self",
      record: {
        $type: "community.opensocial.admins",
        admins: [{ did: community.did, addedAt: new Date().toISOString() }],
      },
    });
  } finally {
    await db.destroy();
  }

  console.log("\n✅ Seeded. Next steps:");
  console.log("   npm run migrate:up");
  console.log(`   npm run provision:spaces ${community.did}`);
  console.log(
    "   # then join as the member to land a proof in the management space:",
  );
  console.log(`   #   community DID: ${community.did}`);
  console.log(`   #   member DID:    ${member.did}`);
}

main().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
