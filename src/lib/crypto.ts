/**
 * Encryption utilities for secrets at rest (AES-256-GCM).
 *
 * Used to encrypt community app passwords and API keys before
 * storing them in Postgres, and decrypt them when needed for PDS login.
 *
 * Requires ENCRYPTION_KEY env var — a 64-char hex string (32 bytes).
 * Generate one with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
 */

import crypto from "crypto";
import { config } from "../config";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12; // GCM recommended
const AUTH_TAG_LENGTH = 16;

// Parameters for API key hashing using scrypt.
// These can be tuned over time if needed.
const API_KEY_HASH_ALGO = "scrypt";
const API_KEY_SALT_LENGTH = 16; // 128-bit salt
const API_KEY_KEY_LENGTH = 32; // 256-bit derived key
const API_KEY_SCRYPT_N = 1 << 14; // CPU/memory cost
const API_KEY_SCRYPT_r = 8;
const API_KEY_SCRYPT_p = 1;

/**
 * Derive the 32-byte key from the hex config value.
 * Throws at startup if ENCRYPTION_KEY is missing or malformed.
 */
function getKey(): Buffer {
  const hex = config.encryptionKey;
  if (!hex || hex.length !== 64) {
    throw new Error(
      "ENCRYPTION_KEY must be a 64-character hex string (32 bytes). " +
        "Generate one with: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"",
    );
  }
  return Buffer.from(hex, "hex");
}

/**
 * Encrypt a plaintext string.
 * Returns a base64 string of: iv (12 B) + authTag (16 B) + ciphertext.
 */
export function encrypt(plaintext: string): string {
  const key = getKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  // Pack: iv + authTag + ciphertext
  const packed = Buffer.concat([iv, authTag, encrypted]);
  return packed.toString("base64");
}

/**
 * Decrypt a value produced by encrypt().
 * Returns the original plaintext string.
 */
export function decrypt(encoded: string): string {
  const key = getKey();
  const packed = Buffer.from(encoded, "base64");

  const iv = packed.subarray(0, IV_LENGTH);
  const authTag = packed.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const ciphertext = packed.subarray(IV_LENGTH + AUTH_TAG_LENGTH);

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  const decrypted = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);

  return decrypted.toString("utf8");
}

/**
 * Check whether a string looks like it was encrypted by us.
 * Encrypted values are base64 and at least iv+authTag bytes long.
 * Plain-text hex passwords (64 chars) will NOT match this pattern.
 */
export function isEncrypted(value: string): boolean {
  // Our encrypted output is base64. A 64-char hex password won't decode
  // to a buffer that has the right minimum length (12+16 = 28 bytes).
  try {
    const buf = Buffer.from(value, "base64");
    // Must have at least IV + authTag + 1 byte of ciphertext
    if (buf.length < IV_LENGTH + AUTH_TAG_LENGTH + 1) return false;
    // If re-encoding to base64 gives back the same string, it's valid base64
    return buf.toString("base64") === value;
  } catch {
    return false;
  }
}

/**
 * Safely decrypt a value that might still be in plaintext (migration helper).
 * If the value doesn't look like an encrypted blob, returns it as-is.
 */
export function decryptIfNeeded(value: string): string {
  if (isEncrypted(value)) {
    return decrypt(value);
  }
  return value;
}

/**
 * Hash an API key for storage using a computationally expensive KDF.
 * Uses Node's built-in scrypt with a random salt. The returned string
 * encodes the algorithm, parameters, salt, and hash in a stable format:
 *   "scrypt:N:r:p:<saltBase64>:<hashBase64>"
 */
export function hashApiKey(apiKey: string): string {
  const salt = crypto.randomBytes(API_KEY_SALT_LENGTH);
  const derivedKey = crypto.scryptSync(apiKey, salt, API_KEY_KEY_LENGTH, {
    N: API_KEY_SCRYPT_N,
    r: API_KEY_SCRYPT_r,
    p: API_KEY_SCRYPT_p,
  });

  const saltB64 = salt.toString("base64");
  const hashB64 = derivedKey.toString("base64");

  return [
    API_KEY_HASH_ALGO,
    API_KEY_SCRYPT_N,
    API_KEY_SCRYPT_r,
    API_KEY_SCRYPT_p,
    saltB64,
    hashB64,
  ].join(":");
}

/**
 * Parse the stored "scrypt:N:r:p:<saltB64>:<hashB64>" representation.
 * Returns null for anything malformed.
 */
function parseStoredApiKeyHash(
  storedHash: string,
): { N: number; r: number; p: number; salt: Buffer; storedKey: Buffer } | null {
  const parts = storedHash.split(":");
  if (parts.length !== 6) {
    return null;
  }

  const [algo, nStr, rStr, pStr, saltB64, hashB64] = parts;
  if (algo !== API_KEY_HASH_ALGO) {
    return null;
  }

  const N = Number(nStr);
  const r = Number(rStr);
  const p = Number(pStr);
  if (!Number.isFinite(N) || !Number.isFinite(r) || !Number.isFinite(p)) {
    return null;
  }

  const salt = Buffer.from(saltB64, "base64");
  const storedKey = Buffer.from(hashB64, "base64");
  if (salt.length === 0 || storedKey.length === 0) {
    return null;
  }

  return { N, r, p, salt, storedKey };
}

/**
 * Deterministic lookup value for an API key: SHA-256 hex of the raw key.
 *
 * Stored in apps.api_key_lookup so auth can fetch the single candidate row
 * by index instead of scanning every app. Safe without a salt because raw
 * keys carry 256 bits of entropy ("osc_" + 64 hex chars), making the digest
 * non-invertible in practice. The scrypt hash remains the verifier.
 */
export function computeApiKeyLookup(rawKey: string): string {
  return crypto.createHash("sha256").update(rawKey).digest("hex");
}

/**
 * Compare a raw API key against a stored hash.
 * Parses the stored representation and re-computes the scrypt hash.
 *
 * @deprecated On request paths use verifyApiKeyAsync — scryptSync blocks the
 * event loop for the full derivation (~tens of ms).
 */
export function verifyApiKey(rawKey: string, storedHash: string): boolean {
  try {
    const parsed = parseStoredApiKeyHash(storedHash);
    if (!parsed) {
      return false;
    }
    const { N, r, p, salt, storedKey } = parsed;

    const derivedKey = crypto.scryptSync(rawKey, salt, storedKey.length, {
      N,
      r,
      p,
    });

    if (derivedKey.length !== storedKey.length) {
      return false;
    }

    return crypto.timingSafeEqual(derivedKey, storedKey);
  } catch {
    // Any parse/derivation errors are treated as non-match.
    return false;
  }
}

/**
 * Async variant of verifyApiKey. Derivation runs in libuv's thread pool, so
 * the event loop stays free while scrypt does its deliberately expensive work.
 */
export async function verifyApiKeyAsync(
  rawKey: string,
  storedHash: string,
): Promise<boolean> {
  try {
    const parsed = parseStoredApiKeyHash(storedHash);
    if (!parsed) {
      return false;
    }
    const { N, r, p, salt, storedKey } = parsed;

    const derivedKey = await new Promise<Buffer>((resolve, reject) => {
      crypto.scrypt(rawKey, salt, storedKey.length, { N, r, p }, (err, key) =>
        err ? reject(err) : resolve(key),
      );
    });

    if (derivedKey.length !== storedKey.length) {
      return false;
    }

    return crypto.timingSafeEqual(derivedKey, storedKey);
  } catch {
    return false;
  }
}
