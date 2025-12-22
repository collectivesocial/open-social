import { Agent, BskyAgent } from '@atproto/api';
import { OAuthResolverError } from '@atproto/oauth-client-node';
import express, { Request, Response } from 'express';
import { getIronSession } from 'iron-session';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { NodeOAuthClient } from '@atproto/oauth-client-node';
import crypto from 'crypto';
import multer from 'multer';
import { config } from '../config';
import type { Kysely } from 'kysely';
import type { Database } from '../db';

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

function ifString(val: unknown): string | undefined {
  return typeof val === 'string' && val.length > 0 ? val : undefined;
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
    console.log('No DID in session');
    return null;
  }

  res.setHeader('cache-control', `max-age=${MAX_AGE}, private`);

  try {
    const oauthSession = await oauthClient.restore(session.did);
    return oauthSession ? new Agent(oauthSession) : null;
  } catch (err) {
    console.warn('OAuth restore failed:', err);
    await session.destroy();
    return null;
  }
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
          console.warn('OAuth restore failed:', err);
        }
      }

      // Complete the OAuth flow
      const oauth = await oauthClient.callback(params);

      // Update the session cookie
      session.did = oauth.session.did;

      await session.save();
    } catch (err) {
      console.error('OAuth callback failed:', err);
    }

    // Redirect back to the frontend
    const redirectUrl = config.nodeEnv === 'production'
      ? config.serviceUrl || 'http://127.0.0.1:5174'
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
        scope: 'atproto transition:generic',
      });

      res.redirect(url.toString());
    } catch (err) {
      console.error('OAuth authorize failed:', err);
      const error = err instanceof Error ? err.message : 'unexpected error';
      return res.type('json').send({ error });
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
        console.warn('Failed to revoke credentials:', err);
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

      const profile = await agent.getProfile({ actor: agent.assertDid });
      
      return res.json({
        did: agent.assertDid,
        handle: profile.data.handle,
        displayName: profile.data.displayName,
        avatar: profile.data.avatar,
        description: profile.data.description,
      });
    } catch (err) {
      console.error('Failed to get user:', err);
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
              console.warn(`Community ${communityDid} not found in database`);
              return null;
            }

            // Create agent for the community
            const communityAgent = new BskyAgent({ service: community.pds_host });
            await communityAgent.login({
              identifier: community.handle,
              password: community.app_password,
            });

            // Fetch community profile using the community's own agent
            try {
              const profileResponse = await communityAgent.api.com.atproto.repo.getRecord({
                repo: communityDid,
                collection: 'community.opensocial.profile',
                rkey: 'self',
              });

              const profileValue = profileResponse.data.value as CommunityProfile;

              const avatarUrl = blobToUrl(profileValue.avatar, communityDid, community.pds_host);

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
              console.warn(`Failed to fetch profile for community ${communityDid}:`, profileErr instanceof Error ? profileErr.message : profileErr);
              return null;
            }
          } catch (err) {
            console.error(`Failed to process membership record:`, err);
            return null;
          }
        })
      );

      // Filter out null entries (failed fetches)
      const validMemberships = memberships.filter((m): m is NonNullable<typeof m> => m !== null);

      return res.json({ memberships: validMemberships });
    } catch (err) {
      console.error('Failed to get memberships:', err);
      return res.status(500).json({ error: 'Failed to get memberships' });
    }
  });

  // Create a new community
  router.post('/users/me/communities', async (req: Request, res: Response) => {
    try {
      const agent = await getSessionAgent(req, res, oauthClient);
      
      if (!agent) {
        return res.status(401).json({ error: 'Not authenticated' });
      }

      const { type, name, displayName, description, did: existingDid, appPassword } = req.body;

      if (!displayName) {
        return res.status(400).json({ error: 'displayName is required' });
      }

      let communityDid: string;
      let communityHandle: string;
      let communityAgent: Agent;

      if (type === 'new') {
        // Create new community on opensocial.community PDS
        if (!name) {
          return res.status(400).json({ error: 'name is required for new communities' });
        }

        const handle = `${name}.opensocial.community`;
        const pdsHost = config.pdsUrl || 'https://opensocial.community';
        const accountPassword = crypto.randomBytes(32).toString('hex');

        // Create account on PDS
        const createResponse = await fetch(`${pdsHost}/xrpc/com.atproto.server.createAccount`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            email: `${name}@opensocial.community`,
            handle: handle,
            password: accountPassword,
          }),
        });

        if (!createResponse.ok) {
          const error = await createResponse.json() as { message?: string };
          console.error('PDS account creation failed:', error);
          return res.status(500).json({ 
            error: 'Failed to create PDS account',
            details: error.message || 'Unknown error'
          });
        }

        const accountData = await createResponse.json() as { did: string; handle: string };
        communityDid = accountData.did;
        communityHandle = handle;

        // Wait for account to be ready
        await new Promise(resolve => setTimeout(resolve, 1000));

        // Login as the community
        const bskyAgent = new BskyAgent({ service: pdsHost });
        await bskyAgent.login({
          identifier: handle,
          password: accountPassword,
        });
        communityAgent = bskyAgent;

        // Store password in database (encrypted in production!)
        await db
          .insertInto('communities')
          .values({
            did: communityDid,
            handle: communityHandle,
            pds_host: pdsHost,
            app_password: accountPassword,
            created_at: new Date(),
          })
          .execute();

      } else if (type === 'existing') {
        // Use existing DID with app password
        if (!existingDid || !appPassword) {
          return res.status(400).json({ error: 'did and appPassword are required for existing communities' });
        }

        communityDid = existingDid;

        // Resolve DID to get handle and PDS
        const didDoc = await agent.api.com.atproto.identity.resolveHandle({
          handle: existingDid,
        }).catch(() => null);
        
        communityHandle = didDoc?.data.did || existingDid;
        
        // Try to get profile to find PDS
        let pdsHost = 'https://bsky.social'; // Default to Bluesky PDS
        try {
          const profile = await agent.getProfile({ actor: existingDid });
          // Extract PDS from profile if available
          pdsHost = profile.data.did ? 'https://bsky.social' : 'https://bsky.social';
        } catch (e) {
          console.warn('Could not resolve PDS, using default');
        }

        // Login with app password
        const bskyAgent = new BskyAgent({ service: pdsHost });
        await bskyAgent.login({
          identifier: existingDid,
          password: appPassword,
        });
        communityAgent = bskyAgent;

        // Store in database
        await db
          .insertInto('communities')
          .values({
            did: communityDid,
            handle: communityHandle,
            pds_host: pdsHost,
            app_password: appPassword,
            created_at: new Date(),
          })
          .execute();

      } else {
        return res.status(400).json({ error: 'Invalid type. Must be "new" or "existing"' });
      }

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
            createdAt: new Date().toISOString(),
          },
        });
      } catch (err) {
        console.error('Failed to create profile record:', err);
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
        console.error('Failed to create admins list:', err);
        return res.status(500).json({ 
          error: 'Failed to create admins list',
          details: err instanceof Error ? err.message : 'Unknown error'
        });
      }

      // Create membership record in user's repo
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
        },
      });
    } catch (err) {
      console.error('Failed to create community:', err);
      return res.status(500).json({ 
        error: 'Failed to create community',
        details: err instanceof Error ? err.message : 'Unknown error'
      });
    }
  });

  // Get community details
  router.get('/communities/:did', async (req: Request, res: Response) => {
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
      const communityAgent = new BskyAgent({ service: community.pds_host });
      await communityAgent.login({
        identifier: community.handle,
        password: community.app_password,
      });

      // Fetch community profile
      const profileResponse = await communityAgent.api.com.atproto.repo.getRecord({
        repo: communityDid,
        collection: 'community.opensocial.profile',
        rkey: 'self',
      });

      const profileValue = profileResponse.data.value as CommunityProfile;

      const avatarUrl = blobToUrl(profileValue.avatar, communityDid, community.pds_host);

      // Count members (membership proofs)
      const proofsResponse = await communityAgent.api.com.atproto.repo.listRecords({
        repo: communityDid,
        collection: 'community.opensocial.membershipProof',
      });

      const memberCount = proofsResponse.data.records.length;

      // Check if user is admin
      const adminsResponse = await communityAgent.api.com.atproto.repo.getRecord({
        repo: communityDid,
        collection: 'community.opensocial.admins',
        rkey: 'self',
      });

      const adminsValue = adminsResponse.data.value as { admins: string[] };
      const isAdmin = adminsValue.admins.includes(agent.assertDid);

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

      return res.json({
        community: {
          did: communityDid,
          displayName: profileValue.displayName,
          description: profileValue.description,
          avatar: avatarUrl,
        },
        memberCount,
        isAdmin,
        userRole,
      });
    } catch (err) {
      console.error('Failed to get community details:', err);
      return res.status(500).json({ 
        error: 'Failed to get community details',
        details: err instanceof Error ? err.message : 'Unknown error'
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
      const communityAgent = new BskyAgent({ service: community.pds_host });
      await communityAgent.login({
        identifier: community.handle,
        password: community.app_password,
      });

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
      console.error('Failed to upload avatar:', err);
      return res.status(500).json({ 
        error: 'Failed to upload avatar',
        details: err instanceof Error ? err.message : 'Unknown error'
      });
    }
  });

  return router;
}
