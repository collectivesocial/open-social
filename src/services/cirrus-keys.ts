/**
 * Cirrus PDS key and secret generation.
 *
 * Generates all cryptographic material needed to provision a new
 * single-user Cirrus PDS on Cloudflare Workers:
 *   - secp256k1 signing key pair (JWK private + multibase public)
 *   - AUTH_TOKEN (random bearer token)
 *   - JWT_SECRET (random string for session JWTs)
 *   - Account password + bcrypt hash
 *   - did:web identity derived from hostname
 */

import crypto from 'crypto';
import bcrypt from 'bcrypt';
import { logger } from '../lib/logger';

// ─── Types ───────────────────────────────────────────────────────────

export interface CirrusSecrets {
  /** did:web:{hostname} */
  did: string;
  /** PDS hostname, e.g. movieclub.opensocial.community */
  hostname: string;
  /** Handle for the community account (same as hostname for did:web) */
  handle: string;
  /** secp256k1 private key as JWK JSON string */
  signingKeyPrivate: string;
  /** Multibase-encoded public key for the DID document */
  signingKeyPublic: string;
  /** Random bearer token for XRPC write authentication */
  authToken: string;
  /** Random secret for signing session JWTs */
  jwtSecret: string;
  /** Plaintext account password (used once to create initial session) */
  accountPassword: string;
  /** bcrypt hash of accountPassword (stored in Cirrus as PASSWORD_HASH) */
  passwordHash: string;
}

// ─── Key generation ──────────────────────────────────────────────────

/**
 * Generate a secp256k1 key pair for AT Protocol signing.
 * Returns the private key as a JWK JSON string and the public key
 * in the compressed-point multibase format Cirrus expects.
 */
function generateSigningKeyPair(): { privateJwk: string; publicMultibase: string } {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', {
    namedCurve: 'secp256k1',
  });

  // Export private key as JWK
  const jwk = privateKey.export({ format: 'jwk' });
  const privateJwk = JSON.stringify(jwk);

  // Export the public key in SPKI DER format to extract the EC point
  const spkiDer = publicKey.export({ type: 'spki', format: 'der' });

  // Extract the uncompressed EC point from SPKI DER.
  // secp256k1 SPKI is: SEQUENCE { AlgorithmIdentifier, BIT STRING { 0x04 || x || y } }
  // The uncompressed point (65 bytes: 0x04 + 32-byte x + 32-byte y) is at the end.
  const ecPointStart = spkiDer.length - 65;
  const ecPoint = spkiDer.subarray(ecPointStart);

  let compressedPub: Buffer;
  if (ecPoint[0] === 0x04 && ecPoint.length === 65) {
    // Compress: prefix is 0x02 if y is even, 0x03 if y is odd
    const x = ecPoint.subarray(1, 33);
    const y = ecPoint.subarray(33, 65);
    const prefix = (y[y.length - 1] & 1) === 0 ? 0x02 : 0x03;
    compressedPub = Buffer.concat([Buffer.from([prefix]), x]);
  } else {
    // Unexpected format — use as-is
    compressedPub = Buffer.from(ecPoint);
  }

  // Multicodec varint for secp256k1-pub is 0xe7 0x01, then the 33-byte compressed key
  // Multibase prefix 'z' = base58btc
  const multicodecPrefix = Buffer.from([0xe7, 0x01]);
  const multicodecKey = Buffer.concat([multicodecPrefix, compressedPub]);
  const publicMultibase = 'z' + base58btcEncode(multicodecKey);

  return { privateJwk, publicMultibase };
}

/**
 * Base58btc encoding (Bitcoin alphabet).
 */
function base58btcEncode(data: Buffer): string {
  const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  const BASE = 58n;

  if (data.length === 0) return '';

  // Count leading zeros
  let leadingZeros = 0;
  for (const byte of data) {
    if (byte !== 0) break;
    leadingZeros++;
  }

  // Convert to BigInt
  let num = BigInt('0x' + data.toString('hex'));

  const chars: string[] = [];
  while (num > 0n) {
    const remainder = Number(num % BASE);
    chars.unshift(ALPHABET[remainder]);
    num = num / BASE;
  }

  // Add leading '1's for each leading zero byte
  return ALPHABET[0].repeat(leadingZeros) + chars.join('');
}

// ─── Public API ──────────────────────────────────────────────────────

/**
 * Generate all secrets required to provision a new Cirrus PDS.
 *
 * @param communityName - Subdomain name (e.g. "movieclub")
 * @param baseDomain - Base domain (e.g. "opensocial.community")
 * @returns Complete set of secrets for the Cirrus deployment
 */
export async function generateCirrusSecrets(
  communityName: string,
  baseDomain: string,
): Promise<CirrusSecrets> {
  const hostname = `${communityName}.${baseDomain}`;
  const did = `did:web:${hostname}`;
  const handle = hostname;

  logger.info({ communityName, hostname, did }, 'Generating Cirrus PDS secrets');

  // Generate signing key pair
  const { privateJwk, publicMultibase } = generateSigningKeyPair();

  // Generate random tokens
  const authToken = crypto.randomBytes(32).toString('hex');
  const jwtSecret = crypto.randomBytes(32).toString('hex');

  // Generate account password and hash it
  const accountPassword = generateAppPassword();
  const passwordHash = await bcrypt.hash(accountPassword, 12);

  return {
    did,
    hostname,
    handle,
    signingKeyPrivate: privateJwk,
    signingKeyPublic: publicMultibase,
    authToken,
    jwtSecret,
    accountPassword,
    passwordHash,
  };
}

/**
 * Generate a random app password in xxxx-xxxx-xxxx-xxxx format.
 */
function generateAppPassword(): string {
  const segments: string[] = [];
  for (let i = 0; i < 4; i++) {
    segments.push(crypto.randomBytes(2).toString('hex'));
  }
  return segments.join('-');
}
