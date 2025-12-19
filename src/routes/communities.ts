import { Router } from 'express';
import crypto from 'crypto';
import { execSync } from 'child_process';
import { BskyAgent, AtpAgent } from '@atproto/api';
import pool from '../services/database';
import { verifyApiKey, AuthenticatedRequest } from '../middleware/auth';
import { createCommunityAgent, getPublicAgent } from '../services/atproto';

const router = Router();

// Create a new community
router.post('/', verifyApiKey, async (req: AuthenticatedRequest, res) => {
  const { handle, display_name, description, creator_did } = req.body;

  if (!handle || !display_name || !creator_did) {
    return res.status(400).json({
      error: 'Missing required fields: handle, display_name, creator_did',
    });
  }

  if (!handle.endsWith('.opensocial.community')) {
    return res.status(400).json({
      error: 'Handle must end with .opensocial.community',
    });
  }

  const communityId = `comm_${crypto.randomBytes(8).toString('hex')}`;
  const pdsHost = process.env.PDS_HOSTNAME || 'opensocial.community';
  const accountPassword = crypto.randomBytes(32).toString('hex');

  try {
    // Create account on PDS via API (no pdsadmin needed!)
    console.log(`Creating PDS account for ${handle}...`);
    
    const createResponse = await fetch(`https://${pdsHost}/xrpc/com.atproto.server.createAccount`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: `${handle.split('.')[0]}@opensocial.community`,
        handle: handle,
        password: accountPassword,
      }),
    });

    if (!createResponse.ok) {
      const error = await createResponse.json();
      console.error('PDS account creation failed:', error);
      return res.status(500).json({ 
        error: 'Failed to create PDS account',
        details: (error as any).message || 'Unknown error'
      });
    }

    const accountData = await createResponse.json() as { did: string; handle: string };
    const did = accountData.did;

    console.log(`Created community account with DID: ${did}`);

    // Wait a moment for account to be fully ready
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Login to get agent
    const agent = new BskyAgent({ service: `https://${pdsHost}` });
    await agent.login({
      identifier: handle,
      password: accountPassword,
    });

    // Create profile record
    await agent.com.atproto.repo.putRecord({
      repo: did,
      collection: 'community.opensocial.profile',
      rkey: 'self',
      record: {
        $type: 'community.opensocial.profile',
        displayName: display_name,
        description: description || '',
        createdAt: new Date().toISOString(),
      },
    });

    // Create admins record
    await agent.com.atproto.repo.putRecord({
      repo: did,
      collection: 'community.opensocial.admins',
      rkey: 'self',
      record: {
        $type: 'community.opensocial.admins',
        admins: [
          {
            did: creator_did,
            permissions: ['edit_profile', 'manage_admins', 'moderate', 'post'],
            addedAt: new Date().toISOString(),
          },
        ],
      },
    });

    // Store in database
    const result = await pool.query(
      `INSERT INTO communities (community_id, handle, did, app_id, pds_host, account_password_hash)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [communityId, handle, did, req.app_data!.app_id, pdsHost, accountPassword]
    );

    res.json({
      community: {
        community_id: communityId,
        handle: handle,
        did: did,
        display_name: display_name,
        pds_host: pdsHost,
        created_at: result.rows[0].created_at,
      },
      is_admin: true,
    });
  } catch (error: any) {
    console.error('Error creating community:', error);
    res.status(500).json({
      error: 'Failed to create community',
      details: error.message,
    });
  }
});

// List communities
router.get('/', verifyApiKey, async (req: AuthenticatedRequest, res) => {
  const { user_did } = req.query;

  try {
    const result = await pool.query(
      'SELECT community_id, handle, did, pds_host, created_at FROM communities WHERE app_id = $1 ORDER BY created_at DESC',
      [req.app_data!.app_id]
    );

    // Check admin status if user_did provided
    const communities = await Promise.all(
      result.rows.map(async (community) => {
        let is_admin = false;

        if (user_did) {
          try {
            const agent = await getPublicAgent(community.pds_host);
            const adminRecord = await agent.com.atproto.repo.getRecord({
              repo: community.did,
              collection: 'community.opensocial.admins',
              rkey: 'self',
            });

            const admins = (adminRecord.data.value as any).admins || [];
            is_admin = admins.some((admin: any) => admin.did === user_did);
          } catch (error) {
            console.error(`Error checking admin status for ${community.handle}`);
          }
        }

        return { ...community, is_admin };
      })
    );

    res.json({ communities });
  } catch (error) {
    console.error('Error fetching communities:', error);
    res.status(500).json({ error: 'Failed to fetch communities' });
  }
});

// Get single community with full profile
router.get('/:id', verifyApiKey, async (req: AuthenticatedRequest, res) => {
  const { id } = req.params;
  const { user_did } = req.query;

  try {
    const result = await pool.query(
      'SELECT * FROM communities WHERE community_id = $1 AND app_id = $2',
      [id, req.app_data!.app_id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Community not found' });
    }

    const community = result.rows[0];
    const agent = await getPublicAgent(community.pds_host);

    // Fetch profile
    const profileRecord = await agent.com.atproto.repo.getRecord({
      repo: community.did,
      collection: 'community.opensocial.profile',
      rkey: 'self',
    });

    // Fetch admins
    const adminRecord = await agent.com.atproto.repo.getRecord({
      repo: community.did,
      collection: 'community.opensocial.admins',
      rkey: 'self',
    });

    const profile = profileRecord.data.value as any;
    const admins = (adminRecord.data.value as any).admins || [];
    const is_admin = user_did
      ? admins.some((admin: any) => admin.did === user_did)
      : false;

    res.json({
      community: {
        community_id: community.community_id,
        handle: community.handle,
        did: community.did,
        pds_host: community.pds_host,
        display_name: profile.displayName,
        description: profile.description,
        guidelines: profile.guidelines,
        admins: admins,
        created_at: profile.createdAt,
      },
      is_admin,
    });
  } catch (error) {
    console.error('Error fetching community:', error);
    res.status(500).json({ error: 'Failed to fetch community' });
  }
});

export default router;
