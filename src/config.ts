import dotenv from "dotenv";

dotenv.config();

export const config = {
  logLevel: process.env.LOG_LEVEL || "info",
  port: process.env.PORT || 3001,
  nodeEnv: process.env.NODE_ENV || "development",
  databaseUrl: process.env.DATABASE_URL || "",
  serviceUrl: process.env.SERVICE_URL || undefined, // undefined for local dev (loopback mode)
  plcUrl: process.env.PLC_URL || "https://plc.directory",
  privateKeys: process.env.PRIVATE_KEYS
    ? JSON.parse(process.env.PRIVATE_KEYS)
    : [],
  pdsUrl: process.env.PDS_URL || "https://bsky.social",
  cookieSecret: process.env.COOKIE_SECRET || "",
  encryptionKey: process.env.ENCRYPTION_KEY || "",
  corsOrigin: process.env.CORS_ORIGIN || undefined, // e.g. https://app.opensocial.community
  webhookAllowedHostnames: process.env.WEBHOOK_ALLOWED_HOSTNAMES
    ? process.env.WEBHOOK_ALLOWED_HOSTNAMES.split(",").map((h) => h.trim())
    : undefined, // undefined = no allowlist, allow all hostnames
  serviceDid: process.env.OPENSOCIAL_SERVICE_DID || undefined,
  serviceId: process.env.OPENSOCIAL_SERVICE_DID
    ? `${process.env.OPENSOCIAL_SERVICE_DID}#opensocial`
    : undefined,
  publicUrl:
    process.env.SERVICE_URL || `http://localhost:${process.env.PORT || 3001}`,
} as const;
