/**
 * Smoke test: verify open-social works against a local atproto-devnet.
 *
 * Prerequisites:
 *   ./scripts/start-test-env.sh   (starts PDS, PLC, postgres, etc.)
 *   Start the app with the env vars printed by the script.
 *
 * This test:
 *   1. Seeds a test "app" directly in postgres (bypasses OAuth)
 *   2. Creates a community via the API using a devnet account
 *   3. Verifies the community appears in the API response
 *   4. Verifies the profile record landed on the devnet PDS
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "crypto";
import fs from "fs";
import pg from "pg";

// ---------------------------------------------------------------------------
// Config — all from env, matching what start-test-env.sh prints
// ---------------------------------------------------------------------------
const API_BASE = process.env.API_BASE ?? "http://localhost:3001";
const PDS_URL = process.env.PDS_URL ?? "http://localhost:4000";
const DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgresql://postgres:postgres@localhost:5433/opensocial";

// Path to the seeded accounts file written by devnet init container
const ACCOUNTS_PATH =
  process.env.ACCOUNTS_PATH ??
  new URL("../../atproto-devnet/data/accounts.json", import.meta.url).pathname;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface DevnetAccount {
  handle: string;
  did: string;
  password: string;
  email: string;
}

function hashApiKey(key: string): string {
  return crypto.createHash("sha256").update(key).digest("hex");
}

async function loadAccounts(): Promise<Record<string, DevnetAccount>> {
  if (!fs.existsSync(ACCOUNTS_PATH)) {
    throw new Error(
      `Accounts file not found: ${ACCOUNTS_PATH}\n` +
        'Run "npm run devnet:up" first, or set ACCOUNTS_PATH to the correct location.',
    );
  }
  return JSON.parse(fs.readFileSync(ACCOUNTS_PATH, "utf-8"));
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

// This suite targets the docker-based atproto-devnet stack (devnet:up), whose
// init container writes accounts.json. When that stack isn't running (e.g.
// only the atproto dev-env used by devnet-spaces.test.ts is up), skip with a
// clear reason instead of failing the whole test:devnet command.
const dockerDevnetUp = fs.existsSync(ACCOUNTS_PATH);

describe.skipIf(!dockerDevnetUp)("devnet smoke test", () => {
  let pool: pg.Pool;
  let accounts: Record<string, DevnetAccount>;
  const TEST_API_KEY = `osc_test_${crypto.randomBytes(16).toString("hex")}`;
  const TEST_APP_ID = `app_test_${crypto.randomBytes(8).toString("hex")}`;

  beforeAll(async () => {
    // Load devnet accounts (Alice, Bob)
    accounts = await loadAccounts();
    expect(accounts.ALICE).toBeDefined();

    // Connect to postgres and seed a test app so we can call the API
    pool = new pg.Pool({ connectionString: DATABASE_URL });

    await pool.query(
      `INSERT INTO apps (app_id, name, domain, creator_did, api_key, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, 'active', NOW(), NOW())
       ON CONFLICT (app_id) DO UPDATE SET updated_at = NOW()`,
      [
        TEST_APP_ID,
        "devnet-smoke-test",
        "test.opensocial.devnet",
        accounts.ALICE.did,
        hashApiKey(TEST_API_KEY),
      ],
    );
  });

  afterAll(async () => {
    // Clean up: remove the test app and any communities we created
    if (pool) {
      await pool.query(`DELETE FROM apps WHERE app_id = $1`, [TEST_APP_ID]);
      await pool.query(`DELETE FROM communities WHERE did = $1`, [
        accounts.ALICE.did,
      ]);
      await pool.end();
    }
  });

  it("health check returns ok", async () => {
    const res = await fetch(`${API_BASE}/health`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
  });

  it("creates a community and writes profile to PDS", async () => {
    const alice = accounts.ALICE;

    // --- Step 1: Create community via API ---
    const createRes = await fetch(`${API_BASE}/api/v1/communities`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Api-Key": TEST_API_KEY,
      },
      body: JSON.stringify({
        did: alice.did,
        appPassword: alice.password,
        displayName: "Devnet Smoke Test",
        creatorDid: alice.did,
        description: "Automated smoke test community",
      }),
    });

    expect(createRes.status).toBe(201);
    const created = await createRes.json();
    expect(created.community.did).toBe(alice.did);
    expect(created.community.displayName).toBe("Devnet Smoke Test");

    // --- Step 2: Verify community appears in list ---
    const listRes = await fetch(`${API_BASE}/api/v1/communities`, {
      headers: { "X-Api-Key": TEST_API_KEY },
    });
    expect(listRes.status).toBe(200);
    const listed = await listRes.json();
    const found = listed.communities.find((c: any) => c.did === alice.did);
    expect(found).toBeDefined();
    expect(found.displayName).toBe("Devnet Smoke Test");

    // --- Step 3: Verify profile record exists on PDS ---
    const pdsRes = await fetch(
      `${PDS_URL}/xrpc/com.atproto.repo.getRecord?` +
        new URLSearchParams({
          repo: alice.did,
          collection: "community.opensocial.profile",
          rkey: "self",
        }),
    );
    expect(pdsRes.status).toBe(200);
    const record = await pdsRes.json();
    expect(record.value.displayName).toBe("Devnet Smoke Test");
    expect(record.value.description).toBe("Automated smoke test community");
    expect(record.value.type).toBe("open");

    // --- Step 4: Verify admins record on PDS ---
    const adminsRes = await fetch(
      `${PDS_URL}/xrpc/com.atproto.repo.getRecord?` +
        new URLSearchParams({
          repo: alice.did,
          collection: "community.opensocial.admins",
          rkey: "self",
        }),
    );
    expect(adminsRes.status).toBe(200);
    const admins = await adminsRes.json();
    expect(admins.value.admins).toEqual(
      expect.arrayContaining([expect.objectContaining({ did: alice.did })]),
    );
  });
});
