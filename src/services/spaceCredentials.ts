/**
 * Obtain and cache space credentials for a community, for cross-repo reads
 * (member-authored records live on the member's PDS; reading them requires a
 * space credential rather than the community's own session).
 *
 * Flow (both calls land on the community's own PDS, since the community is
 * the space authority):
 *   1. GET  com.atproto.space.getDelegationToken with the community session
 *      Bearer -> { token }
 *   2. POST com.atproto.space.getSpaceCredential with `authorization: Bearer
 *      <token>` and body { space } -> { credential }
 */
import type { Kysely } from "kysely";
import type { Database } from "../db";
import { createCommunityAgent, resolvePdsEndpoint } from "./atproto";

const EXPIRY_BUFFER_MS = 5 * 60 * 1000;
const cache = new Map<string, { credential: string; exp: number }>();

export function clearCredentialCache(): void {
  cache.clear();
}

export function parseJwtExp(jwt: string): number {
  const segment = jwt.split(".")[1];
  if (!segment) {
    throw new Error("getSpaceCredential returned a malformed credential JWT");
  }
  try {
    const payload = JSON.parse(Buffer.from(segment, "base64url").toString());
    return (payload.exp ?? 0) * 1000;
  } catch {
    throw new Error("getSpaceCredential returned a malformed credential JWT");
  }
}

async function xrpcJson(
  url: string,
  init: RequestInit,
  label: string,
): Promise<any> {
  try {
    const res = await fetch(url, init);
    if (!res.ok) {
      throw new Error(
        `${label} failed: ${res.status} ${await res.text().catch(() => "")}`,
      );
    }
    return await res.json();
  } catch (err) {
    // Already labeled by the !res.ok branch above — rethrow as-is.
    if (err instanceof Error && err.message.startsWith(`${label} failed:`)) {
      throw err;
    }
    // Label network-level failures (DNS, connection refused) and malformed
    // JSON so callers can tell which call in the exchange broke.
    throw new Error(
      `${label} failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export async function getCommunitySpaceCredential(
  db: Kysely<Database>,
  communityDid: string,
  spaceUri: string,
): Promise<string> {
  const cached = cache.get(spaceUri);
  if (cached && cached.exp - EXPIRY_BUFFER_MS > Date.now())
    return cached.credential;

  const agent = await createCommunityAgent(db, communityDid);
  const accessJwt = (agent as any).session?.accessJwt;
  if (!accessJwt) throw new Error("community agent has no active session");
  const pdsUrl = await resolvePdsEndpoint(communityDid);

  const tokenUrl = new URL(
    "/xrpc/com.atproto.space.getDelegationToken",
    pdsUrl,
  );
  tokenUrl.searchParams.set("space", spaceUri);
  const { token } = await xrpcJson(
    tokenUrl.toString(),
    { headers: { authorization: `Bearer ${accessJwt}` } },
    "getDelegationToken",
  );

  const { credential } = await xrpcJson(
    new URL("/xrpc/com.atproto.space.getSpaceCredential", pdsUrl).toString(),
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ space: spaceUri }),
    },
    "getSpaceCredential",
  );

  cache.set(spaceUri, { credential, exp: parseJwtExp(credential) });
  return credential;
}
