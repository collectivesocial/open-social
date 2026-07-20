import dotenv from 'dotenv';

dotenv.config();

export const config = {
  logLevel: process.env.LOG_LEVEL || 'info',
  port: process.env.PORT || 3001,
  nodeEnv: process.env.NODE_ENV || 'development',
  databaseUrl: process.env.DATABASE_URL || '',
  // pg Pool tuning. connectionTimeoutMillis > 0 so requests fail fast instead
  // of waiting forever when the pool is exhausted.
  pgPoolMax: Number(process.env.PG_POOL_MAX) || 10,
  pgIdleTimeoutMs: Number(process.env.PG_IDLE_TIMEOUT_MS) || 30_000,
  pgConnectionTimeoutMs: Number(process.env.PG_CONNECTION_TIMEOUT_MS) || 5_000,
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
} as const;
