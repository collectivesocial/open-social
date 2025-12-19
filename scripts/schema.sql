-- OpenSocial Database Schema

-- Apps table: Registered applications
CREATE TABLE IF NOT EXISTS apps (
  id SERIAL PRIMARY KEY,
  app_id VARCHAR(255) UNIQUE NOT NULL,
  name VARCHAR(255) NOT NULL,
  domain VARCHAR(255) NOT NULL,
  creator_did VARCHAR(255) NOT NULL,
  api_key VARCHAR(255) UNIQUE NOT NULL,
  api_secret_hash VARCHAR(255) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  status VARCHAR(50) DEFAULT 'active'
);

-- Communities table: Community profiles
CREATE TABLE IF NOT EXISTS communities (
  id SERIAL PRIMARY KEY,
  community_id VARCHAR(255) UNIQUE NOT NULL,
  handle VARCHAR(255) UNIQUE NOT NULL,
  did VARCHAR(255) UNIQUE NOT NULL,
  app_id VARCHAR(255) REFERENCES apps(app_id) ON DELETE CASCADE,
  pds_host VARCHAR(255) NOT NULL,
  account_password_hash VARCHAR(255) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- OAuth tokens for admin access (future use)
CREATE TABLE IF NOT EXISTS community_oauth_tokens (
  id SERIAL PRIMARY KEY,
  community_id VARCHAR(255) REFERENCES communities(community_id) ON DELETE CASCADE,
  admin_did VARCHAR(255) NOT NULL,
  access_token TEXT NOT NULL,
  refresh_token TEXT,
  expires_at TIMESTAMP,
  scope TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(community_id, admin_did)
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_apps_creator ON apps(creator_did);
CREATE INDEX IF NOT EXISTS idx_apps_api_key ON apps(api_key);
CREATE INDEX IF NOT EXISTS idx_communities_app ON communities(app_id);
CREATE INDEX IF NOT EXISTS idx_communities_did ON communities(did);
CREATE INDEX IF NOT EXISTS idx_oauth_admin ON community_oauth_tokens(admin_did);

-- Updated_at trigger function
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Apply updated_at triggers
CREATE TRIGGER update_apps_updated_at BEFORE UPDATE ON apps
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_communities_updated_at BEFORE UPDATE ON communities
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();