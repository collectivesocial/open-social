/**
 * Cirrus PDS provisioning orchestrator.
 *
 * Coordinates the end-to-end flow of creating a new community with
 * its own Cirrus PDS on Cloudflare Workers:
 *   1. Validate the community name
 *   2. Generate cryptographic secrets
 *   3. Create R2 bucket + deploy Worker
 *   4. Set secrets on the Worker
 *   5. Bind custom domain
 *   6. Create an app password on the new PDS
 *   7. Store everything in the database
 *
 * On failure, partially-created resources are cleaned up.
 */

import fs from 'fs';
import type { Kysely } from 'kysely';
import type { Database } from '../db';
import { config } from '../config';
import { encrypt } from '../lib/crypto';
import { logger } from '../lib/logger';
import { generateCirrusSecrets } from './cirrus-keys';
import { storeSecrets, deleteSecrets, type SecretEntry } from './secret-store';
import {
  createR2Bucket,
  deployWorker,
  setWorkerSecrets,
  createWorkerCustomDomain,
  checkWorkerHealth,
  deleteWorker,
  deleteR2Bucket,
  type WorkerVars,
  type WorkerSecrets,
} from './cloudflare';

// ─── Types ───────────────────────────────────────────────────────────

export interface ProvisionResult {
  did: string;
  handle: string;
  hostname: string;
  pdsHost: string;
  appPassword: string;
}

export interface ProvisionOptions {
  /** Community subdomain name (e.g. "movieclub") */
  communityName: string;
  /** Display name for the community */
  displayName: string;
  /** DID of the user creating the community */
  creatorDid: string;
  /** Optional description */
  description?: string;
  /** Optional custom domain (overrides default subdomain) */
  customDomain?: string;
}

// ─── Validation ──────────────────────────────────────────────────────

const COMMUNITY_NAME_REGEX = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;

/**
 * Validate that a community name is suitable as a subdomain.
 */
export function validateCommunityName(name: string): { valid: boolean; error?: string } {
  if (!name) {
    return { valid: false, error: 'Community name is required' };
  }
  if (name.length < 3) {
    return { valid: false, error: 'Community name must be at least 3 characters' };
  }
  if (name.length > 63) {
    return { valid: false, error: 'Community name must be at most 63 characters' };
  }
  if (!COMMUNITY_NAME_REGEX.test(name)) {
    return {
      valid: false,
      error: 'Community name must be lowercase alphanumeric with hyphens, cannot start/end with a hyphen',
    };
  }
  return { valid: true };
}

/**
 * Check if a community name (as a Worker script name) is already taken.
 */
async function isNameAvailable(
  db: Kysely<Database>,
  communityName: string,
  baseDomain: string,
): Promise<boolean> {
  const hostname = `${communityName}.${baseDomain}`;
  const did = `did:web:${hostname}`;

  const existing = await db
    .selectFrom('communities')
    .select('did')
    .where('did', '=', did)
    .executeTakeFirst();

  return !existing;
}

// ─── Main provisioning flow ──────────────────────────────────────────

/**
 * Provision a new Cirrus PDS for a community.
 *
 * This is the primary entry point called from community creation routes
 * when mode === 'create-new'.
 */
export async function provisionCommunityPds(
  db: Kysely<Database>,
  options: ProvisionOptions,
): Promise<ProvisionResult> {
  const { communityName, displayName, creatorDid, description } = options;
  const baseDomain = config.communityDomain;

  // ── Step 1: Validate ──────────────────────────────────────────────
  const validation = validateCommunityName(communityName);
  if (!validation.valid) {
    throw new Error(validation.error);
  }

  const available = await isNameAvailable(db, communityName, baseDomain);
  if (!available) {
    throw new Error(`Community name "${communityName}" is already taken`);
  }

  // ── Step 2: Generate secrets ──────────────────────────────────────
  const secrets = await generateCirrusSecrets(communityName, baseDomain);
  const workerName = `pds-${communityName}`;
  const r2BucketName = `pds-${communityName}-blobs`;
  const pdsHost = `https://${secrets.hostname}`;

  logger.info(
    { communityName, did: secrets.did, workerName },
    'Starting Cirrus PDS provisioning',
  );

  // ── Step 3: Insert community row (status: provisioning) ───────────
  try {
    await db
      .insertInto('communities')
      .values({
        did: secrets.did,
        handle: secrets.handle,
        display_name: displayName,
        pds_host: pdsHost,
        app_password: encrypt(secrets.accountPassword), // Temporary — will be replaced with app password
        pds_type: 'cirrus',
        worker_name: workerName,
        r2_bucket_name: r2BucketName,
        provisioning_status: 'provisioning',
        description: description || null,
        avatar_url: null,
        community_type: null,
        member_count: null,
        metadata_fetched_at: null,
        provisioned_at: null,
      })
      .execute();
  } catch (err: any) {
    if (err.code === '23505') {
      // Unique constraint violation
      throw new Error(`Community with DID ${secrets.did} already exists`);
    }
    throw err;
  }

  // ── Step 4: Store secrets in community_secrets table ──────────────
  try {
    const secretEntries: SecretEntry[] = [
      { name: 'signing_key', value: secrets.signingKeyPrivate },
      { name: 'signing_key_public', value: secrets.signingKeyPublic },
      { name: 'auth_token', value: secrets.authToken },
      { name: 'jwt_secret', value: secrets.jwtSecret },
      { name: 'password_hash', value: secrets.passwordHash },
      { name: 'account_password', value: secrets.accountPassword },
    ];
    await storeSecrets(db, secrets.did, secretEntries);
  } catch (err) {
    logger.error({ error: err, did: secrets.did }, 'Failed to store secrets');
    await rollback(db, secrets.did, null, null);
    throw err;
  }

  // ── Step 5: Create R2 bucket ──────────────────────────────────────
  try {
    await createR2Bucket(r2BucketName);
  } catch (err) {
    logger.error({ error: err, r2BucketName }, 'Failed to create R2 bucket');
    await rollback(db, secrets.did, null, null);
    throw err;
  }

  // ── Step 6: Deploy Worker ─────────────────────────────────────────
  try {
    const workerModule = loadWorkerBundle();

    const workerVars: WorkerVars = {
      PDS_HOSTNAME: secrets.hostname,
      DID: secrets.did,
      HANDLE: secrets.handle,
      SIGNING_KEY_PUBLIC: secrets.signingKeyPublic,
      INITIAL_ACTIVE: 'true',
    };

    await deployWorker(workerName, workerModule, r2BucketName, workerVars);
  } catch (err) {
    logger.error({ error: err, workerName }, 'Failed to deploy Worker');
    await rollback(db, secrets.did, null, r2BucketName);
    throw err;
  }

  // ── Step 7: Set Worker secrets ────────────────────────────────────
  try {
    const workerSecrets: WorkerSecrets = {
      AUTH_TOKEN: secrets.authToken,
      SIGNING_KEY: secrets.signingKeyPrivate,
      JWT_SECRET: secrets.jwtSecret,
      PASSWORD_HASH: secrets.passwordHash,
    };

    await setWorkerSecrets(workerName, workerSecrets);
  } catch (err) {
    logger.error({ error: err, workerName }, 'Failed to set Worker secrets');
    await rollback(db, secrets.did, workerName, r2BucketName);
    throw err;
  }

  // ── Step 8: Bind custom domain ────────────────────────────────────
  try {
    await createWorkerCustomDomain(workerName, secrets.hostname);
  } catch (err) {
    logger.error({ error: err, hostname: secrets.hostname }, 'Failed to bind custom domain');
    await rollback(db, secrets.did, workerName, r2BucketName);
    throw err;
  }

  // ── Step 9: Health check ──────────────────────────────────────────
  // Give the Worker a moment to propagate, then check health
  let healthy = false;
  for (let attempt = 0; attempt < 5; attempt++) {
    await sleep(3000);
    healthy = await checkWorkerHealth(secrets.hostname);
    if (healthy) break;
    logger.info(
      { hostname: secrets.hostname, attempt: attempt + 1 },
      'Worker not yet healthy, retrying...',
    );
  }

  if (!healthy) {
    logger.warn(
      { hostname: secrets.hostname },
      'Worker health check failed after retries — proceeding anyway (may need DNS propagation)',
    );
  }

  // ── Step 10: Create app password on the new PDS ───────────────────
  let appPassword = secrets.accountPassword;
  try {
    // Authenticate with the Cirrus PDS using the account password
    const sessionRes = await fetch(`${pdsHost}/xrpc/com.atproto.server.createSession`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        identifier: secrets.did,
        password: secrets.accountPassword,
      }),
    });

    if (sessionRes.ok) {
      const session = await sessionRes.json() as { accessJwt: string };

      // Create an app password for Open Social to use
      const appPwRes = await fetch(`${pdsHost}/xrpc/com.atproto.server.createAppPassword`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.accessJwt}`,
        },
        body: JSON.stringify({ name: 'open-social' }),
      });

      if (appPwRes.ok) {
        const appPwData = await appPwRes.json() as { password: string };
        appPassword = appPwData.password;

        // Store the app password in community_secrets
        await storeSecrets(db, secrets.did, [
          { name: 'app_password', value: appPassword },
        ]);
      } else {
        logger.warn(
          { did: secrets.did, status: appPwRes.status },
          'Could not create app password on Cirrus PDS — using account password',
        );
      }
    } else {
      logger.warn(
        { did: secrets.did, status: sessionRes.status },
        'Could not create session on Cirrus PDS — using account password',
      );
    }
  } catch (err) {
    logger.warn(
      { error: err, did: secrets.did },
      'App password creation failed — using account password as fallback',
    );
  }

  // ── Step 11: Update community row to active ───────────────────────
  await db
    .updateTable('communities')
    .set({
      app_password: encrypt(appPassword),
      provisioning_status: 'active',
      provisioned_at: new Date(),
    })
    .where('did', '=', secrets.did)
    .execute();

  logger.info(
    { did: secrets.did, hostname: secrets.hostname, workerName },
    'Cirrus PDS provisioning complete',
  );

  return {
    did: secrets.did,
    handle: secrets.handle,
    hostname: secrets.hostname,
    pdsHost,
    appPassword,
  };
}

// ─── Deprovisioning ──────────────────────────────────────────────────

/**
 * Deprovision a Cirrus PDS for a community.
 * Deletes the Worker, R2 bucket, and secrets.
 */
export async function deprovisionCommunityPds(
  db: Kysely<Database>,
  communityDid: string,
): Promise<void> {
  const community = await db
    .selectFrom('communities')
    .select(['worker_name', 'r2_bucket_name', 'pds_type'])
    .where('did', '=', communityDid)
    .executeTakeFirst();

  if (!community || community.pds_type !== 'cirrus') {
    logger.info({ communityDid }, 'Not a Cirrus community, skipping deprovisioning');
    return;
  }

  logger.info({ communityDid }, 'Deprovisioning Cirrus PDS');

  await db
    .updateTable('communities')
    .set({ provisioning_status: 'deprovisioning' })
    .where('did', '=', communityDid)
    .execute();

  // Delete Worker
  if (community.worker_name) {
    await deleteWorker(community.worker_name);
  }

  // Delete R2 bucket
  if (community.r2_bucket_name) {
    await deleteR2Bucket(community.r2_bucket_name);
  }

  // Delete secrets
  await deleteSecrets(db, communityDid);

  logger.info({ communityDid }, 'Cirrus PDS deprovisioned');
}

// ─── Helpers ─────────────────────────────────────────────────────────

/**
 * Load the pre-built Cirrus worker bundle from disk.
 */
function loadWorkerBundle(): string {
  const bundlePath = config.cirrusWorkerBundlePath;
  if (!bundlePath) {
    throw new Error(
      'CIRRUS_WORKER_BUNDLE_PATH is not configured. ' +
      'Build the Cirrus worker module and set the path to the output bundle.',
    );
  }

  try {
    return fs.readFileSync(bundlePath, 'utf-8');
  } catch (err) {
    throw new Error(`Failed to read Cirrus worker bundle at ${bundlePath}: ${err}`);
  }
}

/**
 * Rollback partially-created resources on provisioning failure.
 */
async function rollback(
  db: Kysely<Database>,
  communityDid: string,
  workerName: string | null,
  r2BucketName: string | null,
): Promise<void> {
  logger.info({ communityDid, workerName, r2BucketName }, 'Rolling back provisioning');

  try {
    if (workerName) await deleteWorker(workerName);
  } catch (err) {
    logger.warn({ error: err, workerName }, 'Rollback: failed to delete Worker');
  }

  try {
    if (r2BucketName) await deleteR2Bucket(r2BucketName);
  } catch (err) {
    logger.warn({ error: err, r2BucketName }, 'Rollback: failed to delete R2 bucket');
  }

  try {
    await deleteSecrets(db, communityDid);
  } catch (err) {
    logger.warn({ error: err, communityDid }, 'Rollback: failed to delete secrets');
  }

  try {
    await db
      .updateTable('communities')
      .set({ provisioning_status: 'failed' })
      .where('did', '=', communityDid)
      .execute();
  } catch (err) {
    logger.warn({ error: err, communityDid }, 'Rollback: failed to update status');
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
