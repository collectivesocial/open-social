import { Agent } from '@atproto/api';
import { OAuthResolverError } from '@atproto/oauth-client-node';
import express, { Request, Response } from 'express';
import { getIronSession } from 'iron-session';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { NodeOAuthClient } from '@atproto/oauth-client-node';
import { config } from '../config';
import type { Kysely } from 'kysely';
import type { Database } from '../db';

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
  
  console.log('Session check - DID:', session.did);
  
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
    console.log('Callback params:', Array.from(params.entries()));
    
    try {
      // Load the session cookie
      const session = await getIronSession<Session>(req, res, sessionOptions);

      console.log('Existing session DID:', session.did);

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
      console.log('Completing OAuth callback...');
      const oauth = await oauthClient.callback(params);
      console.log('OAuth callback complete, DID:', oauth.session.did);

      // Update the session cookie
      session.did = oauth.session.did;
      console.log('Saving session with DID:', session.did);

      await session.save();
      console.log('Session saved successfully');
      console.log('Response headers:', res.getHeaders());
    } catch (err) {
      console.error('OAuth callback failed:', err);
    }

    // Redirect back to the frontend
    const redirectUrl = config.nodeEnv === 'production'
      ? config.serviceUrl || 'http://127.0.0.1:5174'
      : 'http://127.0.0.1:5174';
    console.log('Redirecting to:', redirectUrl);
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
      console.log('Request cookies:', req.headers.cookie);
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

  return router;
}
