/**
 * Cloudflare API client for programmatic Cirrus PDS deployment.
 *
 * Uses the Cloudflare REST API v4 to:
 * - Create R2 buckets for blob storage
 * - Deploy Workers (Cirrus PDS) with correct bindings
 * - Set Worker secrets (signing keys, auth tokens, etc.)
 * - Bind custom domains to Workers
 * - Clean up resources on deprovisioning
 */

import { config } from '../config';
import { retry, isTransientError } from '../lib/retry';
import { logger } from '../lib/logger';

// ─── Types ───────────────────────────────────────────────────────────

interface CloudflareResponse<T = any> {
  success: boolean;
  errors: { code: number; message: string }[];
  messages: string[];
  result: T;
}

export interface WorkerVars {
  PDS_HOSTNAME: string;
  DID: string;
  HANDLE: string;
  SIGNING_KEY_PUBLIC: string;
  INITIAL_ACTIVE: string;
}

export interface WorkerSecrets {
  AUTH_TOKEN: string;
  SIGNING_KEY: string;
  JWT_SECRET: string;
  PASSWORD_HASH: string;
}

// ─── Internal helpers ────────────────────────────────────────────────

const CF_API_BASE = 'https://api.cloudflare.com/client/v4';

function getAccountId(): string {
  if (!config.cloudflareAccountId) {
    throw new Error('CLOUDFLARE_ACCOUNT_ID is not configured');
  }
  return config.cloudflareAccountId;
}

function getHeaders(): Record<string, string> {
  if (!config.cloudflareApiToken) {
    throw new Error('CLOUDFLARE_API_TOKEN is not configured');
  }
  return {
    Authorization: `Bearer ${config.cloudflareApiToken}`,
    'Content-Type': 'application/json',
  };
}

async function cfFetch<T = any>(
  path: string,
  options: RequestInit = {},
): Promise<CloudflareResponse<T>> {
  const url = `${CF_API_BASE}${path}`;
  const headers = { ...getHeaders(), ...(options.headers as Record<string, string> || {}) };

  const response = await retry(
    async () => {
      const res = await fetch(url, { ...options, headers });
      if (!res.ok) {
        const body = await res.text();
        const err: any = new Error(`Cloudflare API error: ${res.status} ${res.statusText}`);
        err.status = res.status;
        err.body = body;
        throw err;
      }
      return res.json() as Promise<CloudflareResponse<T>>;
    },
    {
      maxRetries: 2,
      initialDelay: 1000,
      shouldRetry: (error) => isTransientError(error),
      context: { cfPath: path },
    },
  );

  if (!response.success) {
    const errorMsg = response.errors?.map(e => `${e.code}: ${e.message}`).join('; ') || 'Unknown CF error';
    throw new Error(`Cloudflare API returned errors: ${errorMsg}`);
  }

  return response;
}

// ─── R2 Bucket operations ────────────────────────────────────────────

/**
 * Create an R2 bucket for a community's blob storage.
 */
export async function createR2Bucket(bucketName: string): Promise<void> {
  const accountId = getAccountId();
  logger.info({ bucketName }, 'Creating R2 bucket');

  await cfFetch(`/accounts/${accountId}/r2/buckets`, {
    method: 'POST',
    body: JSON.stringify({ name: bucketName }),
  });

  logger.info({ bucketName }, 'R2 bucket created');
}

/**
 * Delete an R2 bucket (must be empty or force-deleted).
 */
export async function deleteR2Bucket(bucketName: string): Promise<void> {
  const accountId = getAccountId();
  logger.info({ bucketName }, 'Deleting R2 bucket');

  try {
    await cfFetch(`/accounts/${accountId}/r2/buckets/${bucketName}`, {
      method: 'DELETE',
    });
    logger.info({ bucketName }, 'R2 bucket deleted');
  } catch (err) {
    logger.warn({ bucketName, error: err }, 'Failed to delete R2 bucket (may not exist)');
  }
}

// ─── Worker deployment ───────────────────────────────────────────────

/**
 * Deploy a Cloudflare Worker with Cirrus PDS configuration.
 *
 * Uses the Workers API multipart upload to deploy the ES module
 * with Durable Object and R2 bindings.
 */
export async function deployWorker(
  scriptName: string,
  workerModule: string | Buffer,
  r2BucketName: string,
  vars: WorkerVars,
): Promise<void> {
  const accountId = getAccountId();
  logger.info({ scriptName, r2BucketName }, 'Deploying Cirrus Worker');

  // Build the metadata for the Worker deployment
  const metadata = {
    main_module: 'index.js',
    bindings: [
      // Durable Object binding for AccountDurableObject
      {
        type: 'durable_object_namespace',
        name: 'ACCOUNT',
        class_name: 'AccountDurableObject',
      },
      // R2 bucket binding for blob storage
      {
        type: 'r2_bucket',
        name: 'BLOBS',
        bucket_name: r2BucketName,
      },
      // Public env vars as plain_text bindings
      ...Object.entries(vars).map(([name, text]) => ({
        type: 'plain_text' as const,
        name,
        text,
      })),
    ],
    compatibility_date: '2024-12-01',
    compatibility_flags: ['nodejs_compat'],
    migrations: {
      new_sqlite_classes: ['AccountDurableObject'],
      tag: 'v1',
    },
  };

  // Use multipart form upload for ES module workers
  const formData = new FormData();

  // Metadata part
  formData.append(
    'metadata',
    new Blob([JSON.stringify(metadata)], { type: 'application/json' }),
  );

  // Worker module part
  const moduleBlob = new Blob(
    [typeof workerModule === 'string' ? workerModule : workerModule],
    { type: 'application/javascript+module' },
  );
  formData.append('index.js', moduleBlob, 'index.js');

  // Deploy the worker — don't set JSON content-type for multipart
  const url = `${CF_API_BASE}/accounts/${accountId}/workers/scripts/${scriptName}`;
  const res = await fetch(url, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${config.cloudflareApiToken}`,
    },
    body: formData,
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Failed to deploy worker ${scriptName}: ${res.status} ${body}`);
  }

  logger.info({ scriptName }, 'Cirrus Worker deployed');
}

/**
 * Set secret environment variables on a Worker.
 * These are encrypted at rest by Cloudflare and not readable via API.
 */
export async function setWorkerSecrets(
  scriptName: string,
  secrets: WorkerSecrets,
): Promise<void> {
  const accountId = getAccountId();
  logger.info({ scriptName, secretNames: Object.keys(secrets) }, 'Setting Worker secrets');

  // Set each secret individually (CF API requires one at a time)
  for (const [name, value] of Object.entries(secrets)) {
    await cfFetch(`/accounts/${accountId}/workers/scripts/${scriptName}/secrets`, {
      method: 'PUT',
      body: JSON.stringify({ name, text: value, type: 'secret_text' }),
    });
  }

  logger.info({ scriptName }, 'Worker secrets set');
}

/**
 * Bind a custom domain to a Worker.
 */
export async function createWorkerCustomDomain(
  scriptName: string,
  hostname: string,
): Promise<void> {
  const accountId = getAccountId();
  logger.info({ scriptName, hostname }, 'Binding custom domain to Worker');

  await cfFetch(`/accounts/${accountId}/workers/domains`, {
    method: 'PUT',
    body: JSON.stringify({
      hostname,
      service: scriptName,
      environment: 'production',
    }),
  });

  logger.info({ scriptName, hostname }, 'Custom domain bound');
}

/**
 * Delete a Worker script.
 */
export async function deleteWorker(scriptName: string): Promise<void> {
  const accountId = getAccountId();
  logger.info({ scriptName }, 'Deleting Worker');

  try {
    await cfFetch(`/accounts/${accountId}/workers/scripts/${scriptName}`, {
      method: 'DELETE',
    });
    logger.info({ scriptName }, 'Worker deleted');
  } catch (err) {
    logger.warn({ scriptName, error: err }, 'Failed to delete Worker (may not exist)');
  }
}

/**
 * Check if a Worker is healthy by calling its health endpoint.
 */
export async function checkWorkerHealth(hostname: string): Promise<boolean> {
  try {
    const res = await fetch(`https://${hostname}/xrpc/_health`, {
      signal: AbortSignal.timeout(10_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}
