// Type definitions for OpenSocial API

export interface App {
  app_id: string;
  name: string;
  domain: string;
  creator_did: string;
  api_key: string;
  created_at: Date;
  status: string;
}

export interface Community {
  community_id: string;
  handle: string;
  did: string;
  app_id: string;
  pds_host: string;
  created_at: Date;
  updated_at: Date;
}

export interface CommunityProfile {
  displayName: string;
  description?: string;
  avatar?: any;
  banner?: any;
  createdAt: string;
  guidelines?: string;
}

export interface Admin {
  did: string;
  permissions: string[];
  addedAt: string;
}
