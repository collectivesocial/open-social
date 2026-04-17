import dotenv from 'dotenv';

dotenv.config();

export const config = {
  logLevel: process.env.LOG_LEVEL || 'info',
  port: process.env.PORT || 3001,
  nodeEnv: process.env.NODE_ENV || 'development',
  databaseUrl: process.env.DATABASE_URL || '',
  serviceUrl: process.env.SERVICE_URL || undefined, // undefined for local dev (loopback mode)
  plcUrl: process.env.PLC_URL || 'https://plc.directory',
  privateKeys: process.env.PRIVATE_KEYS
    ? JSON.parse(process.env.PRIVATE_KEYS)
    : [],
  pdsUrl: process.env.PDS_URL || 'https://bsky.social',
  cookieSecret: process.env.COOKIE_SECRET || '',
  encryptionKey: process.env.ENCRYPTION_KEY || '',
  corsOrigin: process.env.CORS_ORIGIN || undefined, // e.g. https://app.opensocial.community
  webhookAllowedHostnames: process.env.WEBHOOK_ALLOWED_HOSTNAMES
    ? process.env.WEBHOOK_ALLOWED_HOSTNAMES.split(',').map(h => h.trim())
    : undefined, // undefined = no allowlist, allow all hostnames

  // ─── Cirrus PDS provisioning (Cloudflare Workers) ────────────────
  /** Cloudflare account ID — all community Workers are deployed under this account */
  cloudflareAccountId: process.env.CLOUDFLARE_ACCOUNT_ID || '',
  /** Cloudflare API token with Workers Scripts, R2, and DNS write permissions */
  cloudflareApiToken: process.env.CLOUDFLARE_API_TOKEN || '',
  /** Base domain for auto-provisioned community PDS subdomains (e.g. opensocial.community) */
  communityDomain: process.env.COMMUNITY_DOMAIN || 'opensocial.community',
  /** Path to the pre-built Cirrus worker ES module bundle */
  cirrusWorkerBundlePath: process.env.CIRRUS_WORKER_BUNDLE_PATH || '',
} as const;
