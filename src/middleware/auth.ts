import { Request, Response, NextFunction } from "express";
import type { Kysely, Selectable } from "kysely";
import type { App, Database } from "../db";
import { computeApiKeyLookup, verifyApiKeyAsync } from "../lib/crypto";
import { TtlCache } from "../lib/cache";
import {
  getCimdDocument,
  invalidateCimdCache,
  jwkToKeyObject,
} from "../lib/cimd";
import { verifyRequestSignature, parseSignatureInput } from "../lib/httpSig";
import { logger } from "../lib/logger";

export interface AuthenticatedRequest extends Request {
  app_data?: {
    app_id: string;
    name: string;
    domain: string;
    creator_did: string;
    api_key: string;
    status: string;
    created_at: Date;
    updated_at: Date;
  };
  /** Set to 'api_key' or 'http_signature' depending on how the request was authenticated */
  auth_method?: "api_key" | "http_signature";
}

/**
 * Cache of recently verified API keys, keyed by the key's SHA-256 lookup hash
 * (never the raw key, so heap dumps don't expose secrets). Bounds the cost of
 * scrypt verification to at most once per key per minute.
 *
 * Tradeoff: a rotated or deactivated key may keep authenticating for up to
 * the TTL. Rotation/deactivation paths that know the raw key should call
 * apiKeyAuthCache.invalidate(computeApiKeyLookup(rawKey)).
 */
export const apiKeyAuthCache = new TtlCache<Selectable<App>>(60_000, 500);

/**
 * Authenticate a raw API key against the apps table.
 *
 * Fast path: fetch the single candidate row via the indexed api_key_lookup
 * column and run one async scrypt verification. Legacy fallback: apps created
 * before migration 016 have no lookup value, so scan active apps and verify
 * each — on a match, backfill api_key_lookup so the next request takes the
 * fast path.
 */
export async function authenticateApiKey(
  db: Kysely<Database>,
  rawKey: string,
): Promise<Selectable<App> | null> {
  const lookup = computeApiKeyLookup(rawKey);

  const cached = apiKeyAuthCache.get(lookup);
  if (cached) {
    return cached;
  }

  // Fast path: indexed single-row lookup.
  const candidate = await db
    .selectFrom("apps")
    .selectAll()
    .where("api_key_lookup", "=", lookup)
    .where("status", "=", "active")
    .executeTakeFirst();

  if (candidate) {
    if (candidate.auth_method === "http_signature") {
      return null; // API key auth not allowed for this app
    }
    if (await verifyApiKeyAsync(rawKey, candidate.api_key)) {
      apiKeyAuthCache.set(lookup, candidate);
      return candidate;
    }
    return null;
  }

  // Legacy fallback: rows from before migration 016 have no lookup value.
  const legacyApps = await db
    .selectFrom("apps")
    .selectAll()
    .where("status", "=", "active")
    .where("api_key_lookup", "is", null)
    .execute();

  for (const legacy of legacyApps) {
    if (legacy.auth_method === "http_signature") continue;
    if (await verifyApiKeyAsync(rawKey, legacy.api_key)) {
      // Backfill so the next request uses the indexed fast path. Best-effort:
      // an update failure must not fail the (already authenticated) request.
      db.updateTable("apps")
        .set({ api_key_lookup: lookup })
        .where("app_id", "=", legacy.app_id)
        .execute()
        .catch((error) =>
          logger.warn(
            { error, appId: legacy.app_id },
            "api_key_lookup backfill failed",
          ),
        );
      apiKeyAuthCache.set(lookup, legacy);
      return legacy;
    }
  }

  return null;
}

export function createVerifyApiKey(db: Kysely<Database>) {
  return async function verifyApiKey(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ) {
    const apiKey = req.headers["x-api-key"] as string;
    const signatureInput = req.headers["signature-input"] as string;

    // Try HTTP Message Signature auth first if headers are present
    if (signatureInput && req.headers["signature"]) {
      return verifyHttpSignature(req, res, next, db);
    }

    // Detect malformed signature attempt (input without signature)
    if (signatureInput && !req.headers["signature"]) {
      return res
        .status(401)
        .json({
          error:
            "Signature-Input header present but Signature header is missing. Both are required.",
        });
    }

    // Fall back to API key auth
    if (!apiKey) {
      return res
        .status(401)
        .json({ error: "API key or HTTP signature required" });
    }

    try {
      const app = await authenticateApiKey(db, apiKey);

      if (!app) {
        return res.status(401).json({ error: "Invalid API key" });
      }

      req.app_data = app;
      req.auth_method = "api_key";
      next();
    } catch (error) {
      logger.error({ error, correlationId: req.correlationId }, "Auth error");
      res.status(500).json({ error: "Authentication failed" });
    }
  };
}

/**
 * Verify a request using HTTP Message Signatures.
 *
 * 1. Extract the keyid from Signature-Input (maps to app domain)
 * 2. Fetch the app's CIMD document to get their public key
 * 3. Verify the signature against the public key
 * 4. On verification failure, invalidate CIMD cache and retry once
 */
async function verifyHttpSignature(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
  db: Kysely<Database>,
) {
  try {
    const signatureInput = req.headers["signature-input"] as string;

    // Use the shared parser to extract keyid (avoids duplicating regex logic)
    const parsed = parseSignatureInput(signatureInput);
    if (!parsed) {
      return res
        .status(401)
        .json({ error: "Malformed Signature-Input header" });
    }
    const keyId = parsed.params.keyid as string | undefined;
    if (!keyId) {
      return res
        .status(401)
        .json({ error: "Missing keyid in Signature-Input" });
    }

    // Look up the app by app_id or domain
    const app = await db
      .selectFrom("apps")
      .selectAll()
      .where("status", "=", "active")
      .where((eb) =>
        eb.or([eb("app_id", "=", keyId), eb("domain", "=", keyId)]),
      )
      .executeTakeFirst();

    if (!app) {
      return res.status(401).json({ error: "Unknown app" });
    }

    // Ensure this app is configured for HTTP signature auth
    if (app.auth_method !== "http_signature" && app.auth_method !== "both") {
      return res
        .status(401)
        .json({ error: "This app is not configured for HTTP signature auth" });
    }

    // Fetch CIMD document, using app's cimd_url if set
    const cimd = await getCimdDocument(app.domain, false, app.cimd_url);
    if (!cimd) {
      return res
        .status(401)
        .json({ error: "Could not fetch client identity document" });
    }

    const publicKey = jwkToKeyObject(cimd.publicKeyJwk);
    let result = verifyRequestSignature(req, publicKey);

    // If verification fails, maybe the key rotated — refetch and retry once
    if (!result.valid) {
      invalidateCimdCache(app.domain);
      const freshCimd = await getCimdDocument(app.domain, true, app.cimd_url);
      if (freshCimd) {
        const freshKey = jwkToKeyObject(freshCimd.publicKeyJwk);
        result = verifyRequestSignature(req, freshKey);
      }
    }

    if (!result.valid) {
      logger.warn(
        { domain: app.domain, error: result.error },
        "HTTP signature verification failed",
      );
      return res
        .status(401)
        .json({ error: result.error || "Signature verification failed" });
    }

    req.app_data = app;
    req.auth_method = "http_signature";
    next();
  } catch (error) {
    logger.error(
      { error, correlationId: req.correlationId },
      "HTTP signature auth error",
    );
    res.status(500).json({ error: "Authentication failed" });
  }
}

/**
 * Parse a scope string into its individual scope values.
 * Scopes are space-separated per the OAuth 2.0 spec.
 */
export function parseScopeString(scope: string): string[] {
  return scope.split(/\s+/).filter(Boolean);
}

/**
 * Check whether a granted scope string satisfies a required scope.
 *
 * A required scope like `repo:community.opensocial.membership` is satisfied if:
 * - The exact scope is present, OR
 * - A wildcard scope covering it is present (e.g. `repo:*`)
 *
 * For `repo:` scopes, the collection part is compared. A granted
 * `repo:community.opensocial.*` would NOT match because the AT Proto spec
 * does not allow partial wildcards — only `repo:*` (all collections).
 */
export function hasScope(
  grantedScopeString: string,
  requiredScope: string,
): boolean {
  const granted = parseScopeString(grantedScopeString);

  // Check for exact match
  if (granted.includes(requiredScope)) {
    return true;
  }

  // Check for wildcard coverage within the same resource type
  // e.g. required = "repo:community.opensocial.membership", granted includes "repo:*"
  const [requiredResource] = requiredScope.split(":");
  for (const scope of granted) {
    const [resource, value] = scope.split(":");
    if (resource === requiredResource && value === "*") {
      return true;
    }
  }

  return false;
}

/**
 * The set of OAuth scopes that Open Social requests.
 * - `atproto` — required base scope for all AT Proto OAuth flows
 * - `repo:community.opensocial.membership` — write membership records to user's repo
 */
export const OPENSOCIAL_SCOPES = "atproto repo:community.opensocial.membership";

/**
 * The granular scope required to write membership records.
 */
export const MEMBERSHIP_WRITE_SCOPE = "repo:community.opensocial.membership";
