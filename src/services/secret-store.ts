/**
 * Encrypted secret storage for Cirrus-hosted community PDS instances.
 *
 * Wraps the existing AES-256-GCM encrypt/decrypt utilities to provide
 * structured CRUD operations on the community_secrets table.
 */

import type { Kysely } from 'kysely';
import type { Database } from '../db';
import { encrypt, decrypt } from '../lib/crypto';
import { logger } from '../lib/logger';

// ─── Types ───────────────────────────────────────────────────────────

/** Well-known secret names for a Cirrus PDS */
export type CirrusSecretName =
  | 'signing_key'
  | 'signing_key_public'
  | 'auth_token'
  | 'jwt_secret'
  | 'password_hash'
  | 'app_password'
  | 'account_password';

export interface SecretEntry {
  name: CirrusSecretName;
  value: string;
}

// ─── Store operations ────────────────────────────────────────────────

/**
 * Store multiple secrets for a community, encrypting each value.
 * Uses upsert semantics — existing secrets are overwritten.
 */
export async function storeSecrets(
  db: Kysely<Database>,
  communityDid: string,
  secrets: SecretEntry[],
): Promise<void> {
  if (secrets.length === 0) return;

  logger.info(
    { communityDid, secretNames: secrets.map(s => s.name) },
    'Storing community secrets',
  );

  for (const secret of secrets) {
    await db
      .insertInto('community_secrets')
      .values({
        community_did: communityDid,
        secret_name: secret.name,
        encrypted_value: encrypt(secret.value),
      })
      .onConflict(oc =>
        oc.columns(['community_did', 'secret_name']).doUpdateSet({
          encrypted_value: encrypt(secret.value),
          rotated_at: new Date(),
        }),
      )
      .execute();
  }
}

/**
 * Retrieve and decrypt a single secret for a community.
 * Returns null if the secret doesn't exist.
 */
export async function getSecret(
  db: Kysely<Database>,
  communityDid: string,
  secretName: CirrusSecretName,
): Promise<string | null> {
  const row = await db
    .selectFrom('community_secrets')
    .select('encrypted_value')
    .where('community_did', '=', communityDid)
    .where('secret_name', '=', secretName)
    .executeTakeFirst();

  if (!row) return null;
  return decrypt(row.encrypted_value);
}

/**
 * Export all secrets for a community (decrypted).
 * Intended for admin backup — access must be gated by caller.
 */
export async function exportSecrets(
  db: Kysely<Database>,
  communityDid: string,
): Promise<Record<string, string>> {
  const rows = await db
    .selectFrom('community_secrets')
    .select(['secret_name', 'encrypted_value'])
    .where('community_did', '=', communityDid)
    .execute();

  const result: Record<string, string> = {};
  for (const row of rows) {
    try {
      result[row.secret_name] = decrypt(row.encrypted_value);
    } catch (err) {
      logger.error(
        { communityDid, secretName: row.secret_name, error: err },
        'Failed to decrypt secret during export',
      );
      result[row.secret_name] = '<decryption-failed>';
    }
  }
  return result;
}

/**
 * Rotate a single secret: generate a new encrypted value and track rotation time.
 * The caller must also update the external system (e.g. Cloudflare Worker secrets).
 */
export async function rotateSecret(
  db: Kysely<Database>,
  communityDid: string,
  secretName: CirrusSecretName,
  newValue: string,
): Promise<void> {
  logger.info({ communityDid, secretName }, 'Rotating community secret');

  const result = await db
    .updateTable('community_secrets')
    .set({
      encrypted_value: encrypt(newValue),
      rotated_at: new Date(),
    })
    .where('community_did', '=', communityDid)
    .where('secret_name', '=', secretName)
    .executeTakeFirst();

  if (!result.numUpdatedRows || result.numUpdatedRows === 0n) {
    throw new Error(`Secret '${secretName}' not found for community ${communityDid}`);
  }
}

/**
 * Delete all secrets for a community (e.g. on community deletion).
 */
export async function deleteSecrets(
  db: Kysely<Database>,
  communityDid: string,
): Promise<void> {
  logger.info({ communityDid }, 'Deleting all community secrets');
  await db
    .deleteFrom('community_secrets')
    .where('community_did', '=', communityDid)
    .execute();
}
