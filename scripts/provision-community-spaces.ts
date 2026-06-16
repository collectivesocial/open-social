#!/usr/bin/env tsx
/**
 * Provision permissioned spaces (management + content) for a community.
 *
 * This is the explicit opt-in that "enables permissioned spaces" for a
 * community in the PoC. Once provisioned, membership proofs (and, later,
 * governance + shared content) for that community are read/written in the
 * permissioned space rather than the community account's plain repo.
 *
 * The community account's PDS must support com.atproto.space.* (the atproto
 * `permissioned-data` branch — e.g. the devnet PDS). Production PDSes will 404.
 *
 * Usage:
 *   npx tsx scripts/provision-community-spaces.ts <communityDid>
 *   npx tsx scripts/provision-community-spaces.ts        # devnet COMMUNITY
 *
 * Requires DATABASE_URL / ENCRYPTION_KEY / PDS_URL in the environment
 * (e.g. source .env.devnet first).
 */

import fs from "node:fs";
import path from "node:path";
import { createDb } from "../src/db";
import { config } from "../src/config";
import { provisionCommunitySpaces } from "../src/services/spaces";

const ACCOUNTS_PATH = path.resolve(
  __dirname,
  "../../atproto-devnet/data/accounts.json",
);

function resolveDid(): string {
  const arg = process.argv[2];
  if (arg) return arg;
  if (fs.existsSync(ACCOUNTS_PATH)) {
    const accounts = JSON.parse(fs.readFileSync(ACCOUNTS_PATH, "utf-8"));
    if (accounts.COMMUNITY?.did) return accounts.COMMUNITY.did;
  }
  console.error(
    "Usage: provision-community-spaces.ts <communityDid>\n" +
      '(or run "npm run devnet:up" + "npm run seed:devnet" to use the devnet COMMUNITY)',
  );
  process.exit(1);
}

async function main() {
  if (!config.databaseUrl) {
    console.error("ERROR: DATABASE_URL is not set.");
    process.exit(1);
  }

  const did = resolveDid();
  const db = createDb(config.databaseUrl);
  try {
    console.log(`Provisioning permissioned spaces for ${did}...`);
    const spaces = await provisionCommunitySpaces(db, did);
    console.log("Provisioned:");
    console.log(`  management: ${spaces.management}`);
    console.log(`  content:    ${spaces.content}`);
  } finally {
    await db.destroy();
  }
}

main().catch((err) => {
  console.error("Provisioning failed:", err);
  process.exit(1);
});
