#!/usr/bin/env tsx
/**
 * Seed a fully-configured community into the atproto **dev-env** for the
 * permissioned-spaces PoC, ready to experiment with role-gated posting.
 *
 * Targets the atproto repo's `packages/dev-env` PDS (built from the
 * `permissioned-data` branch — the only local PDS that serves
 * `com.atproto.space.*`). It:
 *
 *   1. Creates a community + admin + member account on the dev-env PDS.
 *   2. Inserts the community (encrypted app password) into open-social's DB and
 *      writes its profile + admins records.
 *   3. Provisions the community's management/content/posts permissioned spaces.
 *   4. Seeds governance into the MANAGEMENT space: role definitions
 *      (admin -> can "post"/"manage", member -> none) + role assignments, and
 *      membership proofs for both accounts.
 *
 * Run `npm run migrate:up` first. Then experiment via the open-social-web PoC
 * page or `npm run demo:membership`.
 *
 * Requires .env.devnet (DATABASE_URL, ENCRYPTION_KEY, PDS_URL=http://localhost:2583).
 */

import { BskyAgent } from "@atproto/api";
import { createDb } from "../src/db";
import { encrypt } from "../src/lib/crypto";
import { config } from "../src/config";
import { provisionCommunitySpaces } from "../src/services/spaces";
import { writeRoleDefinition, assignRole } from "../src/services/roles";
import { writeMembershipProof } from "../src/services/membership";

// First label must be 3-18 chars and not a reserved subdomain (the PDS reserves
// "community", "member", "admin", etc.), so use non-reserved handles.
const COMMUNITY_HANDLE = process.env.COMMUNITY_HANDLE || "democommunity.test";
const ADMIN_HANDLE = process.env.ADMIN_HANDLE || "osadmin.test";
const MEMBER_HANDLE = process.env.MEMBER_HANDLE || "osmember.test";
const COMMUNITY_PASSWORD = "community-devenv-pass";
const ADMIN_PASSWORD = "admin-devenv-pass";
const MEMBER_PASSWORD = "member-devenv-pass";

interface CreatedAccount {
  did: string;
  handle: string;
  password: string;
}

/** Create the account, or log into it if it already exists (idempotent re-runs). */
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
  } catch (createErr: any) {
    // Already exists from a prior run? Log in with the known dev password.
    try {
      await agent.login({ identifier: handle, password });
    } catch {
      const msg = createErr?.message ?? String(createErr);
      throw new Error(
        `Could not create or log into "${handle}" on ${pdsUrl}: ${msg}\n` +
          "If the dev-env was restarted, the account is gone — that's fine. If a " +
          "handle is taken with a different password, override the *_HANDLE env var.",
      );
    }
  }
  const did = agent.session?.did;
  if (!did) throw new Error(`account ${handle} returned no DID`);
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

  // 1. Create accounts.
  console.log("Creating accounts...");
  const community = await createAccount(
    pdsUrl,
    COMMUNITY_HANDLE,
    COMMUNITY_PASSWORD,
  );
  const admin = await createAccount(pdsUrl, ADMIN_HANDLE, ADMIN_PASSWORD);
  const member = await createAccount(pdsUrl, MEMBER_HANDLE, MEMBER_PASSWORD);
  console.log(`  community: ${community.handle}  ${community.did}`);
  console.log(`  admin:     ${admin.handle}  ${admin.did}`);
  console.log(`  member:    ${member.handle}  ${member.did}`);

  // 2. App password for the community so open-social can act as it.
  const communityAgent = new BskyAgent({ service: pdsUrl });
  await communityAgent.login({
    identifier: community.did,
    password: community.password,
  });
  // Unique name so re-runs don't 500 on a duplicate app-password name.
  const appPassword = (
    await communityAgent.com.atproto.server.createAppPassword({
      name: `open-social-${Date.now()}`,
    })
  ).data.password;

  const db = createDb(config.databaseUrl);
  try {
    // 3. Upsert community row.
    const existing = await db
      .selectFrom("communities")
      .select("did")
      .where("did", "=", community.did)
      .executeTakeFirst();
    const row = {
      handle: community.handle,
      display_name: COMMUNITY_HANDLE,
      pds_host: pdsUrl,
      app_password: encrypt(appPassword),
    };
    if (existing) {
      await db
        .updateTable("communities")
        .set(row)
        .where("did", "=", community.did)
        .execute();
    } else {
      await db
        .insertInto("communities")
        .values({ did: community.did, ...row, created_at: new Date() })
        .execute();
    }

    // 4. Profile + admins records (admin account is the community admin).
    console.log("Writing profile + admins records...");
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
        admins: [{ did: admin.did, addedAt: new Date().toISOString() }],
      },
    });

    // 5. Provision the permissioned spaces (management/content/posts).
    console.log("Provisioning permissioned spaces (slow first login ~20s)...");
    const spaces = await provisionCommunitySpaces(db, community.did);
    console.log(`  management: ${spaces.management}`);
    console.log(`  posts:      ${spaces.posts}`);

    // 6. Seed governance into the management space: roles + assignments.
    console.log(
      "Seeding roles + assignments + memberships in the management space...",
    );
    await writeRoleDefinition(db, community.did, "admin", "Administrator", [
      "post",
      "manage",
    ]);
    await writeRoleDefinition(db, community.did, "member", "Member", []);
    await assignRole(db, community.did, admin.did, "admin", community.did);
    await assignRole(db, community.did, member.did, "member", community.did);

    // Both accounts are members (proof + space membership).
    await writeMembershipProof(db, community.did, admin.did);
    await writeMembershipProof(db, community.did, member.did);
  } finally {
    await db.destroy();
  }

  console.log("\n✅ Seeded. Experiment with:");
  console.log("   - open-social-web PoC page (act as admin vs member), or");
  console.log(`   - npm run demo:membership ${community.did} ${member.did}`);
  console.log("\nAccounts (handle / password / did):");
  console.log(
    `   community  ${community.handle}  ${COMMUNITY_PASSWORD}  ${community.did}`,
  );
  console.log(
    `   admin      ${admin.handle}  ${ADMIN_PASSWORD}  ${admin.did}  [can post]`,
  );
  console.log(
    `   member     ${member.handle}  ${MEMBER_PASSWORD}  ${member.did}  [cannot post]`,
  );
}

main().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
