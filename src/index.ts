import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import dotenv from "dotenv";
import http from "http";
import { config } from "./config";
import { createDb } from "./db";
import { createOAuthClient } from "./auth/client";
import { initDidCache, setOAuthClient } from "./services/atproto";
import { createAuthRouter } from "./routes/auth";
import { createAppRouter } from "./routes/apps";
import { createCommunityRouter } from "./routes/communities";
import { createMemberRouter } from "./routes/members";
import { createRecordsRouter } from "./routes/records";
import { createContentRouter } from "./routes/content";
import { createWebhookRouter } from "./routes/webhooks";
import { createStreamRouter } from "./routes/stream";
import { createPermissionsRouter } from "./routes/permissions";
import { createHierarchyRouter } from "./routes/hierarchy";
import { createEventsRouter } from "./routes/events";
import { createXrpcRouter } from "./xrpc/server";
import { createPocRouter } from "./routes/poc";
import { createRateLimiter } from "./middleware/rateLimit";
import { csrfProtection } from "./middleware/csrf";
import { logger } from "./lib/logger";
import { autoMigrate } from "./lib/autoMigrate";
import { requestLogger } from "./middleware/requestLogger";
import { validateEnvironment } from "./lib/validateEnv";
import { createEventStreamService } from "./services/eventStream";
import { createEventStream } from "./ws/eventStream";

dotenv.config();

// Validate environment variables before starting
try {
  validateEnvironment();
} catch (error) {
  logger.fatal({ error }, "Environment validation failed");
  console.error(
    "\n" + (error instanceof Error ? error.message : String(error)) + "\n",
  );
  process.exit(1);
}

const app = express();
const PORT = config.port;

// Trust the reverse proxy (Azure Container Apps / Envoy) so that
// req.protocol reflects the original scheme (https) and secure cookies work.
app.set("trust proxy", 1);

// Middleware
const allowedOrigins =
  config.nodeEnv === "production"
    ? ([config.corsOrigin, config.serviceUrl].filter(Boolean) as string[])
    : ["http://127.0.0.1:5174", "http://localhost:5174"];

app.use(
  cors({
    origin: (origin, callback) => {
      // Allow requests with no origin (e.g. curl, server-to-server)
      if (!origin) return callback(null, true);
      if (allowedOrigins.includes(origin)) {
        return callback(null, origin);
      }
      callback(new Error(`Origin ${origin} not allowed by CORS`));
    },
    credentials: true,
  }),
);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// Request logging with correlation IDs
app.use(requestLogger);

// Start server
async function start() {
  try {
    // Initialize database
    const db = createDb(config.databaseUrl);
    logger.info("Database connected");

    // Run pending migrations automatically at startup
    await autoMigrate(db);

    // Swap the in-memory DID cache for a PostgreSQL-backed one and start the
    // periodic cleanup job that prunes expired entries.
    initDidCache(db);

    // Initialize OAuth client
    const oauthClient = await createOAuthClient(db);
    // Register the OAuth client so non-OAuth code paths (e.g. community
    // agent app-password login) can reuse its `OAuthResolver` to discover
    // the proper authorization server from PDS metadata.
    setOAuthClient(oauthClient);
    logger.info("OAuth client initialized");

    // Apply global middleware
    const rateLimiter = createRateLimiter(db);
    app.use("/api/", rateLimiter);
    app.use("/xrpc/", rateLimiter);

    // Dev-only PoC endpoints (no auth; acting DID passed explicitly). Mounted
    // before csrfProtection so the experiment UI can call them without a session.
    if (config.nodeEnv !== "production") {
      app.use("/api/poc/communities", createPocRouter(db));
      logger.info("Dev PoC router mounted at /api/poc/communities");
    }

    app.use(csrfProtection);

    // Auth routes (OAuth)
    app.use(createAuthRouter(oauthClient, db));

    // API routes
    app.get("/health", (req, res) => {
      res.json({
        status: "ok",
        timestamp: new Date().toISOString(),
        service: "opensocial-api",
      });
    });

    app.use("/api/v1/apps", createAppRouter(oauthClient, db));
    app.use("/api/v1/communities", createCommunityRouter(db));
    app.use("/api/v1/communities", createMemberRouter(db));
    app.use("/api/v1/communities", createRecordsRouter(db));
    app.use(
      "/api/v1/communities/:did/content",
      createContentRouter(oauthClient, db),
    );
    app.use("/api/v1/communities", createPermissionsRouter(db));
    app.use("/api/v1/communities", createHierarchyRouter(db));
    app.use("/api/v1/webhooks", createWebhookRouter(db));

    // Event stream (WebSocket)
    const eventStreamService = createEventStreamService(db);
    app.use("/api/v1/stream", createStreamRouter(db, eventStreamService));

    app.use("/api/v1/events", createEventsRouter(oauthClient));

    // XRPC endpoints (ATProto-style RPC)
    app.use("/xrpc", createXrpcRouter(db));

    // Error handling
    app.use(
      (
        err: any,
        req: express.Request,
        res: express.Response,
        next: express.NextFunction,
      ) => {
        logger.error(
          {
            error: err,
            correlationId: req.correlationId,
            path: req.path,
            method: req.method,
          },
          "Unhandled error",
        );
        res.status(500).json({ error: "Internal server error" });
      },
    );

    const server = http.createServer(app);

    // Attach WebSocket event stream to the HTTP server
    const eventStream = createEventStream(server, eventStreamService);

    server.listen(PORT, () => {
      logger.info(
        {
          port: PORT,
          mode: config.nodeEnv,
          healthCheck: `http://localhost:${PORT}/health`,
          wsStream: `ws://localhost:${PORT}/api/v1/stream`,
          oauthCallback:
            config.nodeEnv === "development"
              ? `http://127.0.0.1:${PORT}/oauth/callback`
              : undefined,
        },
        "OpenSocial API server started",
      );
    });
  } catch (error) {
    logger.error(
      {
        err: error,
        message: error instanceof Error ? error.message : String(error),
      },
      "Failed to start server",
    );
    process.exit(1);
  }
}

start();
