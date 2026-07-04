import { Router, Request, Response, NextFunction } from "express";
import fs from "fs";
import path from "path";
import type { Kysely } from "kysely";
import type { Database } from "../db";
import { createVerifyApiKey } from "../middleware/auth";
import { createRateLimiter } from "../middleware/rateLimit";
import { registerRecordHandlers } from "./records";
import { registerCommunityHandlers } from "./communities";
import { registerMemberHandlers } from "./members";
import {
  createCheckUserAccessHandler,
  CHECK_USER_ACCESS_LXM,
} from "./checkUserAccess";
import { logger } from "../lib/logger";

export interface XrpcHandler {
  type: "query" | "procedure";
  handler: (params: Record<string, any>, req: Request) => Promise<any>;
}

export class XrpcError extends Error {
  constructor(
    public status: number,
    public errorName: string,
    message: string,
  ) {
    super(message);
    this.name = "XrpcError";
  }
}

/**
 * Load all lexicon JSON files from the lexicons/ directory.
 */
function loadLexicons(): Record<string, any> {
  const lexDir = path.resolve(__dirname, "../../lexicons");
  const lexicons: Record<string, any> = {};
  if (!fs.existsSync(lexDir)) {
    logger.warn(
      { lexDir },
      "Lexicons directory not found — XRPC will run without schema validation",
    );
    return lexicons;
  }
  for (const file of fs.readdirSync(lexDir)) {
    if (!file.endsWith(".json")) continue;
    const doc = JSON.parse(fs.readFileSync(path.join(lexDir, file), "utf-8"));
    if (doc.id && doc.defs?.main) {
      lexicons[doc.id] = doc.defs.main;
    }
  }
  return lexicons;
}

/**
 * Create the XRPC Express router with all handlers registered.
 */
export function createXrpcRouter(db: Kysely<Database>): Router {
  const router = Router();
  const verifyApiKey = createVerifyApiKey(db);
  const lexicons = loadLexicons();
  const handlers = new Map<string, XrpcHandler>();

  // Register all handlers
  registerRecordHandlers(handlers, db);
  registerCommunityHandlers(handlers, db);
  registerMemberHandlers(handlers, db);

  // Service-auth method: called by group PDSes, not by API-key apps.
  router.get(`/${CHECK_USER_ACCESS_LXM}`, createCheckUserAccessHandler(db));

  // Apply rate limiting and API key auth to all XRPC routes
  const rateLimiter = createRateLimiter(db);
  router.use(rateLimiter);
  router.use(verifyApiKey);

  // GET /xrpc/:methodId — XRPC queries
  router.get(
    "/:methodId",
    async (req: Request, res: Response, next: NextFunction) => {
      const methodId = req.params.methodId;
      const handler = handlers.get(methodId);

      if (!handler) {
        return res.status(501).json({
          error: "MethodNotImplemented",
          message: `Method not implemented: ${methodId}`,
        });
      }

      const lexDef = lexicons[methodId];
      if (lexDef && lexDef.type !== "query") {
        return res.status(400).json({
          error: "InvalidRequest",
          message: `${methodId} is a procedure, use POST`,
        });
      }

      try {
        const result = await handler.handler(
          req.query as Record<string, any>,
          req,
        );
        res.json(result);
      } catch (err) {
        handleXrpcError(err, res, methodId);
      }
    },
  );

  // POST /xrpc/:methodId — XRPC procedures
  router.post(
    "/:methodId",
    async (req: Request, res: Response, next: NextFunction) => {
      const methodId = req.params.methodId;
      const handler = handlers.get(methodId);

      if (!handler) {
        return res.status(501).json({
          error: "MethodNotImplemented",
          message: `Method not implemented: ${methodId}`,
        });
      }

      const lexDef = lexicons[methodId];
      if (lexDef && lexDef.type !== "procedure") {
        return res.status(400).json({
          error: "InvalidRequest",
          message: `${methodId} is a query, use GET`,
        });
      }

      try {
        const result = await handler.handler(req.body || {}, req);
        res.json(result);
      } catch (err) {
        handleXrpcError(err, res, methodId);
      }
    },
  );

  return router;
}

function handleXrpcError(err: unknown, res: Response, methodId: string): void {
  if (err instanceof XrpcError) {
    res.status(err.status).json({
      error: err.errorName,
      message: err.message,
    });
    return;
  }

  logger.error({ error: err, methodId }, "XRPC handler error");
  res.status(500).json({
    error: "InternalServerError",
    message: err instanceof Error ? err.message : "Internal server error",
  });
}
