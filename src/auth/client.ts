import {
  Keyset,
  JoseKey,
  atprotoLoopbackClientMetadata,
  NodeOAuthClient,
  OAuthClientMetadataInput,
} from '@atproto/oauth-client-node';
import assert from 'node:assert';
import type { Kysely } from 'kysely';
import type { Database } from '../db';
import { config } from '../config';
import { SessionStore, StateStore } from './storage';

export async function createOAuthClient(db: Kysely<Database>) {
  // Confidential client requires a keyset accessible on the internet
  const keyset =
    config.serviceUrl && config.privateKeys
      ? new Keyset(
          await Promise.all(
            config.privateKeys.map((jwk: string | Record<string, unknown>) =>
              JoseKey.fromJWK(jwk)
            )
          )
        )
      : undefined;

  assert(
    !config.serviceUrl || keyset?.size,
    'ATProto requires backend clients to be confidential. Make sure to set the PRIVATE_KEYS environment variable.'
  );

  // If a keyset is defined, make sure it has a private key for signing
  const pk = keyset?.findPrivateKey({ usage: 'sign' });

  const clientMetadata: OAuthClientMetadataInput = config.serviceUrl
    ? {
        client_name: 'OpenSocial',
        client_id: `${config.serviceUrl}/oauth-client-metadata.json`,
        jwks_uri: `${config.serviceUrl}/.well-known/jwks.json`,
        redirect_uris: [`${config.serviceUrl}/oauth/callback`],
        scope: 'atproto transition:generic',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        application_type: 'web',
        token_endpoint_auth_method: pk ? 'private_key_jwt' : 'none',
        token_endpoint_auth_signing_alg: pk ? pk.alg : undefined,
        dpop_bound_access_tokens: true,
      }
    : atprotoLoopbackClientMetadata(
        `http://localhost?${new URLSearchParams([
          ['redirect_uri', `http://127.0.0.1:${config.port}/oauth/callback`],
          ['scope', `atproto transition:generic`],
        ])}`
      );

  return new NodeOAuthClient({
    keyset,
    clientMetadata,
    stateStore: new StateStore(db),
    sessionStore: new SessionStore(db),
    plcDirectoryUrl: config.plcUrl,
    handleResolver: config.pdsUrl,
  });
}
