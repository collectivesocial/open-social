import { Router } from 'express';
import bcrypt from 'bcrypt';
import crypto from 'crypto';
import pool from '../services/database';
import { verifyApiKey } from '../middleware/auth';

const router = Router();

// Register a new app
router.post('/register', async (req, res) => {
  const { name, domain, creator_did } = req.body;

  if (!name || !domain || !creator_did) {
    return res.status(400).json({
      error: 'Missing required fields: name, domain, creator_did',
    });
  }

  try {
    const appId = `app_${crypto.randomBytes(8).toString('hex')}`;
    const apiKey = `osc_${crypto.randomBytes(32).toString('hex')}`;
    const apiSecret = crypto.randomBytes(32).toString('hex');
    const apiSecretHash = await bcrypt.hash(apiSecret, 10);

    const result = await pool.query(
      `INSERT INTO apps (app_id, name, domain, creator_did, api_key, api_secret_hash)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING app_id, name, domain, api_key, created_at`,
      [appId, name, domain, creator_did, apiKey, apiSecretHash]
    );

    res.json({
      app: result.rows[0],
      api_secret: apiSecret,
      message: 'Store the api_secret securely - it will not be shown again',
    });
  } catch (error: any) {
    console.error('Error registering app:', error);
    
    if (error.constraint) {
      return res.status(409).json({ error: 'App with this domain already exists' });
    }
    
    res.status(500).json({ error: 'Failed to register app' });
  }
});

// Get app details (authenticated)
router.get('/me', verifyApiKey, async (req: any, res) => {
  res.json({
    app_id: req.app_data.app_id,
    name: req.app_data.name,
    domain: req.app_data.domain,
    created_at: req.app_data.created_at,
  });
});

export default router;
