import { Request, Response, NextFunction } from 'express';
import pool from '../services/database';

export interface AuthenticatedRequest extends Request {
  app_data?: any;
}

export async function verifyApiKey(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
) {
  const apiKey = req.headers['x-api-key'] as string;

  if (!apiKey) {
    return res.status(401).json({ error: 'API key required' });
  }

  try {
    const result = await pool.query(
      'SELECT * FROM apps WHERE api_key = $1 AND status = $2',
      [apiKey, 'active']
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid API key' });
    }

    req.app_data = result.rows[0];
    next();
  } catch (error) {
    console.error('Auth error:', error);
    res.status(500).json({ error: 'Authentication failed' });
  }
}
