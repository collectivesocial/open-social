import { Agent, BskyAgent } from '@atproto/api';
import express, { Request, Response } from 'express';
import { getIronSession } from 'iron-session';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { NodeOAuthClient } from '@atproto/oauth-client-node';
import crypto from 'crypto';
import multer from 'multer';
import { config } from '../config';
import { sql, type Kysely } from 'kysely';
import type { Database } from '../db';
import { ensureServiceUrl, createCommunityAgent, resolvePdsEndpoint, invalidateCommunityAgent } from '../services/atproto';
import { isAdminInList, getOriginalAdminDid, normalizeAdmins } from '../lib/adminUtils';
import { encrypt, decryptIfNeeded } from '../lib/crypto';
import { hasScope, MEMBERSHIP_WRITE_SCOPE, OPENSOCIAL_SCOPES } from '../middleware/auth';
import { checkAdmin, seedCollectionPermissions } from '../services/permissions';
import { createAuditLogService } from '../services/auditLog';
import { memberRolesCache } from '../lib/cache';
import { logger } from '../lib/logger';
import { sanitizeUserContent } from '../lib/sanitize';

// Configure multer for file uploads
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 1024 * 1024, // 1MB limit
  },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Only image files are allowed'));
    }
  },
});

interface CommunityProfile {
  displayName: string;
  description?: string;
  type?: 'open' | 'admin-approved' | 'private';
  avatar?: string | { $type: string; ref: { $link: string }; mimeType: string };
}

interface MembershipRecord {
  community: string; // DID of the community
  role: string; // member, admin, moderator, etc.
  since: string; // ISO timestamp
}

interface MembershipProofRecord {
  cid: string; // CID of the user's membership record
}

// Helper to convert blob reference to CDN URL
function blobToUrl(blob: any, did: string, pdsHost: string): string | undefined {
  if (!blob) return undefined;
  if (typeof blob === 'string') return blob;
  
  // Handle BlobRef object from @atproto/api
  if (blob.ref) {
    const cid = typeof blob.ref === 'string' ? blob.ref : blob.ref.toString();
    return `${pdsHost}/xrpc/com.atproto.sync.getBlob?did=${did}&cid=${cid}`;
  }
  
  // Handle plain blob object with $type
  if (blob.$type === 'blob' && blob.ref?.$link) {
    return `${pdsHost}/xrpc/com.atproto.sync.getBlob?did=${did}&cid=${blob.ref.$link}`;
  }
  
  return undefined;
}

/**
 * Fetch the Bluesky profile avatar for a DID as a fallback
 * when no custom community avatar is set.
 */
async function fetchBlueskyAvatar(did: string): Promise<string | undefined> {
  try {
    const publicAgent = new BskyAgent({ service: 'https://public.api.bsky.app' });
    const profile = await publicAgent.getProfile({ actor: did });
    return profile.data.avatar || undefined;
  } catch (err) {
    logger.warn({ error: err, did }, 'Could not fetch Bluesky avatar');
    return undefined;
  }
}

function ifString(val: unknown): string | undefined {
  return typeof val === 'string' && val.length > 0 ? val : undefined;
}

/**
 * Resolve a Bluesky profile to get handle, display name, and avatar.
 */
async function resolveBlueskyProfile(did: string): Promise<{ handle: string | null; displayName: string | null; avatar: string | null }> {
  try {
    const res = await fetch(`https://public.api.bsky.app/xrpc/app.bsky.actor.getProfile?actor=${encodeURIComponent(did)}`);
    if (res.ok) {
      const data = await res.json() as any;
      return { handle: data.handle || null, displayName: data.displayName || null, avatar: data.avatar || null };
    }
  } catch {}
  return { handle: null, displayName: null, avatar: null };
}

type Session = { did?: string };

const MAX_AGE = config.nodeEnv === 'production' ? 60 : 300;

// Consistent session options for all session operations
const sessionOptions = {
  cookieName: 'sid',
  password: config.cookieSecret,
  cookieOptions: {
    secure: config.nodeEnv === 'production',
    sameSite: 'lax' as const,
    httpOnly: true,
    path: '/',
    // Share cookie across subdomains (api.opensocial.community ↔ app.opensocial.community)
    domain: config.nodeEnv === 'production' ? '.opensocial.community' : undefined,
  },
};

// Helper function to get the Atproto Agent for the active session
async function getSessionAgent(
  req: IncomingMessage,
  res: ServerResponse,
  oauthClient: NodeOAuthClient
) {
  res.setHeader('Vary', 'Cookie');

  const session = await getIronSession<Session>(req, res, sessionOptions);
  
  if (!session.did) {
    logger.info('No DID in session');
    return null;
  }

  res.setHeader('cache-control', `max-age=${MAX_AGE}, private`);

  try {
    const oauthSession = await oauthClient.restore(session.did);
    if (!oauthSession) return null;

    const agent = new Agent(oauthSession);

    // Attach granted scopes to the agent for downstream permission checks
    try {
      const tokenInfo = await oauthSession.getTokenInfo();
      (agent as any).__grantedScope = tokenInfo.scope;
    } catch {
      // If token info unavailable, scope checks will rely on transition:generic fallback
    }

    return agent;
  } catch (err) {
    logger.warn({ error: err }, 'OAuth restore failed');
    await session.destroy();
    return null;
  }
}

/**
 * Get the granted scope string from an agent created by getSessionAgent.
 * Returns undefined if scopes could not be determined.
 */
function getAgentScope(agent: Agent): string | undefined {
  return (agent as any).__grantedScope;
}

export function createAuthRouter(oauthClient: NodeOAuthClient, db: Kysely<Database>) {
  const router = express.Router();

  // OAuth metadata
  router.get('/oauth-client-metadata.json', (req: Request, res: Response) => {
    res.setHeader('cache-control', `max-age=${MAX_AGE}, public`);
    res.json(oauthClient.clientMetadata);
  });

  // Public keys
  router.get('/.well-known/jwks.json', (req: Request, res: Response) => {
    res.setHeader('cache-control', `max-age=${MAX_AGE}, public`);
    res.json(oauthClient.jwks);
  });

  // OAuth callback to complete session creation
  router.get('/oauth/callback', async (req: Request, res: Response) => {
    res.setHeader('cache-control', 'no-store');

    const params = new URLSearchParams(req.originalUrl.split('?')[1]);
    
    try {
      // Load the session cookie
      const session = await getIronSession<Session>(req, res, sessionOptions);

      // If the user is already signed in, destroy the old credentials
      if (session.did) {
        try {
          const oauthSession = await oauthClient.restore(session.did);
          if (oauthSession) oauthSession.signOut();
        } catch (err) {
          logger.warn({ error: err }, 'OAuth restore failed');
        }
      }

      // Complete the OAuth flow
      const oauth = await oauthClient.callback(params);

      // Update the session cookie
      session.did = oauth.session.did;

      await session.save();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'unexpected error';
      const stack = err instanceof Error ? err.stack : undefined;
      logger.error({ error: message, stack, name: err instanceof Error ? err.name : undefined }, 'OAuth callback failed');
    }

    // Redirect back to the frontend
    const redirectUrl = config.nodeEnv === 'production'
      ? config.corsOrigin || config.serviceUrl || 'http://127.0.0.1:5174'
      : 'http://127.0.0.1:5174';
    return res.redirect(redirectUrl);
  });

  // Login handler
  router.post('/login', express.urlencoded({ extended: true }), async (req: Request, res: Response) => {
    res.setHeader('cache-control', 'no-store');

    try {
      // Validate input: can be a handle, a DID or a service URL (PDS).
      const input = ifString(req.body.input);
      if (!input) {
        throw new Error('Invalid input');
      }

      // Initiate the OAuth flow
      const url = await oauthClient.authorize(input, {
        scope: OPENSOCIAL_SCOPES,
      });

      res.redirect(url.toString());
    } catch (err) {
      const message = err instanceof Error ? err.message : 'unexpected error';
      const stack = err instanceof Error ? err.stack : undefined;
      logger.error({ error: message, stack, name: err instanceof Error ? err.name : undefined }, 'OAuth authorize failed');
      return res.type('json').send({ error: message });
    }
  });

  // Logout handler
  router.post('/logout', async (req: Request, res: Response) => {
    res.setHeader('cache-control', 'no-store');

    const session = await getIronSession<Session>(req, res, sessionOptions);

    // Revoke credentials on the server
    if (session.did) {
      try {
        const oauthSession = await oauthClient.restore(session.did);
        if (oauthSession) await oauthSession.signOut();
      } catch (err) {
        logger.warn({ error: err }, 'Failed to revoke credentials');
      }
    }

    session.destroy();

    return res.json({ success: true });
  });

  // Get current user
  router.get('/users/me', async (req: Request, res: Response) => {
    try {
      const agent = await getSessionAgent(req, res, oauthClient);
      
      if (!agent) {
        return res.status(401).json({ error: 'Not authenticated' });
      }

      // Try fetching the full profile from the AppView; fall back to
      // minimal info from the DID document when no AppView is available
      // (e.g. local devnet).
      try {
        const profile = await agent.getProfile({ actor: agent.assertDid });

        return res.json({
          did: agent.assertDid,
          handle: profile.data.handle,
          displayName: profile.data.displayName,
          avatar: profile.data.avatar,
          description: profile.data.description,
        });
      } catch (profileErr) {
        logger.warn({ error: profileErr }, 'getProfile failed, returning minimal user info');

        let handle: string | undefined;
        try {
          const sessionInfo = await agent.com.atproto.server.getSession();
          handle = sessionInfo.data.handle;
        } catch {
          // ignore — handle stays undefined
        }

        return res.json({
          did: agent.assertDid,
          handle: handle || agent.assertDid,
        });
      }
    } catch (err) {
      logger.error({ error: err }, 'Failed to get user');
      return res.status(500).json({ error: 'Failed to get user' });
    }
  });

  // Get user's community memberships
  router.get('/users/me/memberships', async (req: Request, res: Response) => {
    try {
      const agent = await getSessionAgent(req, res, oauthClient);
      
      if (!agent) {
        return res.status(401).json({ error: 'Not authenticated' });
      }

      // Fetch user's membership records
      const membershipsResponse = await agent.api.com.atproto.repo.listRecords({
        repo: agent.assertDid,
        collection: 'community.opensocial.membership',
      });

      // Fetch details for each community
      const memberships = await Promise.all(
        membershipsResponse.data.records.map(async (record: any) => {
          try {
            const membershipValue = record.value as MembershipRecord;
            const communityDid = membershipValue.community;
            const membershipUri = record.uri;

            // Get community credentials from database
            const community = await db
              .selectFrom('communities')
              .selectAll()
              .where('did', '=', communityDid)
              .executeTakeFirst();

            if (!community) {
              logger.warn({ communityDid }, 'Community not found in database');
              return null;
            }

            // Create agent for the community
            const resolvedPds = await resolvePdsEndpoint(communityDid, community.pds_host);
            const communityAgent = new BskyAgent({ service: resolvedPds });
            await communityAgent.login({
              identifier: communityDid,
              password: decryptIfNeeded(community.app_password),
            });

            // Fetch community profile using the community's own agent
            try {
              const profileResponse = await communityAgent.api.com.atproto.repo.getRecord({
                repo: communityDid,
                collection: 'community.opensocial.profile',
                rkey: 'self',
              });

              const profileValue = profileResponse.data.value as CommunityProfile;

              const avatarUrl = blobToUrl(profileValue.avatar, communityDid, community.pds_host)
                || await fetchBlueskyAvatar(communityDid);

              // Check if community has confirmed this membership via membershipProof
              const proofsResponse = await communityAgent.api.com.atproto.repo.listRecords({
                repo: communityDid,
                collection: 'community.opensocial.membershipProof',
              });

              // Get the membership record details to compare CID
              const membershipRecordResponse = await agent.api.com.atproto.repo.getRecord({
                repo: agent.assertDid,
                collection: 'community.opensocial.membership',
                rkey: record.uri.split('/').pop()!,
              });

              const isConfirmed = proofsResponse.data.records.some(
                (proof: any) => {
                  const proofValue = proof.value as MembershipProofRecord;
                  // Check if the proof's CID matches the membership record's CID
                  return proofValue.cid === membershipRecordResponse.data.cid;
                }
              );

              return {
                uri: record.uri,
                cid: record.cid,
                communityDid,
                joinedAt: membershipValue.since,
                role: membershipValue.role,
                status: isConfirmed ? 'active' : 'pending',
                community: {
                  did: communityDid,
                  displayName: profileValue.displayName,
                  description: profileValue.description,
                  avatar: avatarUrl,
                },
              };
            } catch (profileErr) {
              logger.warn({ error: profileErr, communityDid }, 'Failed to fetch profile for community');
              return null;
            }
          } catch (err) {
            logger.error({ error: err }, 'Failed to process membership record');
            return null;
          }
        })
      );

      // Filter out null entries (failed fetches)
      const validMemberships = memberships.filter((m): m is NonNullable<typeof m> => m !== null);

      return res.json({ memberships: validMemberships });
    } catch (err) {
      logger.error({ error: err }, 'Failed to get memberships');
      return res.status(500).json({ error: 'Failed to get memberships' });
    }
  });

  // Create a new community
  // mode: 'create-new' — provisions a Cirrus PDS (Cloudflare Worker)
  // mode: 'connect-existing' (default) — connects an existing AT Protocol account
  router.post('/users/me/communities', async (req: Request, res: Response) => {
    try {
      const agent = await getSessionAgent(req, res, oauthClient);
      
      if (!agent) {
        return res.status(401).json({ error: 'Not authenticated' });
      }

      const mode = req.body.mode || 'connect-existing';

      // ── CREATE-NEW: Provision a Cirrus PDS ──────────────────────────
      if (mode === 'create-new') {
        const { createCommunityNewOAuthSchema } = await import('../validation/schemas');
        const parsed = createCommunityNewOAuthSchema.safeParse(req.body);
        if (!parsed.success) {
          return res.status(400).json({ error: 'Invalid input', details: parsed.error.flatten() });
        }

        const { communityName, displayName, description } = parsed.data;

        const { provisionCommunityPds } = await import('../services/cirrus-provisioner');

        let result;
        try {
          result = await provisionCommunityPds(db, {
            communityName,
            displayName,
            creatorDid: agent.assertDid,
            description,
          });
        } catch (err: any) {
          logger.error({ error: err, communityName }, 'Cirrus provisioning failed');
          return res.status(500).json({
            error: 'Failed to provision community PDS',
            details: err.message,
          });
        }

        // Create ATProto records on the new Cirrus PDS
        const communityAgent = await createCommunityAgent(db, result.did);

        try {
          // Profile record
          await communityAgent.api.com.atproto.repo.putRecord({
            repo: result.did,
            collection: 'community.opensocial.profile',
            rkey: 'self',
            record: {
              $type: 'community.opensocial.profile',
              displayName,
              description: description || '',
              type: 'open',
              createdAt: new Date().toISOString(),
            },
          });

          // Admin list
          await communityAgent.api.com.atproto.repo.putRecord({
            repo: result.did,
            collection: 'community.opensocial.admins',
            rkey: 'self',
            record: {
              $type: 'community.opensocial.admins',
              admins: [agent.assertDid],
              createdAt: new Date().toISOString(),
            },
          });
        } catch (err) {
          logger.error({ error: err, did: result.did }, 'Failed to create community records on Cirrus PDS');
        }

        // Create membership record in user's repo
        const grantedScope = getAgentScope(agent);
        if (grantedScope && !hasScope(grantedScope, MEMBERSHIP_WRITE_SCOPE)) {
          return res.status(403).json({
            error: 'Insufficient scope',
            details: `Required scope: ${MEMBERSHIP_WRITE_SCOPE}`,
          });
        }

        try {
          const membershipRecord = await agent.api.com.atproto.repo.createRecord({
            repo: agent.assertDid,
            collection: 'community.opensocial.membership',
            record: {
              $type: 'community.opensocial.membership',
              community: result.did,
              role: 'admin',
              since: new Date().toISOString(),
            },
          });

          await communityAgent.api.com.atproto.repo.createRecord({
            repo: result.did,
            collection: 'community.opensocial.membershipProof',
            record: {
              $type: 'community.opensocial.membershipProof',
              cid: membershipRecord.data.cid,
            },
          });
        } catch (err) {
          logger.error({ error: err, did: result.did }, 'Failed to create membership records');
        }

        return res.json({
          success: true,
          community: {
            did: result.did,
            handle: result.handle,
            hostname: result.hostname,
            pdsHost: result.pdsHost,
            displayName,
            description,
            pdsType: 'cirrus',
          },
        });
      }

      // ── CONNECT-EXISTING: Original flow (unchanged) ─────────────────
      const { displayName, description, did: existingDid, appPassword } = req.body;

      if (!displayName) {
        return res.status(400).json({ error: 'displayName is required' });
      }

      if (!existingDid || !appPassword) {
        return res.status(400).json({ error: 'did and appPassword are required' });
      }

      // If the user provided a handle instead of a DID, resolve it to the actual DID
      let communityDid = existingDid;
      if (!existingDid.startsWith('did:')) {
        try {
          const resolveRes = await fetch(
            `https://public.api.bsky.app/xrpc/com.atproto.identity.resolveHandle?handle=${encodeURIComponent(existingDid)}`
          );
          if (!resolveRes.ok) {
            return res.status(400).json({ error: `Could not resolve handle "${existingDid}" to a DID` });
          }
          const resolveData = await resolveRes.json() as { did: string };
          communityDid = resolveData.did;
          logger.info({ handle: existingDid, did: communityDid }, 'Resolved handle to DID for community creation');
        } catch (err) {
          logger.error({ error: err, handle: existingDid }, 'Failed to resolve handle');
          return res.status(400).json({ error: `Could not resolve handle "${existingDid}"` });
        }
      }

      let communityHandle: string;

      // Resolve DID to get handle and actual PDS endpoint
      const pdsHost = await resolvePdsEndpoint(existingDid, config.pdsUrl);
      try {
        const profile = await agent.getProfile({ actor: existingDid });
        communityHandle = profile.data.handle || existingDid;
      } catch (e) {
        logger.warn({ error: e, did: existingDid }, 'Could not resolve handle, using DID as fallback');
        communityHandle = existingDid;
      }

      // Login with app password to verify credentials
      const bskyAgent = new BskyAgent({ service: pdsHost });
      await bskyAgent.login({
        identifier: existingDid,
        password: appPassword,
      });
      const communityAgent: Agent = bskyAgent;

      // Store in database
      await db
        .insertInto('communities')
        .values({
          did: communityDid,
          handle: communityHandle,
          display_name: displayName,
          pds_host: pdsHost,
          app_password: encrypt(appPassword),
          created_at: new Date(),
          pds_type: 'external',
          provisioning_status: 'active',
        })
        .execute();

      // Create community profile
      try {
        await communityAgent.api.com.atproto.repo.putRecord({
          repo: communityDid,
          collection: 'community.opensocial.profile',
          rkey: 'self',
          record: {
            $type: 'community.opensocial.profile',
            displayName,
            description: description || '',
            type: 'open', // Default to open community
            createdAt: new Date().toISOString(),
          },
        });
      } catch (err) {
        logger.error({ error: err, did: existingDid }, 'Failed to create profile record');
        return res.status(500).json({ 
          error: 'Failed to create community profile',
          details: err instanceof Error ? err.message : 'Unknown error'
        });
      }

      // Create admin list with creator as first admin
      try {
        await communityAgent.api.com.atproto.repo.putRecord({
          repo: communityDid,
          collection: 'community.opensocial.admins',
          rkey: 'self',
          record: {
            $type: 'community.opensocial.admins',
            admins: [agent.assertDid],
            createdAt: new Date().toISOString(),
          },
        });
      } catch (err) {
        logger.error({ error: err, did: existingDid }, 'Failed to create admins list');
        return res.status(500).json({ 
          error: 'Failed to create admins list',
          details: err instanceof Error ? err.message : 'Unknown error'
        });
      }

      // Create membership record in user's repo
      // Verify the OAuth session has the required scope to write membership records
      const grantedScope = getAgentScope(agent);
      if (grantedScope && !hasScope(grantedScope, MEMBERSHIP_WRITE_SCOPE)) {
        return res.status(403).json({
          error: 'Insufficient scope',
          details: `Required scope: ${MEMBERSHIP_WRITE_SCOPE}`,
        });
      }

      const membershipRecord = await agent.api.com.atproto.repo.createRecord({
        repo: agent.assertDid,
        collection: 'community.opensocial.membership',
        record: {
          $type: 'community.opensocial.membership',
          community: communityDid,
          role: 'admin', // Creator is admin
          since: new Date().toISOString(),
        },
      });

      // Create membershipProof in community's repo using the membership record's CID
      await communityAgent.api.com.atproto.repo.createRecord({
        repo: communityDid,
        collection: 'community.opensocial.membershipProof',
        record: {
          $type: 'community.opensocial.membershipProof',
          cid: membershipRecord.data.cid,
        },
      });

      return res.json({
        success: true,
        community: {
          did: communityDid,
          handle: communityHandle,
          displayName,
          description,
          pdsType: 'external',
        },
      });
    } catch (err) {
      logger.error({ error: err }, 'Failed to create community');
      return res.status(500).json({ 
        error: 'Failed to create community',
        details: err instanceof Error ? err.message : 'Unknown error'
      });
    }
  });

  // ─── Search communities (fuzzy matching via pg_trgm) ────────────
  router.get('/communities/search', async (req: Request, res: Response) => {
    try {
      const agent = await getSessionAgent(req, res, oauthClient);
      if (!agent) {
        return res.status(401).json({ error: 'Not authenticated' });
      }

      const rawQuery = typeof req.query.query === 'string' ? req.query.query.trim()
        : typeof req.query.q === 'string' ? req.query.q.trim()
        : '';

      // Require at least 3 characters for a search query
      if (rawQuery.length > 0 && rawQuery.length < 3) {
        return res.json({ communities: [] });
      }

      const limitParam = Number(req.query.limit) || 20;
      const limit = Math.min(Math.max(limitParam, 1), 100);

      const TWENTY_FOUR_HOURS = 24 * 60 * 60 * 1000;
      const now = Date.now();

      let dbQuery = db
        .selectFrom('communities')
        .selectAll();

      if (rawQuery.length >= 3) {
        // Fuzzy search: combine trigram similarity with ILIKE fallback
        // All user input goes through Kysely parameterised bindings — safe from SQL injection
        dbQuery = dbQuery
          .where((eb) =>
            eb.or([
              eb(sql`similarity(handle, ${rawQuery})`, '>', sql`0.15`),
              eb(sql`similarity(display_name, ${rawQuery})`, '>', sql`0.15`),
              sql<boolean>`handle ILIKE ${'%' + rawQuery + '%'}`,
              sql<boolean>`display_name ILIKE ${'%' + rawQuery + '%'}`,
            ])
          )
          .orderBy(
            sql`GREATEST(similarity(handle, ${rawQuery}), similarity(display_name, ${rawQuery}))`,
            'desc'
          );
      } else {
        // No query — return top communities by member count
        dbQuery = dbQuery.orderBy(sql`COALESCE(member_count, 0)`, 'desc');
      }

      const communities = await dbQuery
        .limit(limit)
        .execute();

      // For each result, return cached metadata or refresh if stale (>24h)
      const results = await Promise.all(
        communities.map(async (c) => {
          const stale = !c.metadata_fetched_at
            || (now - new Date(c.metadata_fetched_at).getTime()) > TWENTY_FOUR_HOURS;

          if (!stale && c.description !== null) {
            return {
              did: c.did,
              handle: c.handle,
              displayName: c.display_name,
              description: c.description,
              avatar: c.avatar_url,
              type: c.community_type || 'open',
              memberCount: c.member_count ?? 0,
            };
          }

          // Refresh metadata from PDS
          try {
            const communityAgent = new BskyAgent({ service: c.pds_host });
            await communityAgent.login({
              identifier: c.handle,
              password: decryptIfNeeded(c.app_password),
            });

            let description = '';
            let avatarUrl: string | undefined;
            let communityType = 'open';

            try {
              const profileRes = await communityAgent.api.com.atproto.repo.getRecord({
                repo: c.did,
                collection: 'community.opensocial.profile',
                rkey: 'self',
              });
              const pv = profileRes.data.value as any;
              description = pv.description || '';
              communityType = pv.type || 'open';
              avatarUrl = blobToUrl(pv.avatar, c.did, c.pds_host)
                || await fetchBlueskyAvatar(c.did);
            } catch {}

            let memberCount = 0;
            try {
              let cursor: string | undefined;
              do {
                const membersRes = await communityAgent.api.com.atproto.repo.listRecords({
                  repo: c.did,
                  collection: 'community.opensocial.membershipProof',
                  limit: 100,
                  cursor,
                });
                memberCount += membersRes.data.records.length;
                cursor = membersRes.data.cursor;
              } while (cursor);
            } catch {}

            // Update cache in database (fire-and-forget)
            db.updateTable('communities')
              .set({
                description,
                avatar_url: avatarUrl || null,
                community_type: communityType,
                member_count: memberCount,
                metadata_fetched_at: new Date(),
              })
              .where('did', '=', c.did)
              .execute()
              .catch((err) => logger.warn({ error: err, communityDid: c.did }, 'Failed to update community metadata cache'));

            return {
              did: c.did,
              handle: c.handle,
              displayName: c.display_name,
              description,
              avatar: avatarUrl || null,
              type: communityType,
              memberCount,
            };
          } catch (err) {
            // Return what we have from cache
            return {
              did: c.did,
              handle: c.handle,
              displayName: c.display_name,
              description: c.description || '',
              avatar: c.avatar_url || null,
              type: c.community_type || 'open',
              memberCount: c.member_count ?? 0,
            };
          }
        })
      );

      return res.json({ communities: results });
    } catch (err) {
      logger.error({ error: err }, 'Community search error');
      return res.status(500).json({ error: 'Search failed' });
    }
  });

  // Get community details
  router.get('/communities/:did', async (req: Request, res: Response) => {
    try {
      const agent = await getSessionAgent(req, res, oauthClient);

      const communityDid = decodeURIComponent(req.params.did);

      // Get community from database
      const community = await db
        .selectFrom('communities')
        .selectAll()
        .where('did', '=', communityDid)
        .executeTakeFirst();

      if (!community) {
        return res.status(404).json({ error: 'Community not found' });
      }

      // Try to create community agent — may fail if app password is revoked
      let communityAgent: BskyAgent | null = null;
      let credentialError = false;
      try {
        communityAgent = await createCommunityAgent(db, communityDid);
      } catch (err) {
        const message = err instanceof Error ? err.message : '';
        // Detect auth failures (401, "Invalid identifier or password", etc.)
        if (
          message.includes('Invalid identifier or password') ||
          message.includes('AuthenticationRequired') ||
          message.includes('Authentication Required')
        ) {
          credentialError = true;
          logger.warn({ communityDid }, 'Community has invalid credentials — app password may need updating');
        } else {
          // Re-throw non-credential errors
          throw err;
        }
      }

      // When community agent is unavailable (credential error), use the actual PDS
      // for reading public records. The Bluesky AppView (public.api.bsky.app) only
      // supports Bluesky collections, not custom ones like community.opensocial.*.
      let publicRecordAgent: BskyAgent | null = null;
      if (!communityAgent) {
        try {
          const pdsUrl = await resolvePdsEndpoint(communityDid, community.pds_host);
          publicRecordAgent = new BskyAgent({ service: pdsUrl });
        } catch (err) {
          logger.warn({ error: err, communityDid }, 'Failed to create public record agent');
        }
      }
      const recordAgent = communityAgent || publicRecordAgent;

      // Fetch community profile
      let profileValue: CommunityProfile = {
        displayName: community.display_name || community.handle,
        description: '',
        type: 'open',
      } as CommunityProfile;
      if (recordAgent) {
        try {
          const profileResponse = await recordAgent.api.com.atproto.repo.getRecord({
            repo: communityDid,
            collection: 'community.opensocial.profile',
            rkey: 'self',
          });
          profileValue = profileResponse.data.value as CommunityProfile;
        } catch {
          // Profile record not yet created — use defaults
        }
      }

      const avatarUrl = blobToUrl(profileValue.avatar, communityDid, community.pds_host)
        || await fetchBlueskyAvatar(communityDid);

      // Count members (membership proofs)
      let memberCount = 0;
      let proofsRecords: any[] = [];
      if (recordAgent) {
        try {
          const proofsResponse = await recordAgent.api.com.atproto.repo.listRecords({
            repo: communityDid,
            collection: 'community.opensocial.membershipProof',
          });
          proofsRecords = proofsResponse.data.records;
          memberCount = proofsRecords.length;
        } catch {
          // No membership proofs yet
        }
      }

      // Check if user is admin (readable from public PDS records without auth)
      let adminsValue: { admins: string[] } = { admins: [] };
      if (recordAgent) {
        try {
          const adminsResponse = await recordAgent.api.com.atproto.repo.getRecord({
            repo: communityDid,
            collection: 'community.opensocial.admins',
            rkey: 'self',
          });
          adminsValue = adminsResponse.data.value as { admins: string[] };
        } catch {
          // Admins record not yet created
        }
      }

      // If not authenticated, return public community info only
      if (!agent) {
        return res.json({
          community: {
            did: communityDid,
            displayName: profileValue.displayName,
            description: profileValue.description,
            type: profileValue.type || 'open',
            avatar: avatarUrl,
          },
          memberCount,
          isAdmin: false,
          isMember: false,
          isPrimaryAdmin: false,
          isAuthenticated: false,
          userRole: undefined,
          // Only expose credential error to non-authenticated users so they see the page
          credentialError: credentialError || undefined,
        });
      }

      const isAdmin = adminsValue.admins.includes(agent.assertDid);
      const primaryAdminDid = getOriginalAdminDid(adminsValue.admins);

      // Get user's role from their membership record
      const membershipResponse = await agent.api.com.atproto.repo.listRecords({
        repo: agent.assertDid,
        collection: 'community.opensocial.membership',
      });

      const userMembership = membershipResponse.data.records.find((record: any) => {
        const value = record.value as MembershipRecord;
        return value.community === communityDid;
      });

      const userRole = userMembership ? (userMembership.value as MembershipRecord).role : undefined;

      // Check if user is a confirmed member (has membershipProof)
      const isMember = isAdmin || proofsRecords.some(
        (proof: any) => {
          // Check if this proof matches the user's membership CID
          if (!userMembership) return false;
          return proof.value.cid === userMembership.cid;
        }
      );

      return res.json({
        community: {
          did: communityDid,
          displayName: profileValue.displayName,
          description: profileValue.description,
          type: profileValue.type || 'open',
          avatar: avatarUrl,
        },
        memberCount,
        isAdmin,
        isMember,
        isPrimaryAdmin: agent.assertDid === primaryAdminDid,
        isAuthenticated: true,
        userRole,
        // Only expose credential error flag to admins
        credentialError: isAdmin ? credentialError : undefined,
      });
    } catch (err) {
      logger.error({ error: err, communityDid: req.params.did }, 'Failed to get community details');
      return res.status(500).json({ 
        error: 'Failed to get community details',
        details: err instanceof Error ? err.message : 'Unknown error'
      });
    }
  });

  // Join a community (session-based, for web UI)
  router.post('/communities/:did/join', async (req: Request, res: Response) => {
    try {
      const agent = await getSessionAgent(req, res, oauthClient);
      if (!agent) {
        return res.status(401).json({ error: 'Not authenticated' });
      }

      const communityDid = decodeURIComponent(req.params.did);

      // Get community from database
      const community = await db
        .selectFrom('communities')
        .selectAll()
        .where('did', '=', communityDid)
        .executeTakeFirst();

      if (!community) {
        return res.status(404).json({ error: 'Community not found' });
      }

      // Create community agent
      const communityAgent = await createCommunityAgent(db, communityDid);

      // Check if already a member
      let cursor: string | undefined;
      let alreadyMember = false;
      do {
        const response = await communityAgent.api.com.atproto.repo.listRecords({
          repo: communityDid,
          collection: 'community.opensocial.membershipProof',
          limit: 100,
          cursor,
        });
        alreadyMember = response.data.records.some(
          (r: any) => r.value.memberDid === agent.assertDid
        );
        cursor = response.data.cursor;
      } while (cursor && !alreadyMember);

      if (alreadyMember) {
        return res.json({ status: 'already_member', message: 'You are already a member of this community' });
      }

      // Check scope
      const grantedScope = getAgentScope(agent);
      if (grantedScope && !hasScope(grantedScope, MEMBERSHIP_WRITE_SCOPE)) {
        return res.status(403).json({
          error: 'Insufficient scope',
          details: `Required scope: ${MEMBERSHIP_WRITE_SCOPE}. Please log out and log back in to grant the required permissions.`,
        });
      }

      // Check community type
      let communityType = 'open';
      try {
        const profileRes = await communityAgent.api.com.atproto.repo.getRecord({
          repo: communityDid,
          collection: 'community.opensocial.profile',
          rkey: 'self',
        });
        communityType = (profileRes.data.value as any)?.type || 'open';
      } catch {}

      // Create membership record in user's repo
      const membershipRecord = await agent.api.com.atproto.repo.createRecord({
        repo: agent.assertDid,
        collection: 'community.opensocial.membership',
        record: {
          $type: 'community.opensocial.membership',
          community: communityDid,
          role: 'member',
          since: new Date().toISOString(),
        },
      });

      if (communityType === 'admin-approved') {
        // Add to pending_members table
        const existing = await db
          .selectFrom('pending_members')
          .selectAll()
          .where('community_did', '=', communityDid)
          .where('user_did', '=', agent.assertDid)
          .where('status', '=', 'pending')
          .executeTakeFirst();

        if (!existing) {
          await db
            .insertInto('pending_members')
            .values({
              community_did: communityDid,
              user_did: agent.assertDid,
              status: 'pending',
            })
            .execute();
        }

        return res.json({
          status: 'pending',
          message: 'Join request submitted. An admin must approve your request.',
        });
      }

      // Open community — create membershipProof in community's repo
      await communityAgent.api.com.atproto.repo.createRecord({
        repo: communityDid,
        collection: 'community.opensocial.membershipProof',
        record: {
          $type: 'community.opensocial.membershipProof',
          memberDid: agent.assertDid,
          cid: membershipRecord.data.cid,
          confirmedAt: new Date().toISOString(),
        },
      });

      return res.json({
        status: 'joined',
        message: 'Successfully joined the community',
      });
    } catch (err) {
      logger.error({ error: err, communityDid: req.params.did }, 'Failed to join community');
      return res.status(500).json({
        error: 'Failed to join community',
        details: err instanceof Error ? err.message : 'Unknown error',
      });
    }
  });

  // Upload community avatar
  router.post('/communities/:did/avatar', upload.single('avatar'), async (req: Request, res: Response) => {
    try {
      const agent = await getSessionAgent(req, res, oauthClient);
      if (!agent) {
        return res.status(401).json({ error: 'Not authenticated' });
      }

      const communityDid = decodeURIComponent(req.params.did);

      // Get community from database
      const community = await db
        .selectFrom('communities')
        .selectAll()
        .where('did', '=', communityDid)
        .executeTakeFirst();

      if (!community) {
        return res.status(404).json({ error: 'Community not found' });
      }

      // Check if user is admin
      const communityAgent = await createCommunityAgent(db, communityDid);

      const adminsResponse = await communityAgent.api.com.atproto.repo.getRecord({
        repo: communityDid,
        collection: 'community.opensocial.admins',
        rkey: 'self',
      });

      const adminsValue = adminsResponse.data.value as { admins: string[] };
      if (!adminsValue.admins.includes(agent.assertDid)) {
        return res.status(403).json({ error: 'Not authorized. Must be an admin.' });
      }

      // Get uploaded file from multipart form data
      const file = req.file;
      if (!file) {
        return res.status(400).json({ error: 'No file uploaded' });
      }

      // Upload blob to community's PDS
      const uploadResponse = await communityAgent.api.com.atproto.repo.uploadBlob(file.buffer, {
        encoding: file.mimetype,
      });

      const blobRef = uploadResponse.data.blob;

      // Update community profile with new avatar
      const profileResponse = await communityAgent.api.com.atproto.repo.getRecord({
        repo: communityDid,
        collection: 'community.opensocial.profile',
        rkey: 'self',
      });

      const currentProfile = profileResponse.data.value as CommunityProfile;

      await communityAgent.api.com.atproto.repo.putRecord({
        repo: communityDid,
        collection: 'community.opensocial.profile',
        rkey: 'self',
        record: {
          ...currentProfile,
          $type: 'community.opensocial.profile',
          avatar: blobRef,
        },
      });

      return res.json({ success: true, avatar: blobRef });
    } catch (err) {
      logger.error({ error: err, communityDid: req.params.did }, 'Failed to upload avatar');
      return res.status(500).json({ 
        error: 'Failed to upload avatar',
        details: err instanceof Error ? err.message : 'Unknown error'
      });
    }
  });

  // Upload community banner (or reuse Bluesky banner)
  router.post('/communities/:did/banner', upload.single('banner'), async (req: Request, res: Response) => {
    try {
      const agent = await getSessionAgent(req, res, oauthClient);
      if (!agent) {
        return res.status(401).json({ error: 'Not authenticated' });
      }

      const communityDid = decodeURIComponent(req.params.did);

      const community = await db
        .selectFrom('communities')
        .selectAll()
        .where('did', '=', communityDid)
        .executeTakeFirst();

      if (!community) {
        return res.status(404).json({ error: 'Community not found' });
      }

      const communityAgent = await createCommunityAgent(db, communityDid);

      // Check if user is admin
      const adminsResponse = await communityAgent.api.com.atproto.repo.getRecord({
        repo: communityDid,
        collection: 'community.opensocial.admins',
        rkey: 'self',
      });

      const adminsValue = adminsResponse.data.value as { admins: string[] };
      if (!isAdminInList(agent.assertDid, adminsValue.admins || adminsValue)) {
        return res.status(403).json({ error: 'Not authorized. Must be an admin.' });
      }

      let blobRef: any;

      if (req.body.reuseBluesky === 'true' || req.body.reuseBluesky === true) {
        // Reuse the creator's Bluesky banner
        const creatorDid = agent.assertDid;
        try {
          const bskyProfile = await agent.getProfile({ actor: creatorDid });
          if (!bskyProfile.data.banner) {
            return res.status(404).json({ error: 'No Bluesky banner found on your profile' });
          }
          // Fetch the banner blob and re-upload to community PDS
          const bannerUrl = bskyProfile.data.banner;
          const bannerRes = await fetch(bannerUrl);
          if (!bannerRes.ok) {
            return res.status(500).json({ error: 'Failed to fetch Bluesky banner' });
          }
          const bannerData = new Uint8Array(await bannerRes.arrayBuffer());
          const contentType = bannerRes.headers.get('content-type') || 'image/jpeg';
          const uploadResponse = await communityAgent.api.com.atproto.repo.uploadBlob(bannerData, {
            encoding: contentType,
          });
          blobRef = uploadResponse.data.blob;
        } catch (e) {
          logger.error({ error: e, communityDid: req.params.did }, 'Failed to reuse Bluesky banner');
          return res.status(500).json({ error: 'Failed to reuse Bluesky banner' });
        }
      } else {
        // Use uploaded file
        const file = req.file;
        if (!file) {
          return res.status(400).json({ error: 'No file uploaded. Send a banner file or set reuseBluesky=true' });
        }

        const uploadResponse = await communityAgent.api.com.atproto.repo.uploadBlob(file.buffer, {
          encoding: file.mimetype,
        });
        blobRef = uploadResponse.data.blob;
      }

      // Update community profile with new banner
      const profileResponse = await communityAgent.api.com.atproto.repo.getRecord({
        repo: communityDid,
        collection: 'community.opensocial.profile',
        rkey: 'self',
      });

      const currentProfile = profileResponse.data.value as CommunityProfile;

      await communityAgent.api.com.atproto.repo.putRecord({
        repo: communityDid,
        collection: 'community.opensocial.profile',
        rkey: 'self',
        record: {
          ...currentProfile,
          $type: 'community.opensocial.profile',
          banner: blobRef,
        },
      });

      return res.json({ success: true, banner: blobRef });
    } catch (err) {
      logger.error({ error: err, communityDid: req.params.did }, 'Failed to upload banner');
      return res.status(500).json({ 
        error: 'Failed to upload banner',
        details: err instanceof Error ? err.message : 'Unknown error'
      });
    }
  });

  // Update community profile (name and description)
  router.put('/communities/:did/profile', async (req: Request, res: Response) => {
    try {
      const agent = await getSessionAgent(req, res, oauthClient);
      if (!agent) {
        return res.status(401).json({ error: 'Not authenticated' });
      }

      const communityDid = decodeURIComponent(req.params.did);
      const { displayName, description, type } = req.body;

      // Validate input
      if (!displayName || typeof displayName !== 'string' || !displayName.trim()) {
        return res.status(400).json({ error: 'displayName is required' });
      }

      // Validate type if provided
      if (type && !['open', 'admin-approved', 'private'].includes(type)) {
        return res.status(400).json({ error: 'type must be "open", "admin-approved", or "private"' });
      }

      // Get community from database
      const community = await db
        .selectFrom('communities')
        .selectAll()
        .where('did', '=', communityDid)
        .executeTakeFirst();

      if (!community) {
        return res.status(404).json({ error: 'Community not found' });
      }

      // Create community agent
      const communityAgent = await createCommunityAgent(db, communityDid);

      // Check if user is admin
      const adminsResponse = await communityAgent.api.com.atproto.repo.getRecord({
        repo: communityDid,
        collection: 'community.opensocial.admins',
        rkey: 'self',
      });

      const adminsValue = adminsResponse.data.value as { admins: string[] };
      if (!adminsValue.admins.includes(agent.assertDid)) {
        return res.status(403).json({ error: 'Not authorized. Must be an admin.' });
      }

      // Get current profile
      const profileResponse = await communityAgent.api.com.atproto.repo.getRecord({
        repo: communityDid,
        collection: 'community.opensocial.profile',
        rkey: 'self',
      });

      const currentProfile = profileResponse.data.value as CommunityProfile;

      // Sanitize user input to prevent XSS
      const sanitizedDescription = description ? sanitizeUserContent(description.trim()) : '';

      // Update profile with new values
      await communityAgent.api.com.atproto.repo.putRecord({
        repo: communityDid,
        collection: 'community.opensocial.profile',
        rkey: 'self',
        record: {
          ...currentProfile,
          $type: 'community.opensocial.profile',
          displayName: displayName.trim(),
          description: sanitizedDescription,
          type: type || currentProfile.type || 'open',
        },
      });

      return res.json({ success: true });
    } catch (err) {
      logger.error({ error: err, communityDid: req.params.did }, 'Failed to update community profile');
      return res.status(500).json({ 
        error: 'Failed to update community profile',
        details: err instanceof Error ? err.message : 'Unknown error'
      });
    }
  });

  // Update community app password (for when the old one is revoked)
  router.put('/communities/:did/app-password', async (req: Request, res: Response) => {
    try {
      const agent = await getSessionAgent(req, res, oauthClient);
      if (!agent) {
        return res.status(401).json({ error: 'Not authenticated' });
      }

      const communityDid = decodeURIComponent(req.params.did);
      const { appPassword } = req.body;

      if (!appPassword || typeof appPassword !== 'string' || !appPassword.trim()) {
        return res.status(400).json({ error: 'appPassword is required' });
      }

      // Check community exists
      const community = await db
        .selectFrom('communities')
        .selectAll()
        .where('did', '=', communityDid)
        .executeTakeFirst();

      if (!community) {
        return res.status(404).json({ error: 'Community not found' });
      }

      // Verify the caller is an admin via public PDS API (since the community agent may not work).
      // We use the actual PDS, not the Bluesky AppView, because custom collections
      // like community.opensocial.admins are only served by the PDS.
      try {
        const pdsUrl = await resolvePdsEndpoint(communityDid, community.pds_host);
        const pdsAgent = new BskyAgent({ service: pdsUrl });
        const adminsResponse = await pdsAgent.api.com.atproto.repo.getRecord({
          repo: communityDid,
          collection: 'community.opensocial.admins',
          rkey: 'self',
        });
        const adminsValue = adminsResponse.data.value as { admins: string[] };
        if (!adminsValue.admins.includes(agent.assertDid)) {
          return res.status(403).json({ error: 'Not authorized. Must be an admin.' });
        }
      } catch (err) {
        logger.error({ error: err, communityDid }, 'Failed to verify admin status');
        return res.status(403).json({ error: 'Could not verify admin status' });
      }

      // Verify the new app password works by attempting login
      const pdsUrl = await resolvePdsEndpoint(communityDid, community.pds_host);
      const testAgent = new BskyAgent({ service: pdsUrl });
      try {
        await testAgent.login({
          identifier: communityDid,
          password: appPassword.trim(),
        });
      } catch (err) {
        logger.warn({ error: err, communityDid }, 'New app password verification failed');
        return res.status(400).json({
          error: 'Invalid app password. Please make sure you created a new app password in Bluesky settings and copied it correctly.',
        });
      }

      // Password verified — update the database
      await db
        .updateTable('communities')
        .set({
          app_password: encrypt(appPassword.trim()),
          pds_host: pdsUrl, // Also update PDS host in case it changed
        })
        .where('did', '=', communityDid)
        .execute();

      // Evict the old cached agent so the next request uses the new password
      invalidateCommunityAgent(communityDid);

      logger.info({ communityDid, updatedBy: agent.assertDid }, 'Community app password updated');

      return res.json({ success: true });
    } catch (err) {
      logger.error({ error: err, communityDid: req.params.did }, 'Failed to update app password');
      return res.status(500).json({
        error: 'Failed to update app password',
        details: err instanceof Error ? err.message : 'Unknown error',
      });
    }
  });

  // Delete a community
  router.delete('/communities/:did', async (req: Request, res: Response) => {
    try {
      const agent = await getSessionAgent(req, res, oauthClient);
      
      if (!agent) {
        return res.status(401).json({ error: 'Not authenticated' });
      }

      const { did } = req.params;
      const userDid = agent.assertDid;

      // Get community credentials from database
      const community = await db
        .selectFrom('communities')
        .selectAll()
        .where('did', '=', did)
        .executeTakeFirst();

      if (!community) {
        return res.status(404).json({ error: 'Community not found' });
      }

      // Create agent for the community
      const communityAgent = await createCommunityAgent(db, did);

      // Fetch admins to verify permissions
      const adminRecord = await communityAgent.api.com.atproto.repo.getRecord({
        repo: did,
        collection: 'community.opensocial.admins',
        rkey: 'self',
      });

      const admins = (adminRecord.data.value as any).admins || [];

      // Check if user is an admin
      const isAdmin = admins.some((admin: any) =>
        typeof admin === 'string' ? admin === userDid : admin.did === userDid
      );
      if (!isAdmin) {
        return res.status(403).json({
          error: 'Only admins can delete a community',
        });
      }

      // Check if there's only one admin
      if (admins.length > 1) {
        return res.status(403).json({
          error: 'Community can only be deleted when there is a single admin',
        });
      }

      // If this is a Cirrus-hosted community, deprovision the PDS
      if (community.pds_type === 'cirrus') {
        const { deprovisionCommunityPds } = await import('../services/cirrus-provisioner');
        await deprovisionCommunityPds(db, did);
      }

      // Delete from database
      await db
        .deleteFrom('communities')
        .where('did', '=', did)
        .execute();

      return res.json({
        success: true,
        message: 'Community deleted successfully',
      });
    } catch (err) {
      logger.error({ error: err, communityDid: req.params.did }, 'Failed to delete community');
      return res.status(500).json({ 
        error: 'Failed to delete community',
        details: err instanceof Error ? err.message : 'Unknown error'
      });
    }
  });

  // ── Secret management for Cirrus communities ─────────────────────────

  // Export all secrets for backup (admin only, Cirrus communities only)
  router.get('/communities/:did/secrets/backup', async (req: Request, res: Response) => {
    try {
      const agent = await getSessionAgent(req, res, oauthClient);
      if (!agent) {
        return res.status(401).json({ error: 'Not authenticated' });
      }

      const { did } = req.params;
      const userDid = agent.assertDid;

      const community = await db
        .selectFrom('communities')
        .select(['pds_type'])
        .where('did', '=', did)
        .executeTakeFirst();

      if (!community) {
        return res.status(404).json({ error: 'Community not found' });
      }

      if (community.pds_type !== 'cirrus') {
        return res.status(400).json({ error: 'Secret backup is only available for Cirrus-hosted communities' });
      }

      // Verify admin status
      const communityAgent = await createCommunityAgent(db, did);
      const adminRecord = await communityAgent.api.com.atproto.repo.getRecord({
        repo: did,
        collection: 'community.opensocial.admins',
        rkey: 'self',
      });

      const admins = (adminRecord.data.value as any).admins || [];
      const isAdmin = admins.some((admin: any) =>
        typeof admin === 'string' ? admin === userDid : admin.did === userDid
      );

      if (!isAdmin) {
        return res.status(403).json({ error: 'Only admins can export secrets' });
      }

      const { exportSecrets } = await import('../services/secret-store');
      const secrets = await exportSecrets(db, did);

      // Log the export in audit log
      try {
        await db
          .insertInto('audit_log')
          .values({
            community_did: did,
            admin_did: userDid,
            action: 'secrets.exported',
          })
          .execute();
      } catch (auditErr) {
        logger.warn({ error: auditErr }, 'Failed to log secret export');
      }

      return res.json({ did, secrets });
    } catch (err) {
      logger.error({ error: err, communityDid: req.params.did }, 'Failed to export secrets');
      return res.status(500).json({ error: 'Failed to export secrets' });
    }
  });

  // Rotate a specific secret (admin only, Cirrus communities only)
  router.post('/communities/:did/secrets/rotate/:secretName', async (req: Request, res: Response) => {
    try {
      const agent = await getSessionAgent(req, res, oauthClient);
      if (!agent) {
        return res.status(401).json({ error: 'Not authenticated' });
      }

      const { did, secretName } = req.params;
      const userDid = agent.assertDid;

      const community = await db
        .selectFrom('communities')
        .select(['pds_type', 'worker_name'])
        .where('did', '=', did)
        .executeTakeFirst();

      if (!community) {
        return res.status(404).json({ error: 'Community not found' });
      }

      if (community.pds_type !== 'cirrus') {
        return res.status(400).json({ error: 'Secret rotation is only available for Cirrus-hosted communities' });
      }

      // Verify admin status
      const communityAgent = await createCommunityAgent(db, did);
      const adminRecord = await communityAgent.api.com.atproto.repo.getRecord({
        repo: did,
        collection: 'community.opensocial.admins',
        rkey: 'self',
      });

      const admins = (adminRecord.data.value as any).admins || [];
      const isAdmin = admins.some((admin: any) =>
        typeof admin === 'string' ? admin === userDid : admin.did === userDid
      );

      if (!isAdmin) {
        return res.status(403).json({ error: 'Only admins can rotate secrets' });
      }

      const allowedSecrets = ['auth_token', 'jwt_secret'];
      if (!allowedSecrets.includes(secretName)) {
        return res.status(400).json({
          error: `Cannot rotate "${secretName}". Allowed: ${allowedSecrets.join(', ')}`,
        });
      }

      const crypto = await import('crypto');
      const newValue = crypto.randomBytes(32).toString('hex');

      // Update Cloudflare Worker secret
      if (community.worker_name) {
        const { setWorkerSecrets } = await import('../services/cloudflare');
        const cfSecretName = secretName === 'auth_token' ? 'AUTH_TOKEN' : 'JWT_SECRET';
        await setWorkerSecrets(community.worker_name, { [cfSecretName]: newValue } as any);
      }

      // Update in database
      const { rotateSecret } = await import('../services/secret-store');
      await rotateSecret(db, did, secretName as any, newValue);

      // Audit log
      try {
        await db
          .insertInto('audit_log')
          .values({
            community_did: did,
            admin_did: userDid,
            action: 'secrets.rotated',
            metadata: JSON.stringify({ secretName }),
          })
          .execute();
      } catch (auditErr) {
        logger.warn({ error: auditErr }, 'Failed to log secret rotation');
      }

      return res.json({ success: true, secretName, rotatedAt: new Date().toISOString() });
    } catch (err) {
      logger.error({ error: err, communityDid: req.params.did }, 'Failed to rotate secret');
      return res.status(500).json({ error: 'Failed to rotate secret' });
    }
  });

  // ── Admin member management routes ─────────────────────────────────────

  // List all group members (admin only), with optional ?search= DID filter
  router.get('/communities/:did/members', async (req: Request, res: Response) => {
    try {
      const agent = await getSessionAgent(req, res, oauthClient);
      if (!agent) {
        return res.status(401).json({ error: 'Not authenticated' });
      }

      const communityDid = decodeURIComponent(req.params.did);
      const search = req.query.search as string | undefined;

      // Get community from database
      const community = await db
        .selectFrom('communities')
        .selectAll()
        .where('did', '=', communityDid)
        .executeTakeFirst();

      if (!community) {
        return res.status(404).json({ error: 'Community not found' });
      }

      // Create community agent
      const communityAgent = await createCommunityAgent(db, communityDid);

      // Verify caller is an admin
      const adminsResponse = await communityAgent.api.com.atproto.repo.getRecord({
        repo: communityDid,
        collection: 'community.opensocial.admins',
        rkey: 'self',
      });

      const admins = (adminsResponse.data.value as any).admins || [];
      if (!isAdminInList(agent.assertDid, admins)) {
        return res.status(403).json({ error: 'Not authorized. Must be an admin.' });
      }

      // List all membershipProof records (paginated)
      let cursor: string | undefined;
      const allProofs: any[] = [];
      do {
        const response = await communityAgent.api.com.atproto.repo.listRecords({
          repo: communityDid,
          collection: 'community.opensocial.membershipProof',
          limit: 100,
          cursor,
        });
        allProofs.push(...response.data.records);
        cursor = response.data.cursor;
      } while (cursor);

      // Build member list
      let members = allProofs.map((record: any) => ({
        uri: record.uri,
        did: record.value.memberDid || null,
        cid: record.value.cid,
        confirmedAt: record.value.confirmedAt || null,
        isAdmin: record.value.memberDid
          ? isAdminInList(record.value.memberDid, admins)
          : false,
      }));

      // Filter by DID or handle search
      if (search) {
        members = members.filter(
          (m) => m.did && m.did.toLowerCase().includes(search.toLowerCase())
        );
      }

      // Resolve Bluesky profiles (handle + avatar) for each member
      const enriched = await Promise.all(
        members.map(async (member) => {
          if (!member.did) return { ...member, handle: null, displayName: null, avatar: null };
          const profile = await resolveBlueskyProfile(member.did);
          return { ...member, ...profile };
        })
      );

      // If search term didn't match a DID, also filter by resolved handle
      let results = enriched;
      if (search) {
        const lowerSearch = search.toLowerCase();
        results = enriched.filter(
          (m) =>
            (m.did && m.did.toLowerCase().includes(lowerSearch)) ||
            (m.handle && m.handle.toLowerCase().includes(lowerSearch))
        );
      }

      // Fetch custom role assignments for all members
      const memberDids = results.map((m) => m.did).filter(Boolean) as string[];
      let roleAssignments: { member_did: string; role_name: string }[] = [];
      if (memberDids.length > 0) {
        roleAssignments = await db
          .selectFrom('community_member_roles')
          .select(['member_did', 'role_name'])
          .where('community_did', '=', communityDid)
          .where('member_did', 'in', memberDids)
          .execute();
      }

      // Fetch role display names
      const roleNames = [...new Set(roleAssignments.map((r) => r.role_name))];
      let roleDisplayNames: Record<string, string> = {};
      if (roleNames.length > 0) {
        const roles = await db
          .selectFrom('community_roles')
          .select(['name', 'display_name'])
          .where('community_did', '=', communityDid)
          .where('name', 'in', roleNames)
          .execute();
        roleDisplayNames = Object.fromEntries(roles.map((r) => [r.name, r.display_name]));
      }

      // Build per-member role arrays
      const rolesByMember = new Map<string, { name: string; displayName: string }[]>();
      for (const ra of roleAssignments) {
        if (!rolesByMember.has(ra.member_did)) rolesByMember.set(ra.member_did, []);
        rolesByMember.get(ra.member_did)!.push({
          name: ra.role_name,
          displayName: roleDisplayNames[ra.role_name] || ra.role_name,
        });
      }

      const primaryAdminDid = getOriginalAdminDid(admins);

      const resultsWithRoles = results.map((m) => ({
        ...m,
        roles: m.did ? rolesByMember.get(m.did) || [] : [],
        isPrimaryAdmin: m.did === primaryAdminDid,
      }));

      return res.json({ members: resultsWithRoles, total: resultsWithRoles.length, primaryAdminDid });
    } catch (err) {
      logger.error({ error: err, communityDid: req.params.did }, 'Failed to list members');
      return res.status(500).json({
        error: 'Failed to list members',
        details: err instanceof Error ? err.message : 'Unknown error',
      });
    }
  });

  // Promote a member to admin
  router.post('/communities/:did/members/:memberDid/admin', async (req: Request, res: Response) => {
    try {
      const agent = await getSessionAgent(req, res, oauthClient);
      if (!agent) {
        return res.status(401).json({ error: 'Not authenticated' });
      }

      const communityDid = decodeURIComponent(req.params.did);
      const memberDid = decodeURIComponent(req.params.memberDid);

      const community = await db
        .selectFrom('communities')
        .selectAll()
        .where('did', '=', communityDid)
        .executeTakeFirst();

      if (!community) {
        return res.status(404).json({ error: 'Community not found' });
      }

      const communityAgent = await createCommunityAgent(db, communityDid);

      // Verify caller is an admin
      const adminsResponse = await communityAgent.api.com.atproto.repo.getRecord({
        repo: communityDid,
        collection: 'community.opensocial.admins',
        rkey: 'self',
      });

      const admins = (adminsResponse.data.value as any).admins || [];
      if (!isAdminInList(agent.assertDid, admins)) {
        return res.status(403).json({ error: 'Not authorized. Must be an admin.' });
      }

      // Check if already an admin
      if (isAdminInList(memberDid, admins)) {
        return res.status(409).json({ error: 'Member is already an admin.' });
      }

      // Verify the member has a membershipProof in this community
      let cursor: string | undefined;
      let found = false;
      do {
        const response = await communityAgent.api.com.atproto.repo.listRecords({
          repo: communityDid,
          collection: 'community.opensocial.membershipProof',
          limit: 100,
          cursor,
        });
        found = response.data.records.some(
          (r: any) => r.value.memberDid === memberDid
        );
        cursor = response.data.cursor;
      } while (cursor && !found);

      if (!found) {
        return res.status(404).json({ error: 'Member not found in this community.' });
      }

      // Add member to admin list (normalize to canonical format)
      const updatedAdmins = normalizeAdmins(admins);
      updatedAdmins.push({ did: memberDid, addedAt: new Date().toISOString() });

      await communityAgent.api.com.atproto.repo.putRecord({
        repo: communityDid,
        collection: 'community.opensocial.admins',
        rkey: 'self',
        record: {
          $type: 'community.opensocial.admins',
          admins: updatedAdmins,
        },
      });

      await auditLog.log({ communityDid, adminDid: agent.assertDid, action: 'admin.promoted', targetDid: memberDid });

      return res.json({ success: true, admins: updatedAdmins });
    } catch (err) {
      logger.error({ error: err, communityDid: req.params.did, memberDid: req.params.memberDid }, 'Failed to promote member to admin');
      return res.status(500).json({
        error: 'Failed to promote member to admin',
        details: err instanceof Error ? err.message : 'Unknown error',
      });
    }
  });

  // Demote an admin (cannot demote the original group creator)
  router.delete('/communities/:did/members/:memberDid/admin', async (req: Request, res: Response) => {
    try {
      const agent = await getSessionAgent(req, res, oauthClient);
      if (!agent) {
        return res.status(401).json({ error: 'Not authenticated' });
      }

      const communityDid = decodeURIComponent(req.params.did);
      const memberDid = decodeURIComponent(req.params.memberDid);

      const community = await db
        .selectFrom('communities')
        .selectAll()
        .where('did', '=', communityDid)
        .executeTakeFirst();

      if (!community) {
        return res.status(404).json({ error: 'Community not found' });
      }

      const communityAgent = await createCommunityAgent(db, communityDid);

      // Verify caller is an admin
      const adminsResponse = await communityAgent.api.com.atproto.repo.getRecord({
        repo: communityDid,
        collection: 'community.opensocial.admins',
        rkey: 'self',
      });

      const admins = (adminsResponse.data.value as any).admins || [];
      if (!isAdminInList(agent.assertDid, admins)) {
        return res.status(403).json({ error: 'Not authorized. Must be an admin.' });
      }

      // Protect the original group creator
      const originalAdminDid = getOriginalAdminDid(admins);
      if (memberDid === originalAdminDid) {
        return res.status(403).json({
          error: 'Cannot demote the original group creator.',
        });
      }

      // Verify the target is actually an admin
      if (!isAdminInList(memberDid, admins)) {
        return res.status(404).json({ error: 'Member is not an admin.' });
      }

      // Remove from admin list
      const updatedAdmins = normalizeAdmins(admins).filter(
        (a) => a.did !== memberDid
      );

      await communityAgent.api.com.atproto.repo.putRecord({
        repo: communityDid,
        collection: 'community.opensocial.admins',
        rkey: 'self',
        record: {
          $type: 'community.opensocial.admins',
          admins: updatedAdmins,
        },
      });

      await auditLog.log({ communityDid, adminDid: agent.assertDid, action: 'admin.demoted', targetDid: memberDid });

      return res.json({ success: true, admins: updatedAdmins });
    } catch (err) {
      logger.error({ error: err, communityDid: req.params.did, memberDid: req.params.memberDid }, 'Failed to demote admin');
      return res.status(500).json({
        error: 'Failed to demote admin',
        details: err instanceof Error ? err.message : 'Unknown error',
      });
    }
  });

  // Remove a member from the group by deleting their membershipProof
  router.delete('/communities/:did/members/:memberDid', async (req: Request, res: Response) => {
    try {
      const agent = await getSessionAgent(req, res, oauthClient);
      if (!agent) {
        return res.status(401).json({ error: 'Not authenticated' });
      }

      const communityDid = decodeURIComponent(req.params.did);
      const memberDid = decodeURIComponent(req.params.memberDid);

      const community = await db
        .selectFrom('communities')
        .selectAll()
        .where('did', '=', communityDid)
        .executeTakeFirst();

      if (!community) {
        return res.status(404).json({ error: 'Community not found' });
      }

      const communityAgent = await createCommunityAgent(db, communityDid);

      // Verify caller is an admin
      const adminsResponse = await communityAgent.api.com.atproto.repo.getRecord({
        repo: communityDid,
        collection: 'community.opensocial.admins',
        rkey: 'self',
      });

      const admins = (adminsResponse.data.value as any).admins || [];
      if (!isAdminInList(agent.assertDid, admins)) {
        return res.status(403).json({ error: 'Not authorized. Must be an admin.' });
      }

      // Prevent removing the original group creator
      const originalAdminDid = getOriginalAdminDid(admins);
      if (memberDid === originalAdminDid) {
        return res.status(403).json({
          error: 'Cannot remove the original group creator.',
        });
      }

      // Find the membershipProof record for this member
      let cursor: string | undefined;
      let memberProof: any = null;
      do {
        const response = await communityAgent.api.com.atproto.repo.listRecords({
          repo: communityDid,
          collection: 'community.opensocial.membershipProof',
          limit: 100,
          cursor,
        });
        memberProof = response.data.records.find(
          (r: any) => r.value.memberDid === memberDid
        );
        cursor = response.data.cursor;
      } while (cursor && !memberProof);

      if (!memberProof) {
        return res.status(404).json({ error: 'Member not found in this community.' });
      }

      // Delete the membershipProof record
      const rkey = memberProof.uri.split('/').pop()!;
      await communityAgent.api.com.atproto.repo.deleteRecord({
        repo: communityDid,
        collection: 'community.opensocial.membershipProof',
        rkey,
      });

      // If the removed member was also an admin, remove them from the admin list
      if (isAdminInList(memberDid, admins)) {
        const updatedAdmins = normalizeAdmins(admins).filter(
          (a) => a.did !== memberDid
        );
        await communityAgent.api.com.atproto.repo.putRecord({
          repo: communityDid,
          collection: 'community.opensocial.admins',
          rkey: 'self',
          record: {
            $type: 'community.opensocial.admins',
            admins: updatedAdmins,
          },
        });
      }

      await auditLog.log({ communityDid, adminDid: agent.assertDid, action: 'member.removed', targetDid: memberDid });

      return res.json({
        success: true,
        message: `Member ${memberDid} removed from community. Their membership record remains in their PDS but is no longer verified.`,
      });
    } catch (err) {
      logger.error({ error: err, communityDid: req.params.did, memberDid: req.params.memberDid }, 'Failed to remove member');
      return res.status(500).json({
        error: 'Failed to remove member',
        details: err instanceof Error ? err.message : 'Unknown error',
      });
    }
  });

  // Transfer primary admin to another admin
  router.post('/communities/:did/transfer-admin', async (req: Request, res: Response) => {
    try {
      const agent = await getSessionAgent(req, res, oauthClient);
      if (!agent) return res.status(401).json({ error: 'Not authenticated' });

      const communityDid = decodeURIComponent(req.params.did);
      const { newOwnerDid } = req.body;
      if (!newOwnerDid) return res.status(400).json({ error: 'newOwnerDid is required' });

      const communityAgent = await createCommunityAgent(db, communityDid);

      const adminsResponse = await communityAgent.api.com.atproto.repo.getRecord({
        repo: communityDid,
        collection: 'community.opensocial.admins',
        rkey: 'self',
      });
      const admins = (adminsResponse.data.value as any).admins || [];

      // Verify caller is the primary admin
      const originalAdmin = getOriginalAdminDid(admins);
      if (agent.assertDid !== originalAdmin) {
        return res.status(403).json({ error: 'Only the primary admin can transfer ownership' });
      }

      // Verify new owner is already an admin
      if (!isAdminInList(newOwnerDid, admins)) {
        return res.status(400).json({ error: 'New owner must already be an admin. Promote them first.' });
      }

      // Reorder: new owner goes first (becomes primary)
      const normalized = normalizeAdmins(admins);
      const newOwnerEntry = normalized.find(a => a.did === newOwnerDid)!;
      const rest = normalized.filter(a => a.did !== newOwnerDid);
      const updatedAdmins = [newOwnerEntry, ...rest];

      await communityAgent.api.com.atproto.repo.putRecord({
        repo: communityDid,
        collection: 'community.opensocial.admins',
        rkey: 'self',
        record: {
          $type: 'community.opensocial.admins',
          admins: updatedAdmins,
        },
      });

      await auditLog.log({ communityDid, adminDid: agent.assertDid, action: 'admin.transferred', targetDid: newOwnerDid });

      return res.json({ success: true, message: `Primary admin transferred to ${newOwnerDid}`, admins: updatedAdmins });
    } catch (err) {
      logger.error({ error: err, communityDid: req.params.did, newOwnerDid: req.body.newOwnerDid }, 'Failed to transfer admin');
      return res.status(500).json({ error: 'Failed to transfer admin role' });
    }
  });

  // ═══════════════════════════════════════════════════════════════════
  // SESSION-AUTHENTICATED PERMISSION / SETTINGS / ROLES ROUTES
  // ═══════════════════════════════════════════════════════════════════

  const auditLog = createAuditLogService(db);

  /** Helper: verify the session user is a community admin. Returns DID or null. */
  async function requireSessionAdmin(
    req: Request,
    res: Response,
    communityDid: string,
  ): Promise<string | null> {
    const agent = await getSessionAgent(req, res, oauthClient);
    if (!agent) {
      res.status(401).json({ error: 'Not authenticated' });
      return null;
    }
    const isAdm = await checkAdmin(
      await createCommunityAgent(db, communityDid),
      communityDid,
      agent.assertDid,
    );
    if (!isAdm) {
      res.status(403).json({ error: 'Not authorized. Must be an admin.' });
      return null;
    }
    return agent.assertDid;
  }

  // ─── Community settings ────────────────────────────────────────────

  router.get('/communities/:did/settings', async (req: Request, res: Response) => {
    try {
      const agent = await getSessionAgent(req, res, oauthClient);
      if (!agent) return res.status(401).json({ error: 'Not authenticated' });

      const communityDid = decodeURIComponent(req.params.did);
      const settings = await db
        .selectFrom('community_settings')
        .selectAll()
        .where('community_did', '=', communityDid)
        .executeTakeFirst();

      // Also fetch community type from ATProto profile
      let communityType = 'open';
      try {
        const communityAgent = await createCommunityAgent(db, communityDid);
        const profileRes = await communityAgent.api.com.atproto.repo.getRecord({
          repo: communityDid,
          collection: 'community.opensocial.profile',
          rkey: 'self',
        });
        communityType = (profileRes.data.value as any).type || 'open';
      } catch { /* profile may not exist yet */ }

      if (!settings) {
        return res.json({
          settings: { communityDid, appVisibilityDefault: 'open', blockedAppIds: [], communityType },
        });
      }

      res.json({
        settings: {
          communityDid: settings.community_did,
          appVisibilityDefault: settings.app_visibility_default,
          blockedAppIds: JSON.parse(settings.blocked_app_ids),
          communityType,
        },
      });
    } catch (error) {
      logger.error({ error, communityDid: req.params.did }, 'Error getting community settings');
      res.status(500).json({ error: 'Failed to get community settings' });
    }
  });

  router.put('/communities/:did/settings', async (req: Request, res: Response) => {
    try {
      const communityDid = decodeURIComponent(req.params.did);
      const adminDid = await requireSessionAdmin(req, res, communityDid);
      if (!adminDid) return;

      const { appVisibilityDefault, blockedAppIds, communityType } = req.body;

      // Update DB settings (app visibility, blocked apps)
      const existing = await db
        .selectFrom('community_settings')
        .selectAll()
        .where('community_did', '=', communityDid)
        .executeTakeFirst();

      if (existing) {
        const values: Record<string, any> = { updated_at: new Date() };
        if (appVisibilityDefault) values.app_visibility_default = appVisibilityDefault;
        if (blockedAppIds) values.blocked_app_ids = JSON.stringify(blockedAppIds);
        await db.updateTable('community_settings').set(values).where('community_did', '=', communityDid).execute();
      } else {
        await db
          .insertInto('community_settings')
          .values({
            community_did: communityDid,
            app_visibility_default: appVisibilityDefault || 'open',
            blocked_app_ids: blockedAppIds ? JSON.stringify(blockedAppIds) : '[]',
          })
          .execute();
      }

      // If communityType was provided, update the ATProto profile record
      if (communityType && ['open', 'admin-approved', 'private'].includes(communityType)) {
        try {
          const communityAgent = await createCommunityAgent(db, communityDid);
          const profileRes = await communityAgent.api.com.atproto.repo.getRecord({
            repo: communityDid,
            collection: 'community.opensocial.profile',
            rkey: 'self',
          });
          const currentProfile = profileRes.data.value as any;
          await communityAgent.api.com.atproto.repo.putRecord({
            repo: communityDid,
            collection: 'community.opensocial.profile',
            rkey: 'self',
            record: { ...currentProfile, $type: 'community.opensocial.profile', type: communityType },
          });
        } catch (err) {
          logger.error({ error: err, communityDid }, 'Failed to update community type in profile');
        }
      }

      await auditLog.log({ communityDid, adminDid, action: 'settings.updated', metadata: { appVisibilityDefault, blockedAppIds, communityType } });
      res.json({ success: true });
    } catch (error) {
      logger.error({ error, communityDid: req.params.did }, 'Error updating community settings');
      res.status(500).json({ error: 'Failed to update community settings' });
    }
  });

  // ─── App visibility ────────────────────────────────────────────────

  router.get('/communities/:did/apps', async (req: Request, res: Response) => {
    try {
      const agent = await getSessionAgent(req, res, oauthClient);
      if (!agent) return res.status(401).json({ error: 'Not authenticated' });

      const communityDid = decodeURIComponent(req.params.did);

      const rows = await db
        .selectFrom('community_app_visibility')
        .selectAll()
        .where('community_did', '=', communityDid)
        .orderBy('created_at', 'desc')
        .execute();

      const enriched = await Promise.all(
        rows.map(async (row) => {
          const app = await db.selectFrom('apps').select(['name', 'domain', 'did']).where('app_id', '=', row.app_id).executeTakeFirst();
          let avatarUrl: string | null = null;
          if (app?.did) {
            const { resolveBlueskyProfile } = await import('../services/atproto');
            const profile = await resolveBlueskyProfile(app.did);
            avatarUrl = profile.avatar;
          }
          return { appId: row.app_id, appName: app?.name || null, appDomain: app?.domain || null, did: app?.did || null, avatarUrl, status: row.status, reviewedBy: row.reviewed_by, createdAt: row.created_at, updatedAt: row.updated_at };
        }),
      );

      // Also list all active apps so admins can discover apps to enable
      const allAppsRaw = await db.selectFrom('apps').select(['app_id', 'name', 'domain', 'did']).where('status', '=', 'active').execute();
      const allApps = await Promise.all(
        allAppsRaw.map(async (a) => {
          let avatarUrl: string | null = null;
          if (a.did) {
            const { resolveBlueskyProfile } = await import('../services/atproto');
            const profile = await resolveBlueskyProfile(a.did);
            avatarUrl = profile.avatar;
          }
          return { ...a, avatarUrl };
        }),
      );

      res.json({ apps: enriched, allApps });
    } catch (error) {
      logger.error({ error, communityDid: req.params.did }, 'Error listing app visibility');
      res.status(500).json({ error: 'Failed to list app visibility' });
    }
  });

  router.put('/communities/:did/apps/:appId', async (req: Request, res: Response) => {
    try {
      const communityDid = decodeURIComponent(req.params.did);
      const appId = req.params.appId;
      const adminDid = await requireSessionAdmin(req, res, communityDid);
      if (!adminDid) return;

      const { status } = req.body;
      if (!['enabled', 'disabled', 'pending'].includes(status)) {
        return res.status(400).json({ error: 'status must be enabled, disabled, or pending' });
      }

      const existing = await db
        .selectFrom('community_app_visibility')
        .selectAll()
        .where('community_did', '=', communityDid)
        .where('app_id', '=', appId)
        .executeTakeFirst();

      if (existing) {
        await db.updateTable('community_app_visibility').set({ status, reviewed_by: adminDid, updated_at: new Date() }).where('id', '=', existing.id).execute();
      } else {
        await db.insertInto('community_app_visibility').values({ community_did: communityDid, app_id: appId, status, requested_by: adminDid, reviewed_by: adminDid }).execute();
      }

      if (status === 'enabled') await seedCollectionPermissions(db, communityDid, appId);

      const actionMap = { enabled: 'app.visibility.enabled', disabled: 'app.visibility.disabled', pending: 'app.visibility.pending' } as const;
      await auditLog.log({ communityDid, adminDid, action: actionMap[status as keyof typeof actionMap], metadata: { appId } });
      res.json({ success: true });
    } catch (error) {
      logger.error({ error, communityDid: req.params.did, appId: req.params.appId }, 'Error updating app visibility');
      res.status(500).json({ error: 'Failed to update app visibility' });
    }
  });

  // ─── Collection permissions ────────────────────────────────────────

  router.get('/communities/:did/apps/:appId/permissions', async (req: Request, res: Response) => {
    try {
      const agent = await getSessionAgent(req, res, oauthClient);
      if (!agent) return res.status(401).json({ error: 'Not authenticated' });

      const communityDid = decodeURIComponent(req.params.did);
      const appId = req.params.appId;

      const rows = await db
        .selectFrom('community_app_collection_permissions')
        .selectAll()
        .where('community_did', '=', communityDid)
        .where('app_id', '=', appId)
        .orderBy('collection', 'asc')
        .execute();

      res.json({
        permissions: rows.map((r) => ({
          collection: r.collection,
          canCreate: r.can_create,
          canRead: r.can_read,
          canUpdate: r.can_update,
          canDelete: r.can_delete,
        })),
      });
    } catch (error) {
      logger.error({ error, communityDid: req.params.did, appId: req.params.appId }, 'Error listing collection permissions');
      res.status(500).json({ error: 'Failed to list collection permissions' });
    }
  });

  router.put('/communities/:did/apps/:appId/permissions', async (req: Request, res: Response) => {
    try {
      const communityDid = decodeURIComponent(req.params.did);
      const appId = req.params.appId;
      const adminDid = await requireSessionAdmin(req, res, communityDid);
      if (!adminDid) return;

      const { collection, canCreate, canRead, canUpdate, canDelete } = req.body;
      if (!collection) return res.status(400).json({ error: 'collection is required' });

      const existing = await db
        .selectFrom('community_app_collection_permissions')
        .selectAll()
        .where('community_did', '=', communityDid)
        .where('app_id', '=', appId)
        .where('collection', '=', collection)
        .executeTakeFirst();

      if (existing) {
        const updates: Record<string, any> = { updated_at: new Date() };
        if (canCreate) updates.can_create = canCreate;
        if (canRead) updates.can_read = canRead;
        if (canUpdate) updates.can_update = canUpdate;
        if (canDelete) updates.can_delete = canDelete;
        await db.updateTable('community_app_collection_permissions').set(updates).where('id', '=', existing.id).execute();
      } else {
        await db.insertInto('community_app_collection_permissions').values({
          community_did: communityDid,
          app_id: appId,
          collection,
          can_create: canCreate || 'member',
          can_read: canRead || 'member',
          can_update: canUpdate || 'member',
          can_delete: canDelete || 'admin',
        }).execute();
      }

      await auditLog.log({ communityDid, adminDid, action: 'collection.permission.updated', metadata: { appId, collection } });
      res.json({ success: true });
    } catch (error) {
      logger.error({ error, communityDid: req.params.did, appId: req.params.appId }, 'Error setting collection permission');
      res.status(500).json({ error: 'Failed to set collection permission' });
    }
  });

  router.delete('/communities/:did/apps/:appId/permissions', async (req: Request, res: Response) => {
    try {
      const communityDid = decodeURIComponent(req.params.did);
      const appId = req.params.appId;
      const adminDid = await requireSessionAdmin(req, res, communityDid);
      if (!adminDid) return;

      const { collection } = req.body;
      if (!collection) return res.status(400).json({ error: 'collection is required' });

      await db
        .deleteFrom('community_app_collection_permissions')
        .where('community_did', '=', communityDid)
        .where('app_id', '=', appId)
        .where('collection', '=', collection)
        .execute();

      await auditLog.log({ communityDid, adminDid, action: 'collection.permission.deleted', metadata: { appId, collection } });
      res.json({ success: true });
    } catch (error) {
      logger.error({ error, communityDid: req.params.did, appId: req.params.appId }, 'Error deleting collection permission');
      res.status(500).json({ error: 'Failed to delete collection permission' });
    }
  });

  // ─── Custom roles ──────────────────────────────────────────────────

  router.get('/communities/:did/roles', async (req: Request, res: Response) => {
    try {
      const agent = await getSessionAgent(req, res, oauthClient);
      if (!agent) return res.status(401).json({ error: 'Not authenticated' });

      const communityDid = decodeURIComponent(req.params.did);
      const roles = await db
        .selectFrom('community_roles')
        .selectAll()
        .where('community_did', '=', communityDid)
        .orderBy('name', 'asc')
        .execute();

      res.json({
        roles: roles.map((r) => ({
          name: r.name,
          displayName: r.display_name,
          description: r.description,
          visible: r.visible,
          canViewAuditLog: r.can_view_audit_log,
          createdAt: r.created_at,
        })),
      });
    } catch (error) {
      logger.error({ error, communityDid: req.params.did }, 'Error listing roles');
      res.status(500).json({ error: 'Failed to list roles' });
    }
  });

  router.post('/communities/:did/roles', async (req: Request, res: Response) => {
    try {
      const communityDid = decodeURIComponent(req.params.did);
      const adminDid = await requireSessionAdmin(req, res, communityDid);
      if (!adminDid) return;

      const { name, displayName, description, visible, canViewAuditLog } = req.body;
      if (!name || !displayName) return res.status(400).json({ error: 'name and displayName are required' });
      if (name === 'admin' || name === 'member') return res.status(400).json({ error: `"${name}" is a built-in role` });

      const dup = await db.selectFrom('community_roles').select('id').where('community_did', '=', communityDid).where('name', '=', name).executeTakeFirst();
      if (dup) return res.status(409).json({ error: `Role "${name}" already exists` });

      await db.insertInto('community_roles').values({
        community_did: communityDid,
        name,
        display_name: displayName,
        description: description || null,
        visible: visible ?? false,
        can_view_audit_log: canViewAuditLog ?? false,
      }).execute();

      await auditLog.log({ communityDid, adminDid, action: 'role.created', metadata: { name, displayName, visible, canViewAuditLog } });
      res.status(201).json({ success: true, role: { name, displayName, description, visible, canViewAuditLog } });
    } catch (error) {
      logger.error({ error, communityDid: req.params.did }, 'Error creating role');
      res.status(500).json({ error: 'Failed to create role' });
    }
  });

  router.put('/communities/:did/roles/:roleName', async (req: Request, res: Response) => {
    try {
      const communityDid = decodeURIComponent(req.params.did);
      const roleName = req.params.roleName;
      const adminDid = await requireSessionAdmin(req, res, communityDid);
      if (!adminDid) return;

      const { displayName, description, visible, canViewAuditLog } = req.body;
      const updates: Record<string, any> = { updated_at: new Date() };
      if (displayName !== undefined) updates.display_name = displayName;
      if (description !== undefined) updates.description = description;
      if (visible !== undefined) updates.visible = visible;
      if (canViewAuditLog !== undefined) updates.can_view_audit_log = canViewAuditLog;

      const result = await db.updateTable('community_roles').set(updates).where('community_did', '=', communityDid).where('name', '=', roleName).executeTakeFirst();
      if (!result.numUpdatedRows || result.numUpdatedRows === 0n) return res.status(404).json({ error: 'Role not found' });

      await auditLog.log({ communityDid, adminDid, action: 'role.updated', metadata: { roleName, displayName, description, visible } });
      res.json({ success: true });
    } catch (error) {
      logger.error({ error, communityDid: req.params.did, roleName: req.params.roleName }, 'Error updating role');
      res.status(500).json({ error: 'Failed to update role' });
    }
  });

  router.delete('/communities/:did/roles/:roleName', async (req: Request, res: Response) => {
    try {
      const communityDid = decodeURIComponent(req.params.did);
      const roleName = req.params.roleName;
      const adminDid = await requireSessionAdmin(req, res, communityDid);
      if (!adminDid) return;

      await db.deleteFrom('community_member_roles').where('community_did', '=', communityDid).where('role_name', '=', roleName).execute();
      const result = await db.deleteFrom('community_roles').where('community_did', '=', communityDid).where('name', '=', roleName).executeTakeFirst();
      if (!result.numDeletedRows || result.numDeletedRows === 0n) return res.status(404).json({ error: 'Role not found' });

      memberRolesCache.invalidatePrefix(`${communityDid}:`);
      await auditLog.log({ communityDid, adminDid, action: 'role.deleted', metadata: { roleName } });
      res.json({ success: true });
    } catch (error) {
      logger.error({ error, communityDid: req.params.did, roleName: req.params.roleName }, 'Error deleting role');
      res.status(500).json({ error: 'Failed to delete role' });
    }
  });

  // ─── Role assignments ──────────────────────────────────────────────

  router.get('/communities/:did/members/:memberDid/roles', async (req: Request, res: Response) => {
    try {
      const agent = await getSessionAgent(req, res, oauthClient);
      if (!agent) return res.status(401).json({ error: 'Not authenticated' });

      const communityDid = decodeURIComponent(req.params.did);
      const memberDid = decodeURIComponent(req.params.memberDid);

      const assignments = await db
        .selectFrom('community_member_roles')
        .select(['role_name', 'assigned_by', 'created_at'])
        .where('community_did', '=', communityDid)
        .where('member_did', '=', memberDid)
        .execute();

      res.json({
        roles: assignments.map((r) => ({
          roleName: r.role_name,
          assignedBy: r.assigned_by,
          assignedAt: r.created_at,
        })),
      });
    } catch (error) {
      logger.error({ error, communityDid: req.params.did, memberDid: req.params.memberDid }, 'Error listing member roles');
      res.status(500).json({ error: 'Failed to list member roles' });
    }
  });

  router.post('/communities/:did/members/:memberDid/roles', async (req: Request, res: Response) => {
    try {
      const communityDid = decodeURIComponent(req.params.did);
      const memberDid = decodeURIComponent(req.params.memberDid);
      const adminDid = await requireSessionAdmin(req, res, communityDid);
      if (!adminDid) return;

      const { roleName } = req.body;
      if (!roleName) return res.status(400).json({ error: 'roleName is required' });

      if (roleName !== 'admin' && roleName !== 'member') {
        const role = await db.selectFrom('community_roles').select('id').where('community_did', '=', communityDid).where('name', '=', roleName).executeTakeFirst();
        if (!role) return res.status(404).json({ error: `Role "${roleName}" does not exist` });
      }

      const dup = await db.selectFrom('community_member_roles').select('id').where('community_did', '=', communityDid).where('member_did', '=', memberDid).where('role_name', '=', roleName).executeTakeFirst();
      if (dup) return res.status(409).json({ error: `Member already has role "${roleName}"` });

      await db.insertInto('community_member_roles').values({ community_did: communityDid, member_did: memberDid, role_name: roleName, assigned_by: adminDid }).execute();
      memberRolesCache.invalidate(`${communityDid}:${memberDid}`);

      await auditLog.log({ communityDid, adminDid, action: 'role.assigned', targetDid: memberDid, metadata: { roleName } });
      res.status(201).json({ success: true });
    } catch (error) {
      logger.error({ error, communityDid: req.params.did, memberDid: req.params.memberDid }, 'Error assigning role');
      res.status(500).json({ error: 'Failed to assign role' });
    }
  });

  router.delete('/communities/:did/members/:memberDid/roles/:roleName', async (req: Request, res: Response) => {
    try {
      const communityDid = decodeURIComponent(req.params.did);
      const memberDid = decodeURIComponent(req.params.memberDid);
      const roleName = req.params.roleName;
      const adminDid = await requireSessionAdmin(req, res, communityDid);
      if (!adminDid) return;

      const result = await db.deleteFrom('community_member_roles').where('community_did', '=', communityDid).where('member_did', '=', memberDid).where('role_name', '=', roleName).executeTakeFirst();
      if (!result.numDeletedRows || result.numDeletedRows === 0n) return res.status(404).json({ error: 'Role assignment not found' });

      memberRolesCache.invalidate(`${communityDid}:${memberDid}`);
      await auditLog.log({ communityDid, adminDid, action: 'role.revoked', targetDid: memberDid, metadata: { roleName } });
      res.json({ success: true });
    } catch (error) {
      logger.error({ error, communityDid: req.params.did, memberDid: req.params.memberDid, roleName: req.params.roleName }, 'Error revoking role');
      res.status(500).json({ error: 'Failed to revoke role' });
    }
  });

  // ─── Audit log viewing ─────────────────────────────────────────────

  /**
   * Check whether a user can view the audit log.
   * Admins always can. Custom roles with can_view_audit_log=true can.
   * Members (built-in) cannot by default.
   */
  async function canViewAuditLog(communityDid: string, userDid: string): Promise<boolean> {
    // Check if admin
    try {
      const communityAgent = await createCommunityAgent(db, communityDid);
      const isAdm = await checkAdmin(communityAgent, communityDid, userDid);
      if (isAdm) return true;
    } catch { /* not admin */ }

    // Check custom roles assigned to user that have can_view_audit_log
    const roleAssignments = await db
      .selectFrom('community_member_roles')
      .select('role_name')
      .where('community_did', '=', communityDid)
      .where('member_did', '=', userDid)
      .execute();

    if (roleAssignments.length === 0) return false;

    const roleNames = roleAssignments.map((r) => r.role_name);
    const matchingRoles = await db
      .selectFrom('community_roles')
      .select('name')
      .where('community_did', '=', communityDid)
      .where('name', 'in', roleNames)
      .where('can_view_audit_log', '=', true)
      .execute();

    return matchingRoles.length > 0;
  }

  router.get('/communities/:did/audit-log', async (req: Request, res: Response) => {
    try {
      const agent = await getSessionAgent(req, res, oauthClient);
      if (!agent) return res.status(401).json({ error: 'Not authenticated' });

      const communityDid = decodeURIComponent(req.params.did);
      const userDid = agent.assertDid;

      const hasAccess = await canViewAuditLog(communityDid, userDid);
      if (!hasAccess) {
        return res.status(403).json({ error: 'Not authorized to view audit log' });
      }

      const cursor = req.query.cursor as string | undefined;
      const limit = Math.min(Math.max(parseInt(req.query.limit as string) || 20, 1), 100);

      const result = await auditLog.query({ communityDid, cursor, limit });
      res.json(result);
    } catch (error) {
      logger.error({ error, communityDid: req.params.did }, 'Error fetching audit log');
      res.status(500).json({ error: 'Failed to fetch audit log' });
    }
  });

  // Return whether the current user can view the audit log (for UI gating)
  router.get('/communities/:did/audit-log/access', async (req: Request, res: Response) => {
    try {
      const agent = await getSessionAgent(req, res, oauthClient);
      if (!agent) return res.status(401).json({ error: 'Not authenticated' });

      const communityDid = decodeURIComponent(req.params.did);
      const hasAccess = await canViewAuditLog(communityDid, agent.assertDid);
      res.json({ canViewAuditLog: hasAccess });
    } catch (error) {
      logger.error({ error, communityDid: req.params.did }, 'Error checking audit log access');
      res.status(500).json({ error: 'Failed to check audit log access' });
    }
  });

  return router;
}
