import { BskyAgent, AtpAgent } from '@atproto/api';
import pool from './database';

export async function createCommunityAgent(communityId: string): Promise<BskyAgent> {
  const result = await pool.query(
    'SELECT handle, pds_host, account_password_hash FROM communities WHERE community_id = $1',
    [communityId]
  );

  if (result.rows.length === 0) {
    throw new Error('Community not found');
  }

  const { handle, pds_host, account_password_hash } = result.rows[0];
  
  const agent = new BskyAgent({ service: `https://${pds_host}` });
  
  await agent.login({
    identifier: handle,
    password: account_password_hash, // TODO: Decrypt in production
  });

  return agent;
}

export async function getPublicAgent(pdsHost: string): Promise<AtpAgent> {
  return new AtpAgent({ service: `https://${pdsHost}` });
}
