import { BskyAgent, AtpAgent } from "@atproto/api";
import {
  DidResolver,
  HandleResolver,
  MemoryCache,
  getPds,
  getHandle,
} from "@atproto/identity";
import type { NodeOAuthClient } from "@atproto/oauth-client-node";
import type { Kysely } from "kysely";
import type { Database } from "../db";
import { decryptIfNeeded } from "../lib/crypto";
import { retry, isTransientError } from "../lib/retry";
import { logger } from "../lib/logger";
import { config } from "../config";
import { PostgresDidCache, startDidCacheCleanup } from "./didCache";

/**
 * Shared identity resolvers backed by a DID document cache.
 *
 * Using the official `@atproto/identity` package gives us:
 *   - support for both `did:plc` and `did:web`
 *   - bidirectional handle verification (handle -> DID -> handle)
 *   - automatic caching of DID documents (avoids repeated PLC lookups)
 *   - DNS TXT + HTTPS well-known handle resolution
 *
 * The resolver is created with a process-local `MemoryCache` so it works in
 * tests and scripts that don't go through `initDidCache()`.  At server start,
 * `initDidCache(db)` swaps in a PostgreSQL-backed cache so DID documents
 * survive process restarts.
 */
const memoryDidCache = new MemoryCache();

export const didResolver = new DidResolver({
  plcUrl: config.plcUrl,
  didCache: memoryDidCache,
});

export const handleResolver = new HandleResolver({});

/**
 * Replace the resolver's in-memory DID cache with a PostgreSQL-backed one and
 * start the periodic cleanup job that prunes expired entries.
 *
 * Returns a disposer that stops the cleanup interval — primarily useful for
 * tests.  Safe to call multiple times: each call replaces the previous cache.
 */
export function initDidCache(db: Kysely<Database>): () => void {
  const postgresCache = new PostgresDidCache(db);
  // `cache` is a public property on BaseResolver; swapping it lets us reuse
  // the existing `didResolver` instance without rebinding every importer.
  didResolver.cache = postgresCache;
  logger.info("DID resolver now using PostgreSQL-backed cache");
  return startDidCacheCleanup(postgresCache);
}

/**
 * In-memory cache for authenticated community agents.
 *
 * The Bluesky PDS enforces a rate limit of ~30 createSession calls per
 * 5-minute window.  Without caching, every inbound API request calls
 * `login()`, so a single page load (which fires 5-10 parallel requests)
 * quickly exhausts the budget and causes cascading 429 errors.
 *
 * Cached agents are reused for 4 minutes (well within the JWT lifetime)
 * and automatically evicted when they expire.
 */
interface CachedAgent {
  agent: BskyAgent;
  expiresAt: number;
}

const agentCache = new Map<string, CachedAgent>();
const AGENT_CACHE_TTL_MS = 4 * 60 * 1000; // 4 minutes

/**
 * Pending login promises so concurrent requests for the same community
 * share a single login() call instead of each triggering their own.
 */
const pendingLogins = new Map<string, Promise<BskyAgent>>();

/** Periodically prune expired entries so the map doesn't grow forever. */
setInterval(() => {
  const now = Date.now();
  for (const [did, entry] of agentCache) {
    if (now >= entry.expiresAt) {
      agentCache.delete(did);
    }
  }
}, 60_000);

/** Ensure a PDS host string is a full URL with scheme. */
export function ensureServiceUrl(pdsHost: string): string {
  if (pdsHost.startsWith("http://") || pdsHost.startsWith("https://")) {
    return pdsHost;
  }
  return `https://${pdsHost}`;
}

/**
 * Resolve a DID to its actual PDS endpoint via the DID document.
 *
 * Uses the official `@atproto/identity` `DidResolver`, which supports both
 * `did:plc` (via the PLC directory) and `did:web` (via the well-known URL),
 * and caches DID documents in memory. Falls back to the provided fallback
 * URL if resolution fails.
 */
export async function resolvePdsEndpoint(
  did: string,
  fallback?: string,
): Promise<string> {
  try {
    const doc = await didResolver.resolve(did);
    if (doc) {
      const pds = getPds(doc);
      if (pds) {
        return pds;
      }
    }
  } catch (err) {
    logger.warn({ did, error: err }, "Failed to resolve PDS from DID document");
  }
  if (fallback) return ensureServiceUrl(fallback);
  throw new Error(`Could not resolve PDS for ${did}`);
}

/**
 * Reference to the application's `NodeOAuthClient`, registered at startup so
 * non-OAuth code paths (e.g. community agent app-password login) can reuse
 * the client's `OAuthResolver` to discover the proper authorization server.
 *
 * In the Bluesky network, multiple PDS instances can share a single
 * "entryway" that acts as the Authorization Server. The PDS serves a
 * protected-resource metadata document that points to that auth server, and
 * `OAuthResolver` performs the lookup. For single-PDS deployments the auth
 * server URL is simply the PDS URL, so behaviour is unchanged.
 */
let oauthClientRef: NodeOAuthClient | null = null;

/**
 * Register the OAuth client so {@link resolveAuthServer} can use its
 * `OAuthResolver` to discover authorization servers from PDS metadata.
 * Safe to call multiple times; the most recent client wins. Pass `null` to
 * unregister (primarily useful in tests).
 */
export function setOAuthClient(client: NodeOAuthClient | null): void {
  oauthClientRef = client;
}

/**
 * Resolve the OAuth authorization server URL for an identity (DID or handle)
 * or an existing PDS service URL.
 *
 * Uses the registered `NodeOAuthClient`'s `OAuthResolver` to fetch the PDS's
 * protected-resource metadata and extract the `issuer` of its authorization
 * server. This is the URL community agents should target for
 * `BskyAgent.login()` (createSession) so that, in entryway architectures
 * (PDS != auth server), credentials are validated by the entryway. After
 * login, `BskyAgent` automatically dispatches subsequent XRPC calls to the
 * actual PDS via the `pdsUrl` extracted from the `didDoc` returned by
 * createSession, so a single agent works for both flows.
 *
 * If the OAuth client has not been registered, or the resolver call fails
 * (e.g. PDS without `.well-known/oauth-protected-resource`), this falls back
 * to {@link resolvePdsEndpoint} so single-PDS deployments — where the auth
 * server URL is the PDS URL — continue to work as before.
 */
export async function resolveAuthServer(
  identityOrServiceUrl: string,
  fallback?: string,
): Promise<string> {
  const client = oauthClientRef;
  if (client) {
    try {
      const isUrl = /^https?:\/\//.test(identityOrServiceUrl);
      const result = isUrl
        ? await client.oauthResolver.resolveFromService(identityOrServiceUrl)
        : await client.oauthResolver.resolve(identityOrServiceUrl);
      if (result?.metadata?.issuer) {
        return result.metadata.issuer;
      }
    } catch (err) {
      logger.warn(
        { input: identityOrServiceUrl, error: err },
        "Failed to resolve auth server via OAuthResolver; falling back to PDS endpoint",
      );
    }
  }
  // Fallback: use the PDS endpoint. In single-PDS architectures the PDS URL
  // *is* the auth server URL, so this preserves existing behaviour.
  if (identityOrServiceUrl.startsWith("did:")) {
    return resolvePdsEndpoint(identityOrServiceUrl, fallback);
  }
  if (/^https?:\/\//.test(identityOrServiceUrl)) {
    return ensureServiceUrl(identityOrServiceUrl);
  }
  if (fallback) return ensureServiceUrl(fallback);
  throw new Error(`Could not resolve auth server for ${identityOrServiceUrl}`);
}

/**
 * Resolve a handle to its DID with bidirectional verification.
 *
 * Per the ATProto identity spec, a handle "claim" is only valid if the DID
 * document the handle resolves to also lists the same handle. This function
 * performs that round-trip check and throws if the two do not agree.
 */
export async function resolveHandleToDid(handle: string): Promise<string> {
  const normalized = handle.toLowerCase().replace(/^@/, "");
  const did = await handleResolver.resolve(normalized);
  if (!did) {
    throw new Error(`Could not resolve handle "${handle}" to a DID`);
  }
  const doc = await didResolver.resolve(did);
  if (!doc) {
    throw new Error(`Could not resolve DID document for "${did}"`);
  }
  const docHandle = getHandle(doc);
  if (!docHandle || docHandle.toLowerCase() !== normalized) {
    throw new Error(
      `Handle verification failed: "${handle}" does not match DID document handle "${docHandle ?? "none"}"`,
    );
  }
  return did;
}

export async function createCommunityAgent(
  db: Kysely<Database>,
  did: string,
): Promise<BskyAgent> {
  // 1. Return a cached agent if it's still valid
  const cached = agentCache.get(did);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.agent;
  }

  // 2. If another caller is already logging in for this DID, await that
  //    instead of firing a second createSession call.
  const pending = pendingLogins.get(did);
  if (pending) {
    return pending;
  }

  // 3. Perform the actual login, sharing the promise with concurrent callers
  const loginPromise = (async (): Promise<BskyAgent> => {
    const community = await db
      .selectFrom("communities")
      .select(["handle", "pds_host", "app_password"])
      .where("did", "=", did)
      .executeTakeFirst();

    if (!community) {
      throw new Error("Community not found");
    }

    // Discover the OAuth authorization server for the community's identity.
    // In single-PDS deployments this resolves to the PDS URL itself; in
    // entryway architectures (PDS != auth server) it resolves to the
    // entryway. `BskyAgent.login()` (createSession) is targeted at this
    // URL so credentials are validated by the right server. After login,
    // the agent automatically dispatches subsequent XRPC calls to the
    // user's actual PDS via the `pdsUrl` extracted from the DID document.
    const authServerUrl = await resolveAuthServer(did, community.pds_host);

    const agent = new BskyAgent({ service: authServerUrl });

    await retry(
      () =>
        agent.login({
          identifier: did,
          password: decryptIfNeeded(community.app_password),
        }),
      {
        maxRetries: 2,
        initialDelay: 1000,
        shouldRetry: (error) => {
          return isTransientError(error);
        },
        context: {
          did,
          handle: community.handle,
          authServerUrl,
        },
      },
    );

    // Cache the authenticated agent
    agentCache.set(did, { agent, expiresAt: Date.now() + AGENT_CACHE_TTL_MS });
    logger.info({ did }, "Community agent cached");

    return agent;
  })();

  pendingLogins.set(did, loginPromise);

  try {
    return await loginPromise;
  } finally {
    pendingLogins.delete(did);
  }
}

/**
 * Build an agent for a PoC *member* account (dev-only). Mirrors
 * createCommunityAgent but reads credentials from `poc_member_accounts`.
 * Used so the /poc act-as switcher can write into a member's own repo.
 */
export async function getMemberAgent(
  db: Kysely<Database>,
  did: string,
): Promise<BskyAgent> {
  const acct = await db
    .selectFrom("poc_member_accounts")
    .select(["handle", "pds_host", "app_password"])
    .where("did", "=", did)
    .executeTakeFirst();
  if (!acct) throw new Error(`No PoC member account for ${did}`);

  const authServerUrl = await resolveAuthServer(did, acct.pds_host);
  const agent = new BskyAgent({ service: authServerUrl });
  await agent.login({
    identifier: did,
    password: decryptIfNeeded(acct.app_password),
  });
  return agent;
}

/**
 * Evict a cached community agent (e.g. after an app-password update).
 */
export function invalidateCommunityAgent(did: string): void {
  agentCache.delete(did);
  pendingLogins.delete(did);
}

export async function getPublicAgent(pdsHost: string): Promise<AtpAgent> {
  return new AtpAgent({ service: ensureServiceUrl(pdsHost) });
}
