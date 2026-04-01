import { Request, Response, NextFunction } from 'express';
import type { Kysely } from 'kysely';
import type { Database } from '../db';
import { hashApiKeyLookup, verifyApiKey as verifyApiKeyHash } from '../lib/crypto';
import { logger } from '../lib/logger';

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
}

export function createVerifyApiKey(db: Kysely<Database>) {
  return async function verifyApiKey(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
  ) {
    const apiKey = req.headers['x-api-key'] as string;

    if (!apiKey) {
      return res.status(401).json({ error: 'API key required' });
    }

    try {
      // Compute the fast HMAC-SHA256 lookup token so we can find the exact
      // app row in O(1) rather than scanning every row with slow scrypt.
      const lookupHash = hashApiKeyLookup(apiKey);

      let app = await db
        .selectFrom('apps')
        .selectAll()
        .where('status', '=', 'active')
        .where('key_lookup_hash', '=', lookupHash)
        .executeTakeFirst();

      // Backward-compat: apps registered before migration 006 have a NULL
      // key_lookup_hash.  Scan only those rows (scrypt per row) and, on
      // success, eagerly write the lookup hash so subsequent calls are fast.
      if (!app) {
        const legacyApps = await db
          .selectFrom('apps')
          .selectAll()
          .where('status', '=', 'active')
          .where('key_lookup_hash', 'is', null)
          .execute();

        for (const candidate of legacyApps) {
          if (verifyApiKeyHash(apiKey, candidate.api_key)) {
            app = candidate;
            // Populate the lookup hash so this path is never needed again.
            await db
              .updateTable('apps')
              .set({ key_lookup_hash: lookupHash })
              .where('app_id', '=', candidate.app_id)
              .execute();
            break;
          }
        }
      }

      if (!app || !verifyApiKeyHash(apiKey, app.api_key)) {
        return res.status(401).json({ error: 'Invalid API key' });
      }

      req.app_data = app;
      next();
    } catch (error) {
      logger.error({ error, correlationId: req.correlationId }, 'Auth error');
      res.status(500).json({ error: 'Authentication failed' });
    }
  };
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
 * - A wildcard scope covering it is present (e.g. `repo:*`), OR
 * - The legacy `transition:generic` scope is present (full access fallback)
 *
 * For `repo:` scopes, the collection part is compared. A granted
 * `repo:community.opensocial.*` would NOT match because the AT Proto spec
 * does not allow partial wildcards — only `repo:*` (all collections).
 */
export function hasScope(grantedScopeString: string, requiredScope: string): boolean {
  const granted = parseScopeString(grantedScopeString);

  // transition:generic is the legacy full-access scope — it satisfies everything
  if (granted.includes('transition:generic')) {
    return true;
  }

  // Check for exact match
  if (granted.includes(requiredScope)) {
    return true;
  }

  // Check for wildcard coverage within the same resource type
  // e.g. required = "repo:community.opensocial.membership", granted includes "repo:*"
  const [requiredResource] = requiredScope.split(':');
  for (const scope of granted) {
    const [resource, value] = scope.split(':');
    if (resource === requiredResource && value === '*') {
      return true;
    }
  }

  return false;
}

/**
 * The set of OAuth scopes that Open Social requests.
 * - `atproto` — required base scope for all AT Proto OAuth flows
 * - `repo:community.opensocial.membership` — write membership records to user's repo
 * - `transition:generic` — legacy full-access fallback for PDS compatibility
 */
export const OPENSOCIAL_SCOPES = 'atproto repo:community.opensocial.membership transition:generic';

/**
 * The granular scope required to write membership records.
 */
export const MEMBERSHIP_WRITE_SCOPE = 'repo:community.opensocial.membership';
