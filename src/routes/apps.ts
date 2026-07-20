import { Agent } from "@atproto/api";
import express, { Request, Response } from "express";
import { getIronSession } from "iron-session";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { NodeOAuthClient } from "@atproto/oauth-client-node";
import crypto from "crypto";
import { config } from "../config";
import type { Kysely } from "kysely";
import type { Database } from "../db";
import { computeApiKeyLookup, hashApiKey } from "../lib/crypto";
import { authenticateApiKey } from "../middleware/auth";
import {
  getCimdDocument,
  jwkToKeyObject,
  invalidateCimdCache,
} from "../lib/cimd";
import { verifyRequestSignature } from "../lib/httpSig";
import {
  registerAppWithPermissionsSchema,
  updateAppSchema,
  appDefaultPermissionSchema,
  isCimdUrlDomainMatch,
} from "../validation/schemas";
import { logger } from "../lib/logger";

type Session = { did?: string };

const MAX_AGE = config.nodeEnv === "production" ? 60 : 300;

const sessionOptions = {
  cookieName: "sid",
  password: config.cookieSecret,
  cookieOptions: {
    secure: config.nodeEnv === "production",
    sameSite: "lax" as const,
    httpOnly: true,
    path: "/",
  },
};

async function getSessionAgent(
  req: IncomingMessage,
  res: ServerResponse,
  oauthClient: NodeOAuthClient,
) {
  res.setHeader("Vary", "Cookie");
  const session = await getIronSession<Session>(req, res, sessionOptions);
  if (!session.did) return null;
  res.setHeader("cache-control", `max-age=${MAX_AGE}, private`);
  try {
    const oauthSession = await oauthClient.restore(session.did);
    return oauthSession ? new Agent(oauthSession) : null;
  } catch (err) {
    logger.warn({ error: err, did: session.did }, "OAuth restore failed");
    await session.destroy();
    return null;
  }
}

export function createAppRouter(
  oauthClient: NodeOAuthClient,
  db: Kysely<Database>,
) {
  const router = express.Router();

  // Register a new app (requires OAuth session — user must be logged in)
  router.post("/register", async (req: Request, res: Response) => {
    let stage = "init";
    try {
      stage = "auth";
      const agent = await getSessionAgent(req, res, oauthClient);
      if (!agent) {
        return res
          .status(401)
          .json({ error: "Not authenticated. Log in to register an app." });
      }

      stage = "validate";
      const parsed = registerAppWithPermissionsSchema.safeParse(req.body);
      if (!parsed.success) {
        logger.warn(
          { did: agent.assertDid, issues: parsed.error.flatten() },
          "App registration rejected: invalid input",
        );
        return res
          .status(400)
          .json({ error: "Invalid input", details: parsed.error.flatten() });
      }
      const { name, domain, defaultPermissions, authMethod, cimdUrl } =
        parsed.data;

      const effectiveAuthMethod = authMethod || "api_key";
      if (
        (effectiveAuthMethod === "http_signature" ||
          effectiveAuthMethod === "both") &&
        !cimdUrl
      ) {
        return res.status(400).json({
          error: "cimdUrl is required when using http_signature auth",
        });
      }

      // Validate CIMD document is reachable when using HTTP signature auth
      if (
        cimdUrl &&
        (effectiveAuthMethod === "http_signature" ||
          effectiveAuthMethod === "both")
      ) {
        try {
          // Try GET with bounded response (HEAD may not be supported on all hosts)
          const probe = await fetch(cimdUrl, {
            method: "GET",
            signal: AbortSignal.timeout(5000),
            headers: { Accept: "application/json" },
          });
          if (!probe.ok) {
            return res.status(400).json({
              error: `CIMD document not reachable at ${cimdUrl} (HTTP ${probe.status}). Publish your document before registering.`,
            });
          }
          // Consume body to free resources
          await probe.text();
        } catch (err) {
          return res.status(400).json({
            error: `Could not reach CIMD document at ${cimdUrl}. Ensure the URL is publicly accessible.`,
          });
        }
      }

      // Check for duplicate domain
      stage = "duplicate_check";
      const existing = await db
        .selectFrom("apps")
        .selectAll()
        .where("domain", "=", domain)
        .where("status", "=", "active")
        .executeTakeFirst();
      if (existing) {
        return res
          .status(409)
          .json({ error: "An active app with this domain already exists" });
      }

      const creatorDid = agent.assertDid;
      const appId = `app_${crypto.randomBytes(8).toString("hex")}`;
      // Only generate API key if auth method includes api_key
      const needsApiKey = effectiveAuthMethod !== "http_signature";
      const apiKey = needsApiKey
        ? `osc_${crypto.randomBytes(32).toString("hex")}`
        : null;
      // For http_signature-only apps, store a unique random hash to satisfy NOT NULL + UNIQUE
      stage = "hash_key";
      const apiKeyHash = needsApiKey
        ? hashApiKey(apiKey!)
        : `nosecret_${crypto.randomBytes(32).toString("hex")}`;

      stage = "insert_app";
      await db
        .insertInto("apps")
        .values({
          app_id: appId,
          name,
          domain,
          creator_did: creatorDid,
          api_key: apiKeyHash,
          api_key_lookup: needsApiKey ? computeApiKeyLookup(apiKey!) : null,
          auth_method: effectiveAuthMethod,
          cimd_url: cimdUrl || null,
          created_at: new Date(),
          updated_at: new Date(),
          status: "active",
        })
        .execute();

      // Store default collection permissions if provided
      if (defaultPermissions && defaultPermissions.length > 0) {
        stage = "insert_permissions";
        for (const perm of defaultPermissions) {
          await db
            .insertInto("app_default_permissions")
            .values({
              app_id: appId,
              collection: perm.collection,
              default_can_create: perm.defaultCanCreate,
              default_can_read: perm.defaultCanRead,
              default_can_update: perm.defaultCanUpdate,
              default_can_delete: perm.defaultCanDelete,
            })
            .execute();
        }
      }

      const response: Record<string, any> = {
        app: {
          app_id: appId,
          name,
          domain,
          auth_method: effectiveAuthMethod,
          ...(cimdUrl && { cimd_url: cimdUrl }),
          ...(apiKey && { api_key: apiKey }),
          created_at: new Date().toISOString(),
        },
      };
      if (apiKey) {
        response.message =
          "Store the api_key securely — treat it like a password.";
      } else {
        response.message =
          "App registered with HTTP signature auth. Publish your CIMD document at your domain.";
      }

      return res.json(response);
    } catch (err) {
      const pgError = err as {
        code?: string;
        column?: string;
        constraint?: string;
        detail?: string;
        message?: string;
      };
      logger.error(
        {
          stage,
          error: err,
          errorMessage: pgError?.message,
          errorCode: pgError?.code,
          errorColumn: pgError?.column,
          errorConstraint: pgError?.constraint,
          errorDetail: pgError?.detail,
          body: {
            name: req.body?.name,
            domain: req.body?.domain,
            authMethod: req.body?.authMethod,
            hasCimdUrl: Boolean(req.body?.cimdUrl),
            permissionCount: Array.isArray(req.body?.defaultPermissions)
              ? req.body.defaultPermissions.length
              : 0,
          },
        },
        "Error registering app",
      );

      // Known Postgres error codes — return clearer 4xx where appropriate
      if (pgError?.code === "23505") {
        // unique_violation
        return res.status(409).json({
          error: "Duplicate value violates a unique constraint",
          detail: pgError.detail || pgError.constraint || undefined,
        });
      }
      if (pgError?.code === "42703" || pgError?.code === "42P01") {
        // undefined_column / undefined_table — schema is missing
        return res.status(500).json({
          error:
            "Database schema is out of date. Run `npm run migrate:up` and restart the server.",
          detail: pgError.message,
        });
      }

      const exposeDetail = config.nodeEnv !== "production";
      return res.status(500).json({
        error: "Failed to register app",
        ...(exposeDetail && pgError?.message
          ? { detail: pgError.message, stage }
          : {}),
      });
    }
  });

  // List the current user's registered apps
  router.get("/", async (req: Request, res: Response) => {
    try {
      const agent = await getSessionAgent(req, res, oauthClient);
      if (!agent) {
        return res.status(401).json({ error: "Not authenticated" });
      }

      const apps = await db
        .selectFrom("apps")
        .select([
          "app_id",
          "name",
          "domain",
          "auth_method",
          "cimd_url",
          "status",
          "created_at",
          "updated_at",
        ])
        .where("creator_did", "=", agent.assertDid)
        .orderBy("created_at", "desc")
        .execute();

      return res.json({ apps });
    } catch (err) {
      logger.error({ error: err }, "Error listing apps");
      return res.status(500).json({ error: "Failed to list apps" });
    }
  });

  // Get a single app by ID (must be the creator)
  router.get("/:appId", async (req: Request, res: Response) => {
    try {
      const agent = await getSessionAgent(req, res, oauthClient);
      if (!agent) {
        return res.status(401).json({ error: "Not authenticated" });
      }

      const app = await db
        .selectFrom("apps")
        .select([
          "app_id",
          "name",
          "domain",
          "auth_method",
          "cimd_url",
          "status",
          "created_at",
          "updated_at",
        ])
        .where("app_id", "=", req.params.appId)
        .where("creator_did", "=", agent.assertDid)
        .executeTakeFirst();

      if (!app) {
        return res.status(404).json({ error: "App not found" });
      }

      return res.json({ app });
    } catch (err) {
      logger.error(
        { error: err, appId: req.params.appId },
        "Error getting app",
      );
      return res.status(500).json({ error: "Failed to get app" });
    }
  });

  // Update an app (name, domain, cimdUrl, and/or authMethod)
  router.put("/:appId", async (req: Request, res: Response) => {
    try {
      const agent = await getSessionAgent(req, res, oauthClient);
      if (!agent) {
        return res.status(401).json({ error: "Not authenticated" });
      }

      const parsed = updateAppSchema.safeParse(req.body);
      if (!parsed.success) {
        return res
          .status(400)
          .json({ error: "Invalid input", details: parsed.error.flatten() });
      }
      const { name, domain, cimdUrl, authMethod } = parsed.data;

      const existing = await db
        .selectFrom("apps")
        .selectAll()
        .where("app_id", "=", req.params.appId)
        .where("creator_did", "=", agent.assertDid)
        .executeTakeFirst();
      if (!existing) {
        return res.status(404).json({ error: "App not found" });
      }

      if (domain && domain !== existing.domain) {
        const conflict = await db
          .selectFrom("apps")
          .selectAll()
          .where("domain", "=", domain)
          .where("status", "=", "active")
          .where("app_id", "!=", req.params.appId)
          .executeTakeFirst();
        if (conflict) {
          return res
            .status(409)
            .json({ error: "An active app with this domain already exists" });
        }
      }

      // CIMD validation: hostname must match the effective domain (new or existing)
      if (cimdUrl !== undefined) {
        const effectiveDomain = domain ?? existing.domain;
        if (!isCimdUrlDomainMatch(cimdUrl, effectiveDomain)) {
          return res
            .status(400)
            .json({ error: "cimdUrl hostname must match the app domain" });
        }
      }

      // authMethod validation: if switching to http_signature/both, a cimdUrl must exist
      const effectiveAuthMethod = authMethod ?? existing.auth_method;
      const effectiveCimdUrl = cimdUrl ?? existing.cimd_url;
      if (
        (effectiveAuthMethod === "http_signature" ||
          effectiveAuthMethod === "both") &&
        !effectiveCimdUrl
      ) {
        return res.status(400).json({
          error: "cimdUrl is required when using http_signature auth",
        });
      }

      // Probe the CIMD document when activating HTTP signature auth with a new cimdUrl
      if (
        cimdUrl &&
        (effectiveAuthMethod === "http_signature" ||
          effectiveAuthMethod === "both")
      ) {
        try {
          const probe = await fetch(cimdUrl, {
            method: "GET",
            signal: AbortSignal.timeout(5000),
            headers: { Accept: "application/json" },
          });
          if (!probe.ok) {
            return res.status(400).json({
              error: `CIMD document not reachable at ${cimdUrl} (HTTP ${probe.status}). Publish your document before updating.`,
            });
          }
          await probe.text();
        } catch {
          return res.status(400).json({
            error: `Could not reach CIMD document at ${cimdUrl}. Ensure the URL is publicly accessible.`,
          });
        }
      }

      const updateValues: Record<string, any> = { updated_at: new Date() };
      if (name) updateValues.name = name;
      if (domain) updateValues.domain = domain;
      if (cimdUrl !== undefined) updateValues.cimd_url = cimdUrl;
      if (authMethod !== undefined) updateValues.auth_method = authMethod;

      await db
        .updateTable("apps")
        .set(updateValues)
        .where("app_id", "=", req.params.appId)
        .where("creator_did", "=", agent.assertDid)
        .execute();

      const updated = await db
        .selectFrom("apps")
        .select([
          "app_id",
          "name",
          "domain",
          "auth_method",
          "cimd_url",
          "status",
          "created_at",
          "updated_at",
        ])
        .where("app_id", "=", req.params.appId)
        .executeTakeFirst();

      return res.json({ app: updated });
    } catch (err) {
      logger.error(
        { error: err, appId: req.params.appId },
        "Error updating app",
      );
      return res.status(500).json({ error: "Failed to update app" });
    }
  });

  // Deactivate an app
  router.delete("/:appId", async (req: Request, res: Response) => {
    try {
      const agent = await getSessionAgent(req, res, oauthClient);
      if (!agent) {
        return res.status(401).json({ error: "Not authenticated" });
      }

      const result = await db
        .updateTable("apps")
        .set({ status: "inactive", updated_at: new Date() })
        .where("app_id", "=", req.params.appId)
        .where("creator_did", "=", agent.assertDid)
        .where("status", "=", "active")
        .executeTakeFirst();

      if (!result.numUpdatedRows || result.numUpdatedRows === 0n) {
        return res
          .status(404)
          .json({ error: "App not found or already inactive" });
      }

      return res.json({ success: true, message: "App deactivated" });
    } catch (err) {
      logger.error(
        { error: err, appId: req.params.appId },
        "Error deleting app",
      );
      return res.status(500).json({ error: "Failed to delete app" });
    }
  });

  // Rotate API key (generates new key, invalidates old one)
  router.post("/:appId/rotate-key", async (req: Request, res: Response) => {
    try {
      const agent = await getSessionAgent(req, res, oauthClient);
      if (!agent) {
        return res.status(401).json({ error: "Not authenticated" });
      }

      const existing = await db
        .selectFrom("apps")
        .selectAll()
        .where("app_id", "=", req.params.appId)
        .where("creator_did", "=", agent.assertDid)
        .where("status", "=", "active")
        .executeTakeFirst();
      if (!existing) {
        return res.status(404).json({ error: "App not found or inactive" });
      }

      const newApiKey = `osc_${crypto.randomBytes(32).toString("hex")}`;

      await db
        .updateTable("apps")
        .set({
          api_key: hashApiKey(newApiKey),
          api_key_lookup: computeApiKeyLookup(newApiKey),
          updated_at: new Date(),
        })
        .where("app_id", "=", req.params.appId)
        .execute();

      return res.json({
        api_key: newApiKey,
        message: "Store the new api_key securely. The old key is now invalid.",
      });
    } catch (err) {
      logger.error(
        { error: err, appId: req.params.appId },
        "Error rotating key",
      );
      return res.status(500).json({ error: "Failed to rotate API key" });
    }
  });

  // Verify credentials (API key or HTTP signature)
  router.post("/verify", async (req: Request, res: Response) => {
    try {
      const apiKey = req.headers["x-api-key"] as string;
      const signatureInput = req.headers["signature-input"] as string;

      if (!apiKey && !signatureInput) {
        return res.status(401).json({
          error: "API key (X-Api-Key header) or HTTP signature required",
        });
      }

      if (apiKey) {
        // API key verification path — same indexed lookup as the middleware
        const app = await authenticateApiKey(db, apiKey);

        if (!app) {
          return res.status(401).json({ error: "Invalid API key" });
        }

        return res.json({
          valid: true,
          auth_method: "api_key",
          app: {
            appId: app.app_id,
            name: app.name,
            domain: app.domain,
          },
        });
      }

      // HTTP signature verification path — perform full verification
      if (!req.headers["signature"]) {
        return res.status(401).json({
          error: "Both Signature and Signature-Input headers are required",
        });
      }

      const keyIdMatch = signatureInput.match(/keyid="([^"]*)"/);
      if (!keyIdMatch) {
        return res
          .status(401)
          .json({ error: "Missing keyid in Signature-Input" });
      }

      const app = await db
        .selectFrom("apps")
        .selectAll()
        .where("status", "=", "active")
        .where((eb) =>
          eb.or([
            eb("app_id", "=", keyIdMatch[1]),
            eb("domain", "=", keyIdMatch[1]),
          ]),
        )
        .executeTakeFirst();

      if (!app) {
        return res.status(401).json({ error: "Unknown app" });
      }

      if (app.auth_method !== "http_signature" && app.auth_method !== "both") {
        return res.status(401).json({
          error: "This app is not configured for HTTP signature auth",
        });
      }

      const cimd = await getCimdDocument(app.domain, false, app.cimd_url);
      if (!cimd) {
        return res
          .status(401)
          .json({ error: "Could not fetch client identity document" });
      }

      const publicKey = jwkToKeyObject(cimd.publicKeyJwk);
      let result = verifyRequestSignature(req as any, publicKey);

      // Retry once on failure (key rotation — same as auth middleware)
      if (!result.valid) {
        invalidateCimdCache(app.domain);
        const freshCimd = await getCimdDocument(app.domain, true, app.cimd_url);
        if (freshCimd) {
          const freshKey = jwkToKeyObject(freshCimd.publicKeyJwk);
          result = verifyRequestSignature(req as any, freshKey);
        }
      }

      if (!result.valid) {
        return res
          .status(401)
          .json({ error: result.error || "Signature verification failed" });
      }

      return res.json({
        valid: true,
        auth_method: "http_signature",
        app: {
          appId: app.app_id,
          name: app.name,
          domain: app.domain,
        },
      });
    } catch (err) {
      logger.error({ error: err }, "Error verifying credentials");
      return res.status(500).json({ error: "Failed to verify credentials" });
    }
  });

  // ---------------------------------------------------------------------------
  // Default permission CRUD for an app (only the app creator can manage these)
  // ---------------------------------------------------------------------------

  // List default permissions for an app
  router.get(
    "/:appId/default-permissions",
    async (req: Request, res: Response) => {
      try {
        const agent = await getSessionAgent(req, res, oauthClient);
        if (!agent) {
          return res.status(401).json({ error: "Not authenticated" });
        }

        // Ensure the caller owns the app
        const app = await db
          .selectFrom("apps")
          .selectAll()
          .where("app_id", "=", req.params.appId)
          .where("creator_did", "=", agent.assertDid)
          .executeTakeFirst();
        if (!app) {
          return res.status(404).json({ error: "App not found" });
        }

        const permissions = await db
          .selectFrom("app_default_permissions")
          .selectAll()
          .where("app_id", "=", req.params.appId)
          .orderBy("collection", "asc")
          .execute();

        return res.json({
          permissions: permissions.map((p) => ({
            collection: p.collection,
            defaultCanCreate: p.default_can_create,
            defaultCanRead: p.default_can_read,
            defaultCanUpdate: p.default_can_update,
            defaultCanDelete: p.default_can_delete,
          })),
        });
      } catch (err) {
        logger.error(
          { error: err, appId: req.params.appId },
          "Error listing default permissions",
        );
        return res
          .status(500)
          .json({ error: "Failed to list default permissions" });
      }
    },
  );

  // Create or update a default permission
  router.post(
    "/:appId/default-permissions",
    async (req: Request, res: Response) => {
      try {
        const agent = await getSessionAgent(req, res, oauthClient);
        if (!agent) {
          return res.status(401).json({ error: "Not authenticated" });
        }

        const parsed = appDefaultPermissionSchema.safeParse(req.body);
        if (!parsed.success) {
          return res
            .status(400)
            .json({ error: "Invalid input", details: parsed.error.flatten() });
        }

        const app = await db
          .selectFrom("apps")
          .selectAll()
          .where("app_id", "=", req.params.appId)
          .where("creator_did", "=", agent.assertDid)
          .where("status", "=", "active")
          .executeTakeFirst();
        if (!app) {
          return res.status(404).json({ error: "App not found or inactive" });
        }

        const {
          collection,
          defaultCanCreate,
          defaultCanRead,
          defaultCanUpdate,
          defaultCanDelete,
        } = parsed.data;

        // Domain validation — collection must start with reversed app domain
        const domainPrefix = app.domain.split(".").reverse().join(".") + ".";
        if (!collection.startsWith(domainPrefix)) {
          return res
            .status(400)
            .json({ error: `Collection must start with "${domainPrefix}"` });
        }

        // Upsert
        const existing = await db
          .selectFrom("app_default_permissions")
          .selectAll()
          .where("app_id", "=", req.params.appId)
          .where("collection", "=", collection)
          .executeTakeFirst();

        if (existing) {
          await db
            .updateTable("app_default_permissions")
            .set({
              default_can_create: defaultCanCreate,
              default_can_read: defaultCanRead,
              default_can_update: defaultCanUpdate,
              default_can_delete: defaultCanDelete,
            })
            .where("app_id", "=", req.params.appId)
            .where("collection", "=", collection)
            .execute();
        } else {
          await db
            .insertInto("app_default_permissions")
            .values({
              app_id: req.params.appId,
              collection,
              default_can_create: defaultCanCreate,
              default_can_read: defaultCanRead,
              default_can_update: defaultCanUpdate,
              default_can_delete: defaultCanDelete,
            })
            .execute();
        }

        return res.json({ success: true });
      } catch (err) {
        logger.error(
          { error: err, appId: req.params.appId },
          "Error creating/updating default permission",
        );
        return res
          .status(500)
          .json({ error: "Failed to save default permission" });
      }
    },
  );

  // Update a specific field on a default permission
  router.put(
    "/:appId/default-permissions",
    async (req: Request, res: Response) => {
      try {
        const agent = await getSessionAgent(req, res, oauthClient);
        if (!agent) {
          return res.status(401).json({ error: "Not authenticated" });
        }

        const { collection, ...fields } = req.body;
        if (!collection) {
          return res.status(400).json({ error: "collection is required" });
        }

        const app = await db
          .selectFrom("apps")
          .selectAll()
          .where("app_id", "=", req.params.appId)
          .where("creator_did", "=", agent.assertDid)
          .where("status", "=", "active")
          .executeTakeFirst();
        if (!app) {
          return res.status(404).json({ error: "App not found or inactive" });
        }

        const updateValues: Record<string, string> = {};
        if (fields.defaultCanCreate)
          updateValues.default_can_create = fields.defaultCanCreate;
        if (fields.defaultCanRead)
          updateValues.default_can_read = fields.defaultCanRead;
        if (fields.defaultCanUpdate)
          updateValues.default_can_update = fields.defaultCanUpdate;
        if (fields.defaultCanDelete)
          updateValues.default_can_delete = fields.defaultCanDelete;

        if (Object.keys(updateValues).length === 0) {
          return res.status(400).json({ error: "No valid fields to update" });
        }

        const result = await db
          .updateTable("app_default_permissions")
          .set(updateValues)
          .where("app_id", "=", req.params.appId)
          .where("collection", "=", collection)
          .executeTakeFirst();

        if (!result.numUpdatedRows || result.numUpdatedRows === 0n) {
          return res.status(404).json({ error: "Permission not found" });
        }

        return res.json({ success: true });
      } catch (err) {
        logger.error(
          { error: err, appId: req.params.appId },
          "Error updating default permission",
        );
        return res
          .status(500)
          .json({ error: "Failed to update default permission" });
      }
    },
  );

  // Delete a default permission
  router.delete(
    "/:appId/default-permissions",
    async (req: Request, res: Response) => {
      try {
        const agent = await getSessionAgent(req, res, oauthClient);
        if (!agent) {
          return res.status(401).json({ error: "Not authenticated" });
        }

        const { collection } = req.body;
        if (!collection) {
          return res.status(400).json({ error: "collection is required" });
        }

        const app = await db
          .selectFrom("apps")
          .selectAll()
          .where("app_id", "=", req.params.appId)
          .where("creator_did", "=", agent.assertDid)
          .executeTakeFirst();
        if (!app) {
          return res.status(404).json({ error: "App not found" });
        }

        await db
          .deleteFrom("app_default_permissions")
          .where("app_id", "=", req.params.appId)
          .where("collection", "=", collection)
          .execute();

        return res.json({ success: true });
      } catch (err) {
        logger.error(
          { error: err, appId: req.params.appId },
          "Error deleting default permission",
        );
        return res
          .status(500)
          .json({ error: "Failed to delete default permission" });
      }
    },
  );

  // ═══════════════════════════════════════════════════════════════
  // RATE LIMITS
  // ═══════════════════════════════════════════════════════════════

  // GET /:appId/rate-limit — get current rate limit for an app
  router.get("/:appId/rate-limit", async (req: Request, res: Response) => {
    try {
      const agent = await getSessionAgent(req, res, oauthClient);
      if (!agent) {
        return res.status(401).json({ error: "Not authenticated" });
      }

      const app = await db
        .selectFrom("apps")
        .selectAll()
        .where("app_id", "=", req.params.appId)
        .where("creator_did", "=", agent.assertDid)
        .executeTakeFirst();
      if (!app) {
        return res.status(404).json({ error: "App not found" });
      }

      const rateLimit = await db
        .selectFrom("rate_limits")
        .select(["max_requests", "window_ms"])
        .where("app_id", "=", req.params.appId)
        .executeTakeFirst();

      return res.json({
        appId: req.params.appId,
        maxRequests: rateLimit?.max_requests ?? 1000,
        windowMs: rateLimit?.window_ms ?? 60000,
        isCustom: !!rateLimit,
      });
    } catch (err) {
      logger.error(
        { error: err, appId: req.params.appId },
        "Error getting rate limit",
      );
      return res.status(500).json({ error: "Failed to get rate limit" });
    }
  });

  // PUT /:appId/rate-limit — set a custom rate limit for an app
  router.put("/:appId/rate-limit", async (req: Request, res: Response) => {
    try {
      const agent = await getSessionAgent(req, res, oauthClient);
      if (!agent) {
        return res.status(401).json({ error: "Not authenticated" });
      }

      const { maxRequests, windowMs } = req.body;
      if (!maxRequests || typeof maxRequests !== "number" || maxRequests < 1) {
        return res
          .status(400)
          .json({ error: "maxRequests must be a positive number" });
      }

      const app = await db
        .selectFrom("apps")
        .selectAll()
        .where("app_id", "=", req.params.appId)
        .where("creator_did", "=", agent.assertDid)
        .where("status", "=", "active")
        .executeTakeFirst();
      if (!app) {
        return res.status(404).json({ error: "App not found or inactive" });
      }

      const effectiveWindowMs =
        windowMs && typeof windowMs === "number" ? windowMs : 60000;

      // Upsert the rate limit
      const existing = await db
        .selectFrom("rate_limits")
        .select("id")
        .where("app_id", "=", req.params.appId)
        .executeTakeFirst();

      if (existing) {
        await db
          .updateTable("rate_limits")
          .set({
            max_requests: maxRequests,
            window_ms: effectiveWindowMs,
            updated_at: new Date(),
          })
          .where("app_id", "=", req.params.appId)
          .execute();
      } else {
        await db
          .insertInto("rate_limits")
          .values({
            app_id: req.params.appId,
            max_requests: maxRequests,
            window_ms: effectiveWindowMs,
          })
          .execute();
      }

      return res.json({
        success: true,
        appId: req.params.appId,
        maxRequests,
        windowMs: effectiveWindowMs,
      });
    } catch (err) {
      logger.error(
        { error: err, appId: req.params.appId },
        "Error setting rate limit",
      );
      return res.status(500).json({ error: "Failed to set rate limit" });
    }
  });

  return router;
}
