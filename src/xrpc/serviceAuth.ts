/**
 * Verify inbound AT Protocol service-auth JWTs (e.g. the group PDS calling
 * com.atproto.simplespace.checkUserAccess as the space authority).
 * Pattern follows packages/pds/src/auth-verifier.ts in the atproto repo.
 */
import { verifyJwt } from "@atproto/xrpc-server";
import { IdResolver, getDidKeyFromMultibase } from "@atproto/identity";
import { getVerificationMaterial } from "@atproto/common";
import { config } from "../config";

export class ServiceAuthError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export type GetSigningKeyFn = (
  iss: string,
  forceRefresh: boolean,
) => Promise<string>;

const idResolver = new IdResolver({ plcUrl: config.plcUrl });

const resolveSigningKey: GetSigningKeyFn = async (iss, forceRefresh) => {
  const [did] = iss.split("#");
  const didDoc = await idResolver.did.resolve(did, forceRefresh);
  if (!didDoc)
    throw new ServiceAuthError(401, `could not resolve iss did: ${did}`);
  const parsedKey = getVerificationMaterial(didDoc, "atproto");
  if (!parsedKey)
    throw new ServiceAuthError(401, "missing atproto key in did doc");
  const didKey = getDidKeyFromMultibase(parsedKey);
  if (!didKey) throw new ServiceAuthError(401, "bad atproto key in did doc");
  return didKey;
};

export async function verifyServiceAuth(
  authorizationHeader: string | undefined,
  lxm: string,
  opts: { getSigningKey?: GetSigningKeyFn } = {},
): Promise<{ iss: string; aud: string }> {
  if (!config.serviceId)
    throw new ServiceAuthError(500, "OPENSOCIAL_SERVICE_DID is not configured");
  if (!authorizationHeader?.startsWith("Bearer ")) {
    throw new ServiceAuthError(401, "missing service auth token");
  }
  const jwt = authorizationHeader.slice("Bearer ".length).trim();
  try {
    const payload = await verifyJwt(
      jwt,
      config.serviceId,
      lxm,
      opts.getSigningKey ?? resolveSigningKey,
    );
    return { iss: payload.iss, aud: payload.aud };
  } catch (err) {
    if (err instanceof ServiceAuthError) throw err;
    throw new ServiceAuthError(
      401,
      `invalid service auth token: ${(err as Error).message}`,
    );
  }
}
