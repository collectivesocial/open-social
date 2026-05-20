import { Agent, BskyAgent } from "@atproto/api";
import express, { Request, Response } from "express";
import { getIronSession } from "iron-session";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { NodeOAuthClient } from "@atproto/oauth-client-node";
import crypto from "crypto";
import multer from "multer";
import { config } from "../config";
import { sql, type Kysely } from "kysely";
import type { Database } from "../db";
import {
  ensureServiceUrl,
  createCommunityAgent,
  resolvePdsEndpoint,
  resolveAuthServer,
  resolveHandleToDid,
  invalidateCommunityAgent,
} from "../services/atproto";
import {
  isAdminInList,
  getOriginalAdminDid,
  normalizeAdmins,
} from "../lib/adminUtils";
import { encrypt, decryptIfNeeded } from "../lib/crypto";
import {
  hasScope,
  MEMBERSHIP_WRITE_SCOPE,
  OPENSOCIAL_SCOPES,
} from "../middleware/auth";
import { authRateLimiter } from "../middleware/rateLimit";
import { checkAdmin, seedCollectionPermissions } from "../services/permissions";
import { createAuditLogService } from "../services/auditLog";
import { memberRolesCache } from "../lib/cache";
import { logger } from "../lib/logger";
import { sanitizeUserContent } from "../lib/sanitize";

// Configure multer for file uploads
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 1024 * 1024, // 1MB limit
  },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith("image/")) {
      cb(null, true);
    } else {
      cb(new Error("Only image files are allowed"));
    }
  },
});

interface CommunityProfile {
  displayName: string;
  description?: string;
  type?: "open" | "admin-approved" | "private";
  avatar?: string | { $type: string; ref: { $link: string }; mimeType: string };
  links?: CommunityLink[];
}

interface CommunityLink {
  name: string;
  url: string;
}

interface MembershipRecord {
  community: string; // DID of the community
  role: string; // member, admin, moderator, etc.
  since: string; // ISO timestamp
}

interface MembershipProofRecord {
  cid: string; // CID of the user's membership record
  memberDid?: string; // DID of the member this proof confirms
}

// Helper to convert blob reference to CDN URL
function blobToUrl(
  blob: any,
  did: string,
  pdsHost: string,
): string | undefined {
  if (!blob) return undefined;
  if (typeof blob === "string") return blob;

  // Handle BlobRef object from @atproto/api
  if (blob.ref) {
    const cid = typeof blob.ref === "string" ? blob.ref : blob.ref.toString();
    return `${pdsHost}/xrpc/com.atproto.sync.getBlob?did=${did}&cid=${cid}`;
  }

  // Handle plain blob object with $type
  if (blob.$type === "blob" && blob.ref?.$link) {
    return `${pdsHost}/xrpc/com.atproto.sync.getBlob?did=${did}&cid=${blob.ref.$link}`;
  }

  return undefined;
}

/**
 * Fetch the Bluesky profile avatar for a DID as a fallback
 * when no custom community avatar is set.
 */
async function fetchBlueskyAvatar(did: string): Promise<string | undefined> {
  try {
    const publicAgent = new BskyAgent({
      service: "https://public.api.bsky.app",
    });
    const profile = await publicAgent.getProfile({ actor: did });
    return profile.data.avatar || undefined;
  } catch (err) {
    logger.warn({ error: err, did }, "Could not fetch Bluesky avatar");
    return undefined;
  }
}

function ifString(val: unknown): string | undefined {
  return typeof val === "string" && val.length > 0 ? val : undefined;
}

/**
 * Resolve a Bluesky profile to get handle, display name, and avatar.
 */
async function resolveBlueskyProfile(did: string): Promise<{
  handle: string | null;
  displayName: string | null;
  avatar: string | null;
}> {
  try {
    const res = await fetch(
      `https://public.api.bsky.app/xrpc/app.bsky.actor.getProfile?actor=${encodeURIComponent(did)}`,
    );
    if (res.ok) {
      const data = (await res.json()) as any;
      return {
        handle: data.handle || null,
        displayName: data.displayName || null,
        avatar: data.avatar || null,
      };
    }
  } catch {}
  return { handle: null, displayName: null, avatar: null };
}

type Session = { did?: string };

const MAX_AGE = config.nodeEnv === "production" ? 60 : 300;

// Consistent session options for all session operations
const sessionOptions = {
  cookieName: "sid",
  password: config.cookieSecret,
  cookieOptions: {
    secure: config.nodeEnv === "production",
    sameSite: "lax" as const,
    httpOnly: true,
    path: "/",
    // Share cookie across subdomains (api.opensocial.community ↔ app.opensocial.community)
    domain:
      config.nodeEnv === "production" ? ".opensocial.community" : undefined,
  },
};

// Helper function to get the Atproto Agent for the active session
async function getSessionAgent(
  req: IncomingMessage,
  res: ServerResponse,
  oauthClient: NodeOAuthClient,
) {
  res.setHeader("Vary", "Cookie");

  const session = await getIronSession<Session>(req, res, sessionOptions);

  if (!session.did) {
    logger.info("No DID in session");
    return null;
  }

  res.setHeader("cache-control", `max-age=${MAX_AGE}, private`);

  try {
    const oauthSession = await oauthClient.restore(session.did);
    if (!oauthSession) return null;

    const agent = new Agent(oauthSession);

    // Attach granted scopes to the agent for downstream permission checks
    try {
      const tokenInfo = await oauthSession.getTokenInfo();
      (agent as any).__grantedScope = tokenInfo.scope;
    } catch {
      // If token info unavailable, scope checks will be skipped
    }

    return agent;
  } catch (err) {
    logger.warn({ error: err }, "OAuth restore failed");
    await session.destroy();
    return null;
  }
}

/**
 * Get the granted scope string from an agent created by getSessionAgent.
 * Returns undefined if scopes could not be determined.
 */
function getAgentScope(agent: Agent): string | undefined {
  return (agent as any).__grantedScope;
}

// ─── Event record helpers ─────────────────────────────────────────────

function parseEventMode(value: unknown): "in-person" | "virtual" | "hybrid" {
  const s = String(value ?? "").replace("#", "");
  if (s === "inperson" || s === "in-person") return "in-person";
  if (s === "virtual") return "virtual";
  if (s === "hybrid") return "hybrid";
  return "virtual";
}

function extractEventLocation(locations: unknown): string | undefined {
  if (!Array.isArray(locations) || locations.length === 0) return undefined;
  const loc = locations[0] as Record<string, unknown>;

  if (loc.locality || loc.region || loc.country) {
    return [loc.locality, loc.region, loc.country].filter(Boolean).join(", ");
  }
  if (loc.latitude !== undefined && loc.longitude !== undefined) {
    if (typeof loc.name === "string" && loc.name.length > 0) return loc.name;
    return `${loc.latitude}, ${loc.longitude}`;
  }
  if (typeof loc.name === "string") return loc.name;
  return undefined;
}

export function createAuthRouter(
  oauthClient: NodeOAuthClient,
  db: Kysely<Database>,
) {
  const router = express.Router();

  // OAuth metadata
  router.get("/oauth-client-metadata.json", (req: Request, res: Response) => {
    res.setHeader("cache-control", `max-age=${MAX_AGE}, public`);
    res.json(oauthClient.clientMetadata);
  });

  // Public keys
  router.get("/.well-known/jwks.json", (req: Request, res: Response) => {
    res.setHeader("cache-control", `max-age=${MAX_AGE}, public`);
    res.json(oauthClient.jwks);
  });

  // OAuth callback to complete session creation
  router.get("/oauth/callback", async (req: Request, res: Response) => {
    res.setHeader("cache-control", "no-store");

    const params = new URLSearchParams(req.originalUrl.split("?")[1]);

    try {
      // Load the session cookie
      const session = await getIronSession<Session>(req, res, sessionOptions);

      // If the user is already signed in, destroy the old credentials
      if (session.did) {
        try {
          const oauthSession = await oauthClient.restore(session.did);
          if (oauthSession) oauthSession.signOut();
        } catch (err) {
          logger.warn({ error: err }, "OAuth restore failed");
        }
      }

      // Complete the OAuth flow
      const oauth = await oauthClient.callback(params);

      // Update the session cookie
      session.did = oauth.session.did;

      await session.save();
    } catch (err) {
      const message = err instanceof Error ? err.message : "unexpected error";
      const stack = err instanceof Error ? err.stack : undefined;
      logger.error(
        {
          error: message,
          stack,
          name: err instanceof Error ? err.name : undefined,
        },
        "OAuth callback failed",
      );
    }

    // Redirect back to the frontend
    const redirectUrl =
      config.nodeEnv === "production"
        ? config.corsOrigin || config.serviceUrl || "http://127.0.0.1:5174"
        : "http://127.0.0.1:5174";
    return res.redirect(redirectUrl);
  });

  // Login handler
  router.post(
    "/login",
    express.json(),
    express.urlencoded({ extended: true }),
    async (req: Request, res: Response) => {
      res.setHeader("cache-control", "no-store");

      const isJsonRequest =
        req.headers["content-type"]?.includes("application/json");

      try {
        // Validate input: can be a handle, a DID or a service URL (PDS).
        const input = ifString(req.body.input);
        if (!input) {
          throw new Error("Invalid input");
        }

        // Initiate the OAuth flow
        const url = await oauthClient.authorize(input, {
          scope: OPENSOCIAL_SCOPES,
        });

        if (isJsonRequest) {
          return res.json({ redirectUrl: url.toString() });
        }
        res.redirect(url.toString());
      } catch (err) {
        const message = err instanceof Error ? err.message : "unexpected error";
        const stack = err instanceof Error ? err.stack : undefined;
        logger.error(
          {
            error: message,
            stack,
            name: err instanceof Error ? err.name : undefined,
          },
          "OAuth authorize failed",
        );

        if (isJsonRequest) {
          return res.status(400).json({ error: message });
        }
        const redirectUrl =
          config.nodeEnv === "production"
            ? config.corsOrigin || config.serviceUrl || "http://127.0.0.1:5174"
            : "http://127.0.0.1:5174";
        return res.redirect(
          `${redirectUrl}?error=${encodeURIComponent(message)}`,
        );
      }
    },
  );

  // Logout handler
  router.post("/logout", async (req: Request, res: Response) => {
    res.setHeader("cache-control", "no-store");

    const session = await getIronSession<Session>(req, res, sessionOptions);

    // Revoke credentials on the server
    if (session.did) {
      try {
        const oauthSession = await oauthClient.restore(session.did);
        if (oauthSession) await oauthSession.signOut();
      } catch (err) {
        logger.warn({ error: err }, "Failed to revoke credentials");
      }
    }

    session.destroy();

    return res.json({ success: true });
  });

  // Get current user
  router.get("/users/me", async (req: Request, res: Response) => {
    try {
      const agent = await getSessionAgent(req, res, oauthClient);

      if (!agent) {
        return res.status(401).json({ error: "Not authenticated" });
      }

      // Try fetching the full profile from the AppView; fall back to
      // minimal info from the DID document when no AppView is available
      // (e.g. local devnet).
      try {
        const profile = await agent.getProfile({ actor: agent.assertDid });

        return res.json({
          did: agent.assertDid,
          handle: profile.data.handle,
          displayName: profile.data.displayName,
          avatar: profile.data.avatar,
          description: profile.data.description,
        });
      } catch (profileErr) {
        logger.warn(
          { error: profileErr },
          "getProfile failed, returning minimal user info",
        );

        let handle: string | undefined;
        try {
          const sessionInfo = await agent.com.atproto.server.getSession();
          handle = sessionInfo.data.handle;
        } catch {
          // ignore — handle stays undefined
        }

        return res.json({
          did: agent.assertDid,
          handle: handle || agent.assertDid,
        });
      }
    } catch (err) {
      logger.error({ error: err }, "Failed to get user");
      return res.status(500).json({ error: "Failed to get user" });
    }
  });

  // Get user's community memberships
  router.get("/users/me/memberships", async (req: Request, res: Response) => {
    try {
      const agent = await getSessionAgent(req, res, oauthClient);

      if (!agent) {
        return res.status(401).json({ error: "Not authenticated" });
      }

      res.setHeader("cache-control", "no-store");

      // Fetch user's membership records
      const membershipsResponse = await agent.api.com.atproto.repo.listRecords({
        repo: agent.assertDid,
        collection: "community.opensocial.membership",
      });

      // Fetch details for each community
      const memberships = await Promise.all(
        membershipsResponse.data.records.map(async (record: any) => {
          try {
            const membershipValue = record.value as MembershipRecord;
            const communityDid = membershipValue.community;
            const membershipUri = record.uri;

            // Get community credentials from database
            const community = await db
              .selectFrom("communities")
              .selectAll()
              .where("did", "=", communityDid)
              .executeTakeFirst();

            if (!community) {
              logger.warn({ communityDid }, "Community not found in database");
              return null;
            }

            // Create agent for the community. Target the OAuth auth server
            // (entryway) for login; subsequent record reads go to the
            // user's actual PDS via the agent's auto-populated `pdsUrl`.
            const authServerUrl = await resolveAuthServer(
              communityDid,
              community.pds_host,
            );
            const communityAgent = new BskyAgent({ service: authServerUrl });
            await communityAgent.login({
              identifier: communityDid,
              password: decryptIfNeeded(community.app_password),
            });

            // Fetch community profile using the community's own agent
            try {
              const profileResponse =
                await communityAgent.api.com.atproto.repo.getRecord({
                  repo: communityDid,
                  collection: "community.opensocial.profile",
                  rkey: "self",
                });

              const profileValue = profileResponse.data
                .value as CommunityProfile;

              const avatarUrl =
                blobToUrl(
                  profileValue.avatar,
                  communityDid,
                  community.pds_host,
                ) || (await fetchBlueskyAvatar(communityDid));

              // Check if community has confirmed this membership via membershipProof
              const proofsResponse =
                await communityAgent.api.com.atproto.repo.listRecords({
                  repo: communityDid,
                  collection: "community.opensocial.membershipProof",
                });

              // Get the membership record details to compare CID
              const membershipRecordResponse =
                await agent.api.com.atproto.repo.getRecord({
                  repo: agent.assertDid,
                  collection: "community.opensocial.membership",
                  rkey: record.uri.split("/").pop()!,
                });

              const isConfirmed = proofsResponse.data.records.some(
                (proof: any) => {
                  const proofValue = proof.value as MembershipProofRecord;
                  // Match by memberDid (primary) or CID (legacy).
                  // The approval flow writes cid: "" so CID-only matching
                  // would never confirm approved members.
                  return (
                    proofValue.memberDid === agent.assertDid ||
                    proofValue.cid === membershipRecordResponse.data.cid
                  );
                },
              );

              return {
                uri: record.uri,
                cid: record.cid,
                communityDid,
                joinedAt: membershipValue.since,
                role: membershipValue.role,
                status: isConfirmed ? "active" : "pending",
                community: {
                  did: communityDid,
                  displayName: profileValue.displayName,
                  description: profileValue.description,
                  avatar: avatarUrl,
                },
              };
            } catch (profileErr) {
              logger.warn(
                { error: profileErr, communityDid },
                "Failed to fetch profile for community",
              );
              return null;
            }
          } catch (err) {
            logger.error({ error: err }, "Failed to process membership record");
            return null;
          }
        }),
      );

      // Filter out null entries (failed fetches)
      const validMemberships = memberships.filter(
        (m): m is NonNullable<typeof m> => m !== null,
      );

      return res.json({ memberships: validMemberships });
    } catch (err) {
      logger.error({ error: err }, "Failed to get memberships");
      return res.status(500).json({ error: "Failed to get memberships" });
    }
  });

  // ─── User publications (standard.site documents) ───────────────
  router.get("/users/me/publications", async (req: Request, res: Response) => {
    try {
      const agent = await getSessionAgent(req, res, oauthClient);
      if (!agent) {
        return res.status(401).json({ error: "Not authenticated" });
      }

      res.setHeader("cache-control", "no-store");

      const userDid = agent.assertDid;
      const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 100);
      const cursor =
        typeof req.query.cursor === "string" ? req.query.cursor : undefined;

      // Resolve user's PDS to fetch their site.standard.document records
      const pdsHost = await resolvePdsEndpoint(userDid, config.pdsUrl);

      const listUrl = new URL(`${pdsHost}/xrpc/com.atproto.repo.listRecords`);
      listUrl.searchParams.set("repo", userDid);
      listUrl.searchParams.set("collection", "site.standard.document");
      listUrl.searchParams.set("limit", String(limit));
      if (cursor) listUrl.searchParams.set("cursor", cursor);

      const listRes = await fetch(listUrl.toString());
      if (!listRes.ok) {
        // User may not have any documents — return empty
        return res.json({ publications: [], cursor: undefined });
      }

      const data = (await listRes.json()) as {
        records: Array<{ uri: string; cid: string; value: any }>;
        cursor?: string;
      };

      const publications = data.records.map((record) => ({
        uri: record.uri,
        cid: record.cid,
        title: record.value.title || "Untitled",
        path: record.value.path || undefined,
        publishedAt: record.value.publishedAt || undefined,
        coverImage: record.value.coverImage ? true : undefined,
      }));

      return res.json({ publications, cursor: data.cursor });
    } catch (err) {
      logger.error({ error: err }, "Failed to get publications");
      return res.status(500).json({ error: "Failed to get publications" });
    }
  });

  // ─── User events (community.lexicon.calendar.event records) ──────
  router.get("/users/me/events", async (req: Request, res: Response) => {
    try {
      const agent = await getSessionAgent(req, res, oauthClient);
      if (!agent) {
        return res.status(401).json({ error: "Not authenticated" });
      }

      res.setHeader("cache-control", "no-store");

      const userDid = agent.assertDid;
      const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 100);
      const cursor =
        typeof req.query.cursor === "string" ? req.query.cursor : undefined;

      const pdsHost = await resolvePdsEndpoint(userDid, config.pdsUrl);

      const listUrl = new URL(`${pdsHost}/xrpc/com.atproto.repo.listRecords`);
      listUrl.searchParams.set("repo", userDid);
      listUrl.searchParams.set(
        "collection",
        "community.lexicon.calendar.event",
      );
      listUrl.searchParams.set("limit", String(limit));
      if (cursor) listUrl.searchParams.set("cursor", cursor);

      const listRes = await fetch(listUrl.toString());
      if (!listRes.ok) {
        return res.json({ events: [], cursor: undefined });
      }

      const data = (await listRes.json()) as {
        records: Array<{ uri: string; cid: string; value: any }>;
        cursor?: string;
      };

      const events = data.records.map((record) => {
        const v = record.value;
        return {
          uri: record.uri,
          cid: record.cid,
          name: (v.name as string) || "Untitled Event",
          startsAt: v.startsAt || undefined,
          endsAt: v.endsAt || undefined,
          description: v.description || undefined,
          mode: parseEventMode(v.mode),
          location: extractEventLocation(v.locations),
          status: (v.status as string) || "scheduled",
        };
      });

      return res.json({ events, cursor: data.cursor });
    } catch (err) {
      logger.error({ error: err }, "Failed to get events");
      return res.status(500).json({ error: "Failed to get events" });
    }
  });

  // Create a new community (requires an existing AT Protocol account)
  router.post(
    "/users/me/communities",
    authRateLimiter,
    async (req: Request, res: Response) => {
      try {
        const agent = await getSessionAgent(req, res, oauthClient);

        if (!agent) {
          return res.status(401).json({ error: "Not authenticated" });
        }

        const {
          displayName,
          description,
          did: existingDid,
          appPassword,
        } = req.body;

        if (!displayName) {
          return res.status(400).json({ error: "displayName is required" });
        }

        if (!existingDid || !appPassword) {
          return res
            .status(400)
            .json({ error: "did and appPassword are required" });
        }

        // If the user provided a handle instead of a DID, resolve it to the
        // actual DID (with bidirectional verification per ATProto spec).
        let communityDid = existingDid;
        if (!existingDid.startsWith("did:")) {
          try {
            communityDid = await resolveHandleToDid(existingDid);
            logger.info(
              { handle: existingDid, did: communityDid },
              "Resolved handle to DID for community creation",
            );
          } catch (err) {
            logger.error(
              { error: err, handle: existingDid },
              "Failed to resolve handle",
            );
            return res.status(400).json({
              error: `Could not resolve handle "${existingDid}" to a DID`,
            });
          }
        }

        let communityHandle: string;

        // Resolve DID to get handle and actual PDS endpoint
        const pdsHost = await resolvePdsEndpoint(existingDid, config.pdsUrl);
        // Discover the OAuth authorization server (entryway) to target for
        // login. In single-PDS deployments this is the same as `pdsHost`.
        const authServerUrl = await resolveAuthServer(existingDid, pdsHost);
        try {
          const profile = await agent.getProfile({ actor: existingDid });
          communityHandle = profile.data.handle || existingDid;
        } catch (e) {
          logger.warn(
            { error: e, did: existingDid },
            "Could not resolve handle, using DID as fallback",
          );
          communityHandle = existingDid;
        }

        // Login with app password to verify credentials. Subsequent repo
        // writes via the same agent are auto-dispatched to the PDS.
        const bskyAgent = new BskyAgent({ service: authServerUrl });
        await bskyAgent.login({
          identifier: existingDid,
          password: appPassword,
        });
        const communityAgent: Agent = bskyAgent;

        // Store in database
        await db
          .insertInto("communities")
          .values({
            did: communityDid,
            handle: communityHandle,
            display_name: displayName,
            pds_host: pdsHost,
            app_password: encrypt(appPassword),
            created_at: new Date(),
          })
          .execute();

        // Create community profile
        try {
          await communityAgent.api.com.atproto.repo.putRecord({
            repo: communityDid,
            collection: "community.opensocial.profile",
            rkey: "self",
            record: {
              $type: "community.opensocial.profile",
              displayName,
              description: description || "",
              type: "open", // Default to open community
              createdAt: new Date().toISOString(),
            },
          });
        } catch (err) {
          logger.error(
            { error: err, did: existingDid },
            "Failed to create profile record",
          );
          return res.status(500).json({
            error: "Failed to create community profile",
            details: err instanceof Error ? err.message : "Unknown error",
          });
        }

        // Create admin list with creator as first admin
        try {
          await communityAgent.api.com.atproto.repo.putRecord({
            repo: communityDid,
            collection: "community.opensocial.admins",
            rkey: "self",
            record: {
              $type: "community.opensocial.admins",
              admins: [agent.assertDid],
              createdAt: new Date().toISOString(),
            },
          });
        } catch (err) {
          logger.error(
            { error: err, did: existingDid },
            "Failed to create admins list",
          );
          return res.status(500).json({
            error: "Failed to create admins list",
            details: err instanceof Error ? err.message : "Unknown error",
          });
        }

        // Create membership record in user's repo
        // Verify the OAuth session has the required scope to write membership records
        const grantedScope = getAgentScope(agent);
        if (grantedScope && !hasScope(grantedScope, MEMBERSHIP_WRITE_SCOPE)) {
          return res.status(403).json({
            error: "Insufficient scope",
            details: `Required scope: ${MEMBERSHIP_WRITE_SCOPE}`,
          });
        }

        const membershipRecord = await agent.api.com.atproto.repo.createRecord({
          repo: agent.assertDid,
          collection: "community.opensocial.membership",
          record: {
            $type: "community.opensocial.membership",
            community: communityDid,
            role: "admin", // Creator is admin
            since: new Date().toISOString(),
          },
        });

        // Create membershipProof in community's repo using the membership record's CID
        await communityAgent.api.com.atproto.repo.createRecord({
          repo: communityDid,
          collection: "community.opensocial.membershipProof",
          record: {
            $type: "community.opensocial.membershipProof",
            memberDid: agent.assertDid,
            cid: membershipRecord.data.cid,
            confirmedAt: new Date().toISOString(),
          },
        });

        // Enable the system app for this community and seed default permissions
        try {
          await db
            .insertInto("community_app_visibility")
            .values({
              community_did: communityDid,
              app_id: "app_system",
              status: "enabled",
              created_at: new Date(),
              updated_at: new Date(),
            })
            .onConflict((oc) =>
              oc.columns(["community_did", "app_id"]).doNothing(),
            )
            .execute();
          await seedCollectionPermissions(db, communityDid, "app_system");
        } catch (err) {
          logger.warn(
            { error: err, did: communityDid },
            "Failed to enable system app for new community",
          );
        }

        return res.json({
          success: true,
          community: {
            did: communityDid,
            handle: communityHandle,
            displayName,
            description,
          },
        });
      } catch (err) {
        logger.error({ error: err }, "Failed to create community");
        return res.status(500).json({
          error: "Failed to create community",
          details: err instanceof Error ? err.message : "Unknown error",
        });
      }
    },
  );

  // ─── Search communities (fuzzy matching via pg_trgm) ────────────
  router.get("/communities/search", async (req: Request, res: Response) => {
    try {
      const agent = await getSessionAgent(req, res, oauthClient);
      if (!agent) {
        return res.status(401).json({ error: "Not authenticated" });
      }

      const rawQuery =
        typeof req.query.query === "string"
          ? req.query.query.trim()
          : typeof req.query.q === "string"
            ? req.query.q.trim()
            : "";

      // Require at least 3 characters for a search query
      if (rawQuery.length > 0 && rawQuery.length < 3) {
        return res.json({ communities: [] });
      }

      const limitParam = Number(req.query.limit) || 20;
      const limit = Math.min(Math.max(limitParam, 1), 100);

      const TWENTY_FOUR_HOURS = 24 * 60 * 60 * 1000;
      const now = Date.now();

      let dbQuery = db.selectFrom("communities").selectAll();

      if (rawQuery.length >= 3) {
        // Fuzzy search: combine trigram similarity with ILIKE fallback
        // All user input goes through Kysely parameterised bindings — safe from SQL injection
        dbQuery = dbQuery
          .where((eb) =>
            eb.or([
              eb(sql`similarity(handle, ${rawQuery})`, ">", sql`0.15`),
              eb(sql`similarity(display_name, ${rawQuery})`, ">", sql`0.15`),
              sql<boolean>`handle ILIKE ${"%" + rawQuery + "%"}`,
              sql<boolean>`display_name ILIKE ${"%" + rawQuery + "%"}`,
            ]),
          )
          .orderBy(
            sql`GREATEST(similarity(handle, ${rawQuery}), similarity(display_name, ${rawQuery}))`,
            "desc",
          );
      } else {
        // No query — return top communities by member count
        dbQuery = dbQuery.orderBy(sql`COALESCE(member_count, 0)`, "desc");
      }

      const communities = await dbQuery.limit(limit).execute();

      // For each result, return cached metadata or refresh if stale (>24h)
      const results = await Promise.all(
        communities.map(async (c) => {
          const stale =
            !c.metadata_fetched_at ||
            now - new Date(c.metadata_fetched_at).getTime() > TWENTY_FOUR_HOURS;

          if (!stale && c.description !== null) {
            return {
              did: c.did,
              handle: c.handle,
              displayName: c.display_name,
              description: c.description,
              avatar: c.avatar_url,
              type: c.community_type || "open",
              memberCount: c.member_count ?? 0,
            };
          }

          // Refresh metadata from PDS
          try {
            const communityAgent = new BskyAgent({ service: c.pds_host });
            await communityAgent.login({
              identifier: c.handle,
              password: decryptIfNeeded(c.app_password),
            });

            let description = "";
            let avatarUrl: string | undefined;
            let communityType = "open";

            try {
              const profileRes =
                await communityAgent.api.com.atproto.repo.getRecord({
                  repo: c.did,
                  collection: "community.opensocial.profile",
                  rkey: "self",
                });
              const pv = profileRes.data.value as any;
              description = pv.description || "";
              communityType = pv.type || "open";
              avatarUrl =
                blobToUrl(pv.avatar, c.did, c.pds_host) ||
                (await fetchBlueskyAvatar(c.did));
            } catch {}

            let memberCount = 0;
            try {
              let cursor: string | undefined;
              do {
                const membersRes =
                  await communityAgent.api.com.atproto.repo.listRecords({
                    repo: c.did,
                    collection: "community.opensocial.membershipProof",
                    limit: 100,
                    cursor,
                  });
                memberCount += membersRes.data.records.length;
                cursor = membersRes.data.cursor;
              } while (cursor);
            } catch {}

            // Update cache in database (fire-and-forget)
            db.updateTable("communities")
              .set({
                description,
                avatar_url: avatarUrl || null,
                community_type: communityType,
                member_count: memberCount,
                metadata_fetched_at: new Date(),
              })
              .where("did", "=", c.did)
              .execute()
              .catch((err) =>
                logger.warn(
                  { error: err, communityDid: c.did },
                  "Failed to update community metadata cache",
                ),
              );

            return {
              did: c.did,
              handle: c.handle,
              displayName: c.display_name,
              description,
              avatar: avatarUrl || null,
              type: communityType,
              memberCount,
            };
          } catch (err) {
            // Return what we have from cache
            return {
              did: c.did,
              handle: c.handle,
              displayName: c.display_name,
              description: c.description || "",
              avatar: c.avatar_url || null,
              type: c.community_type || "open",
              memberCount: c.member_count ?? 0,
            };
          }
        }),
      );

      return res.json({ communities: results });
    } catch (err) {
      logger.error({ error: err }, "Community search error");
      return res.status(500).json({ error: "Search failed" });
    }
  });

  // Get community details
  router.get("/communities/:did", async (req: Request, res: Response) => {
    try {
      const agent = await getSessionAgent(req, res, oauthClient);
      res.setHeader("cache-control", "no-store");

      const communityDid = decodeURIComponent(req.params.did);

      // Get community from database
      const community = await db
        .selectFrom("communities")
        .selectAll()
        .where("did", "=", communityDid)
        .executeTakeFirst();

      if (!community) {
        return res.status(404).json({ error: "Community not found" });
      }

      // Try to create community agent — may fail if app password is revoked
      let communityAgent: BskyAgent | null = null;
      let credentialError = false;
      try {
        communityAgent = await createCommunityAgent(db, communityDid);
      } catch (err) {
        const message = err instanceof Error ? err.message : "";
        // Detect auth failures (401, "Invalid identifier or password", etc.)
        if (
          message.includes("Invalid identifier or password") ||
          message.includes("AuthenticationRequired") ||
          message.includes("Authentication Required")
        ) {
          credentialError = true;
          logger.warn(
            { communityDid },
            "Community has invalid credentials — app password may need updating",
          );
        } else {
          // Re-throw non-credential errors
          throw err;
        }
      }

      // When community agent is unavailable (credential error), use the actual PDS
      // for reading public records. The Bluesky AppView (public.api.bsky.app) only
      // supports Bluesky collections, not custom ones like community.opensocial.*.
      let publicRecordAgent: BskyAgent | null = null;
      if (!communityAgent) {
        try {
          const pdsUrl = await resolvePdsEndpoint(
            communityDid,
            community.pds_host,
          );
          publicRecordAgent = new BskyAgent({ service: pdsUrl });
        } catch (err) {
          logger.warn(
            { error: err, communityDid },
            "Failed to create public record agent",
          );
        }
      }
      const recordAgent = communityAgent || publicRecordAgent;

      // Fetch community profile
      let profileValue: CommunityProfile = {
        displayName: community.display_name || community.handle,
        description: "",
        type: (community as any).community_type || "open",
      } as CommunityProfile;
      if (recordAgent) {
        try {
          const profileResponse =
            await recordAgent.api.com.atproto.repo.getRecord({
              repo: communityDid,
              collection: "community.opensocial.profile",
              rkey: "self",
            });
          profileValue = profileResponse.data.value as CommunityProfile;
        } catch {
          // Profile record not yet created — use defaults
        }
      }

      const avatarUrl =
        blobToUrl(profileValue.avatar, communityDid, community.pds_host) ||
        (await fetchBlueskyAvatar(communityDid));

      // Count members (membership proofs)
      let memberCount = 0;
      let proofsRecords: any[] = [];
      if (recordAgent) {
        try {
          const proofsResponse =
            await recordAgent.api.com.atproto.repo.listRecords({
              repo: communityDid,
              collection: "community.opensocial.membershipProof",
            });
          proofsRecords = proofsResponse.data.records;
          memberCount = proofsRecords.length;
        } catch {
          // No membership proofs yet
        }
      }

      // Check if user is admin (readable from public PDS records without auth)
      let adminsValue: { admins: string[] } = { admins: [] };
      if (recordAgent) {
        try {
          const adminsResponse =
            await recordAgent.api.com.atproto.repo.getRecord({
              repo: communityDid,
              collection: "community.opensocial.admins",
              rkey: "self",
            });
          adminsValue = adminsResponse.data.value as { admins: string[] };
        } catch {
          // Admins record not yet created
        }
      }

      // If not authenticated, return public community info only
      if (!agent) {
        return res.json({
          community: {
            did: communityDid,
            displayName: profileValue.displayName,
            description: profileValue.description,
            type: profileValue.type || "open",
            avatar: avatarUrl,
            links: Array.isArray(profileValue.links) ? profileValue.links : [],
          },
          memberCount,
          isAdmin: false,
          isMember: false,
          isPrimaryAdmin: false,
          isAuthenticated: false,
          userRole: undefined,
          // Only expose credential error to non-authenticated users so they see the page
          credentialError: credentialError || undefined,
        });
      }

      const isAdmin = isAdminInList(agent.assertDid, adminsValue.admins);
      const primaryAdminDid = getOriginalAdminDid(adminsValue.admins);

      // Get user's role from their membership record
      const membershipResponse = await agent.api.com.atproto.repo.listRecords({
        repo: agent.assertDid,
        collection: "community.opensocial.membership",
      });

      const userMembership = membershipResponse.data.records.find(
        (record: any) => {
          const value = record.value as MembershipRecord;
          return value.community === communityDid;
        },
      );

      const userRole = userMembership
        ? (userMembership.value as MembershipRecord).role
        : undefined;

      // Check if user is a confirmed member (has membershipProof)
      const isMember =
        isAdmin ||
        proofsRecords.some((proof: any) => {
          if (!userMembership) return false;
          // Match by memberDid (primary) or CID (legacy).
          // The approval flow writes cid: "" so CID-only matching
          // would never confirm approved members.
          return (
            proof.value.memberDid === agent.assertDid ||
            proof.value.cid === userMembership.cid
          );
        });

      // Determine membership status: active, pending, or null.
      // Check both PDS records (userMembership) and the pending_members DB table,
      // since a pending join request may exist in the DB before the PDS record is created
      // (e.g. for admin-approved communities).
      let membershipStatus: "active" | "pending" | null = isMember
        ? "active"
        : userMembership
          ? "pending"
          : null;

      if (!membershipStatus) {
        const pendingRow = await db
          .selectFrom("pending_members" as any)
          .selectAll()
          .where("community_did", "=", communityDid)
          .where("user_did", "=", agent.assertDid)
          .where("status", "=", "pending")
          .executeTakeFirst();
        if (pendingRow) {
          membershipStatus = "pending";
        }
      }

      return res.json({
        community: {
          did: communityDid,
          displayName: profileValue.displayName,
          description: profileValue.description,
          type: profileValue.type || "open",
          avatar: avatarUrl,
          links: Array.isArray(profileValue.links) ? profileValue.links : [],
        },
        memberCount,
        isAdmin,
        isMember,
        isPrimaryAdmin: agent.assertDid === primaryAdminDid,
        isAuthenticated: true,
        userRole,
        membershipStatus,
        // Only expose credential error flag to admins
        credentialError: isAdmin ? credentialError : undefined,
      });
    } catch (err) {
      logger.error(
        { error: err, communityDid: req.params.did },
        "Failed to get community details",
      );
      return res.status(500).json({
        error: "Failed to get community details",
        details: err instanceof Error ? err.message : "Unknown error",
      });
    }
  });

  // Join a community (session-based, for web UI)
  router.post("/communities/:did/join", async (req: Request, res: Response) => {
    try {
      const agent = await getSessionAgent(req, res, oauthClient);
      if (!agent) {
        return res.status(401).json({ error: "Not authenticated" });
      }

      const communityDid = decodeURIComponent(req.params.did);

      // Get community from database
      const community = await db
        .selectFrom("communities")
        .selectAll()
        .where("did", "=", communityDid)
        .executeTakeFirst();

      if (!community) {
        return res.status(404).json({ error: "Community not found" });
      }

      // Create community agent
      const communityAgent = await createCommunityAgent(db, communityDid);

      // Check if already a member
      let cursor: string | undefined;
      let alreadyMember = false;
      do {
        const response = await communityAgent.api.com.atproto.repo.listRecords({
          repo: communityDid,
          collection: "community.opensocial.membershipProof",
          limit: 100,
          cursor,
        });
        alreadyMember = response.data.records.some(
          (r: any) => r.value.memberDid === agent.assertDid,
        );
        cursor = response.data.cursor;
      } while (cursor && !alreadyMember);

      if (alreadyMember) {
        return res.json({
          status: "already_member",
          message: "You are already a member of this community",
        });
      }

      // Check if user already has a pending membership request
      const existingPending = await db
        .selectFrom("pending_members")
        .selectAll()
        .where("community_did", "=", communityDid)
        .where("user_did", "=", agent.assertDid)
        .where("status", "=", "pending")
        .executeTakeFirst();

      if (existingPending) {
        return res.json({
          status: "already_member",
          message:
            "You already have a pending membership request for this community",
        });
      }

      // Check scope
      const grantedScope = getAgentScope(agent);
      if (grantedScope && !hasScope(grantedScope, MEMBERSHIP_WRITE_SCOPE)) {
        return res.status(403).json({
          error: "Insufficient scope",
          details: `Required scope: ${MEMBERSHIP_WRITE_SCOPE}. Please log out and log back in to grant the required permissions.`,
        });
      }

      // Check community type
      let communityType = "open";
      try {
        const profileRes = await communityAgent.api.com.atproto.repo.getRecord({
          repo: communityDid,
          collection: "community.opensocial.profile",
          rkey: "self",
        });
        communityType = (profileRes.data.value as any)?.type || "open";
      } catch {}

      // Create membership record in user's repo
      const membershipRecord = await agent.api.com.atproto.repo.createRecord({
        repo: agent.assertDid,
        collection: "community.opensocial.membership",
        record: {
          $type: "community.opensocial.membership",
          community: communityDid,
          role: "member",
          since: new Date().toISOString(),
        },
      });

      if (communityType === "admin-approved") {
        // Add to pending_members table
        const existing = await db
          .selectFrom("pending_members")
          .selectAll()
          .where("community_did", "=", communityDid)
          .where("user_did", "=", agent.assertDid)
          .where("status", "=", "pending")
          .executeTakeFirst();

        if (!existing) {
          await db
            .insertInto("pending_members")
            .values({
              community_did: communityDid,
              user_did: agent.assertDid,
              status: "pending",
            })
            .execute();
        }

        return res.json({
          status: "pending",
          message:
            "Join request submitted. An admin must approve your request.",
        });
      }

      // Open community — create membershipProof in community's repo
      await communityAgent.api.com.atproto.repo.createRecord({
        repo: communityDid,
        collection: "community.opensocial.membershipProof",
        record: {
          $type: "community.opensocial.membershipProof",
          memberDid: agent.assertDid,
          cid: membershipRecord.data.cid,
          confirmedAt: new Date().toISOString(),
        },
      });

      await auditLog.log({
        communityDid,
        adminDid: agent.assertDid,
        action: "member.joined",
        targetDid: agent.assertDid,
      });

      return res.json({
        status: "joined",
        message: "Successfully joined the community",
      });
    } catch (err) {
      logger.error(
        { error: err, communityDid: req.params.did },
        "Failed to join community",
      );
      return res.status(500).json({
        error: "Failed to join community",
        details: err instanceof Error ? err.message : "Unknown error",
      });
    }
  });

  // Leave a community (called by the user themselves, session-authenticated).
  // - Deletes the membershipProof record from the community's repo
  // - Deletes the user's membership record from their own repo
  // - If the user is an admin, also removes them from the admins record,
  //   refusing if they are currently the only admin in the community.
  router.post(
    "/communities/:did/leave",
    async (req: Request, res: Response) => {
      try {
        const agent = await getSessionAgent(req, res, oauthClient);
        if (!agent) {
          return res.status(401).json({ error: "Not authenticated" });
        }

        const communityDid = decodeURIComponent(req.params.did);

        const community = await db
          .selectFrom("communities")
          .selectAll()
          .where("did", "=", communityDid)
          .executeTakeFirst();

        if (!community) {
          return res.status(404).json({ error: "Community not found" });
        }

        const communityAgent = await createCommunityAgent(db, communityDid);

        // Load admins record so we can check sole-admin status and update it
        // if the leaving user is an admin.
        const adminsResponse =
          await communityAgent.api.com.atproto.repo.getRecord({
            repo: communityDid,
            collection: "community.opensocial.admins",
            rkey: "self",
          });
        const admins = (adminsResponse.data.value as any).admins || [];
        const userIsAdmin = isAdminInList(agent.assertDid, admins);

        if (userIsAdmin) {
          const adminEntries = normalizeAdmins(admins);
          if (adminEntries.length <= 1) {
            return res.status(409).json({
              error: "sole_admin",
              details:
                "You are the only admin of this community. Promote another member to admin first, or delete the community if you no longer want it.",
            });
          }
        }

        // Find membershipProof in community's repo
        let cursor: string | undefined;
        let memberProof: any = null;
        do {
          const response =
            await communityAgent.api.com.atproto.repo.listRecords({
              repo: communityDid,
              collection: "community.opensocial.membershipProof",
              limit: 100,
              cursor,
            });
          memberProof = response.data.records.find(
            (r: any) => r.value.memberDid === agent.assertDid,
          );
          cursor = response.data.cursor;
        } while (cursor && !memberProof);

        // Find membership records in user's own repo for this community
        const userMembershipRecords: { uri: string }[] = [];
        try {
          let userCursor: string | undefined;
          do {
            const response = await agent.api.com.atproto.repo.listRecords({
              repo: agent.assertDid,
              collection: "community.opensocial.membership",
              limit: 100,
              cursor: userCursor,
            });
            for (const r of response.data.records) {
              if ((r.value as any)?.community === communityDid) {
                userMembershipRecords.push({ uri: r.uri });
              }
            }
            userCursor = response.data.cursor;
          } while (userCursor);
        } catch (err) {
          logger.warn(
            { error: err, communityDid, userDid: agent.assertDid },
            "Failed to list user membership records while leaving community",
          );
        }

        if (
          !memberProof &&
          userMembershipRecords.length === 0 &&
          !userIsAdmin
        ) {
          return res
            .status(404)
            .json({ error: "You are not a member of this community." });
        }

        // Delete the membershipProof first (best-effort — failure to delete the
        // proof should not block deleting the user's own record).
        if (memberProof) {
          try {
            const rkey = memberProof.uri.split("/").pop()!;
            await communityAgent.api.com.atproto.repo.deleteRecord({
              repo: communityDid,
              collection: "community.opensocial.membershipProof",
              rkey,
            });
          } catch (err) {
            logger.error(
              { error: err, communityDid, userDid: agent.assertDid },
              "Failed to delete membershipProof while leaving",
            );
          }
        }

        // If the user was an admin, remove them from the admins list.
        if (userIsAdmin) {
          const updatedAdmins = normalizeAdmins(admins).filter(
            (a) => a.did !== agent.assertDid,
          );
          await communityAgent.api.com.atproto.repo.putRecord({
            repo: communityDid,
            collection: "community.opensocial.admins",
            rkey: "self",
            record: {
              $type: "community.opensocial.admins",
              admins: updatedAdmins,
            },
          });
        }

        // Delete the user's membership record(s) for this community.
        for (const record of userMembershipRecords) {
          try {
            const parts = record.uri.split("/");
            const rkey = parts[parts.length - 1];
            await agent.api.com.atproto.repo.deleteRecord({
              repo: agent.assertDid,
              collection: "community.opensocial.membership",
              rkey,
            });
          } catch (err) {
            logger.warn(
              { error: err, uri: record.uri, userDid: agent.assertDid },
              "Failed to delete user membership record while leaving",
            );
          }
        }

        // Also clear any pending join request so they can re-request later.
        try {
          await db
            .deleteFrom("pending_members")
            .where("community_did", "=", communityDid)
            .where("user_did", "=", agent.assertDid)
            .execute();
        } catch {
          // non-fatal
        }

        await auditLog.log({
          communityDid,
          adminDid: agent.assertDid,
          action: "member.left",
          targetDid: agent.assertDid,
        });

        return res.json({
          status: "left",
          message: "You have left the community.",
        });
      } catch (err) {
        logger.error(
          { error: err, communityDid: req.params.did },
          "Failed to leave community",
        );
        return res.status(500).json({
          error: "Failed to leave community",
          details: err instanceof Error ? err.message : "Unknown error",
        });
      }
    },
  );

  // Upload community avatar
  router.post(
    "/communities/:did/avatar",
    upload.single("avatar"),
    async (req: Request, res: Response) => {
      try {
        const agent = await getSessionAgent(req, res, oauthClient);
        if (!agent) {
          return res.status(401).json({ error: "Not authenticated" });
        }

        const communityDid = decodeURIComponent(req.params.did);

        // Get community from database
        const community = await db
          .selectFrom("communities")
          .selectAll()
          .where("did", "=", communityDid)
          .executeTakeFirst();

        if (!community) {
          return res.status(404).json({ error: "Community not found" });
        }

        // Check if user is admin
        const communityAgent = await createCommunityAgent(db, communityDid);

        const adminsResponse =
          await communityAgent.api.com.atproto.repo.getRecord({
            repo: communityDid,
            collection: "community.opensocial.admins",
            rkey: "self",
          });

        const adminsValue = adminsResponse.data.value as { admins: string[] };
        if (!isAdminInList(agent.assertDid, adminsValue.admins)) {
          return res
            .status(403)
            .json({ error: "Not authorized. Must be an admin." });
        }

        // Get uploaded file from multipart form data
        const file = req.file;
        if (!file) {
          return res.status(400).json({ error: "No file uploaded" });
        }

        // Upload blob to community's PDS
        const uploadResponse =
          await communityAgent.api.com.atproto.repo.uploadBlob(file.buffer, {
            encoding: file.mimetype,
          });

        const blobRef = uploadResponse.data.blob;

        // Update community profile with new avatar
        const profileResponse =
          await communityAgent.api.com.atproto.repo.getRecord({
            repo: communityDid,
            collection: "community.opensocial.profile",
            rkey: "self",
          });

        const currentProfile = profileResponse.data.value as CommunityProfile;

        await communityAgent.api.com.atproto.repo.putRecord({
          repo: communityDid,
          collection: "community.opensocial.profile",
          rkey: "self",
          record: {
            ...currentProfile,
            $type: "community.opensocial.profile",
            avatar: blobRef,
          },
        });

        return res.json({ success: true, avatar: blobRef });
      } catch (err) {
        logger.error(
          { error: err, communityDid: req.params.did },
          "Failed to upload avatar",
        );
        return res.status(500).json({
          error: "Failed to upload avatar",
          details: err instanceof Error ? err.message : "Unknown error",
        });
      }
    },
  );

  // Upload community banner (or reuse Bluesky banner)
  router.post(
    "/communities/:did/banner",
    upload.single("banner"),
    async (req: Request, res: Response) => {
      try {
        const agent = await getSessionAgent(req, res, oauthClient);
        if (!agent) {
          return res.status(401).json({ error: "Not authenticated" });
        }

        const communityDid = decodeURIComponent(req.params.did);

        const community = await db
          .selectFrom("communities")
          .selectAll()
          .where("did", "=", communityDid)
          .executeTakeFirst();

        if (!community) {
          return res.status(404).json({ error: "Community not found" });
        }

        const communityAgent = await createCommunityAgent(db, communityDid);

        // Check if user is admin
        const adminsResponse =
          await communityAgent.api.com.atproto.repo.getRecord({
            repo: communityDid,
            collection: "community.opensocial.admins",
            rkey: "self",
          });

        const adminsValue = adminsResponse.data.value as { admins: string[] };
        if (
          !isAdminInList(agent.assertDid, adminsValue.admins || adminsValue)
        ) {
          return res
            .status(403)
            .json({ error: "Not authorized. Must be an admin." });
        }

        let blobRef: any;

        if (
          req.body.reuseBluesky === "true" ||
          req.body.reuseBluesky === true
        ) {
          // Reuse the creator's Bluesky banner
          const creatorDid = agent.assertDid;
          try {
            const bskyProfile = await agent.getProfile({ actor: creatorDid });
            if (!bskyProfile.data.banner) {
              return res
                .status(404)
                .json({ error: "No Bluesky banner found on your profile" });
            }
            // Fetch the banner blob and re-upload to community PDS
            const bannerUrl = bskyProfile.data.banner;
            const bannerRes = await fetch(bannerUrl);
            if (!bannerRes.ok) {
              return res
                .status(500)
                .json({ error: "Failed to fetch Bluesky banner" });
            }
            const bannerData = new Uint8Array(await bannerRes.arrayBuffer());
            const contentType =
              bannerRes.headers.get("content-type") || "image/jpeg";
            const uploadResponse =
              await communityAgent.api.com.atproto.repo.uploadBlob(bannerData, {
                encoding: contentType,
              });
            blobRef = uploadResponse.data.blob;
          } catch (e) {
            logger.error(
              { error: e, communityDid: req.params.did },
              "Failed to reuse Bluesky banner",
            );
            return res
              .status(500)
              .json({ error: "Failed to reuse Bluesky banner" });
          }
        } else {
          // Use uploaded file
          const file = req.file;
          if (!file) {
            return res.status(400).json({
              error:
                "No file uploaded. Send a banner file or set reuseBluesky=true",
            });
          }

          const uploadResponse =
            await communityAgent.api.com.atproto.repo.uploadBlob(file.buffer, {
              encoding: file.mimetype,
            });
          blobRef = uploadResponse.data.blob;
        }

        // Update community profile with new banner
        const profileResponse =
          await communityAgent.api.com.atproto.repo.getRecord({
            repo: communityDid,
            collection: "community.opensocial.profile",
            rkey: "self",
          });

        const currentProfile = profileResponse.data.value as CommunityProfile;

        await communityAgent.api.com.atproto.repo.putRecord({
          repo: communityDid,
          collection: "community.opensocial.profile",
          rkey: "self",
          record: {
            ...currentProfile,
            $type: "community.opensocial.profile",
            banner: blobRef,
          },
        });

        return res.json({ success: true, banner: blobRef });
      } catch (err) {
        logger.error(
          { error: err, communityDid: req.params.did },
          "Failed to upload banner",
        );
        return res.status(500).json({
          error: "Failed to upload banner",
          details: err instanceof Error ? err.message : "Unknown error",
        });
      }
    },
  );

  // Update community profile (name and description)
  router.put(
    "/communities/:did/profile",
    async (req: Request, res: Response) => {
      try {
        const agent = await getSessionAgent(req, res, oauthClient);
        if (!agent) {
          return res.status(401).json({ error: "Not authenticated" });
        }

        const communityDid = decodeURIComponent(req.params.did);
        const { displayName, description, type } = req.body;

        // Validate input
        if (
          !displayName ||
          typeof displayName !== "string" ||
          !displayName.trim()
        ) {
          return res.status(400).json({ error: "displayName is required" });
        }

        // Validate type if provided
        if (type && !["open", "admin-approved", "private"].includes(type)) {
          return res.status(400).json({
            error: 'type must be "open", "admin-approved", or "private"',
          });
        }

        // Get community from database
        const community = await db
          .selectFrom("communities")
          .selectAll()
          .where("did", "=", communityDid)
          .executeTakeFirst();

        if (!community) {
          return res.status(404).json({ error: "Community not found" });
        }

        // Create community agent
        const communityAgent = await createCommunityAgent(db, communityDid);

        // Check if user is admin
        const adminsResponse =
          await communityAgent.api.com.atproto.repo.getRecord({
            repo: communityDid,
            collection: "community.opensocial.admins",
            rkey: "self",
          });

        const adminsValue = adminsResponse.data.value as { admins: string[] };
        if (!isAdminInList(agent.assertDid, adminsValue.admins)) {
          return res
            .status(403)
            .json({ error: "Not authorized. Must be an admin." });
        }

        // Get current profile
        const profileResponse =
          await communityAgent.api.com.atproto.repo.getRecord({
            repo: communityDid,
            collection: "community.opensocial.profile",
            rkey: "self",
          });

        const currentProfile = profileResponse.data.value as CommunityProfile;

        // Sanitize user input to prevent XSS
        const sanitizedDescription = description
          ? sanitizeUserContent(description.trim())
          : "";

        // Update profile with new values
        await communityAgent.api.com.atproto.repo.putRecord({
          repo: communityDid,
          collection: "community.opensocial.profile",
          rkey: "self",
          record: {
            ...currentProfile,
            $type: "community.opensocial.profile",
            displayName: displayName.trim(),
            description: sanitizedDescription,
            type: type || currentProfile.type || "open",
          },
        });

        return res.json({ success: true });
      } catch (err) {
        logger.error(
          { error: err, communityDid: req.params.did },
          "Failed to update community profile",
        );
        return res.status(500).json({
          error: "Failed to update community profile",
          details: err instanceof Error ? err.message : "Unknown error",
        });
      }
    },
  );

  // Update community links — admin only. Replaces the whole links array.
  router.put("/communities/:did/links", async (req: Request, res: Response) => {
    try {
      const agent = await getSessionAgent(req, res, oauthClient);
      if (!agent) {
        return res.status(401).json({ error: "Not authenticated" });
      }

      const communityDid = decodeURIComponent(req.params.did);
      const { links } = req.body as { links?: unknown };

      if (!Array.isArray(links)) {
        return res.status(400).json({ error: "links must be an array" });
      }
      if (links.length > 16) {
        return res
          .status(400)
          .json({ error: "A community can have at most 16 links" });
      }

      // Validate & normalize each link entry. Reject non-http(s) URLs to
      // prevent javascript: / data: URIs from being rendered as links.
      const normalized: CommunityLink[] = [];
      for (const raw of links) {
        if (!raw || typeof raw !== "object") {
          return res
            .status(400)
            .json({ error: "Each link must be an object with name and url" });
        }
        const entry = raw as Record<string, unknown>;
        const name = typeof entry.name === "string" ? entry.name.trim() : "";
        const url = typeof entry.url === "string" ? entry.url.trim() : "";
        if (!name) {
          return res
            .status(400)
            .json({ error: "Each link must have a non-empty name" });
        }
        if (name.length > 64) {
          return res
            .status(400)
            .json({ error: "Link names must be 64 characters or fewer" });
        }
        if (!url) {
          return res
            .status(400)
            .json({ error: "Each link must have a non-empty url" });
        }
        if (url.length > 1024) {
          return res
            .status(400)
            .json({ error: "Link URLs must be 1024 characters or fewer" });
        }
        let parsed: URL;
        try {
          parsed = new URL(url);
        } catch {
          return res.status(400).json({ error: `Invalid URL: ${url}` });
        }
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
          return res
            .status(400)
            .json({ error: "Link URLs must use http or https" });
        }
        normalized.push({ name, url });
      }

      const community = await db
        .selectFrom("communities")
        .selectAll()
        .where("did", "=", communityDid)
        .executeTakeFirst();
      if (!community) {
        return res.status(404).json({ error: "Community not found" });
      }

      const communityAgent = await createCommunityAgent(db, communityDid);

      // Admin check
      const adminsResponse =
        await communityAgent.api.com.atproto.repo.getRecord({
          repo: communityDid,
          collection: "community.opensocial.admins",
          rkey: "self",
        });
      const adminsValue = adminsResponse.data.value as { admins: string[] };
      if (!isAdminInList(agent.assertDid, adminsValue.admins)) {
        return res
          .status(403)
          .json({ error: "Not authorized. Must be an admin." });
      }

      // Load current profile so we preserve all other fields.
      const profileResponse =
        await communityAgent.api.com.atproto.repo.getRecord({
          repo: communityDid,
          collection: "community.opensocial.profile",
          rkey: "self",
        });
      const currentProfile = profileResponse.data.value as CommunityProfile;

      await communityAgent.api.com.atproto.repo.putRecord({
        repo: communityDid,
        collection: "community.opensocial.profile",
        rkey: "self",
        record: {
          ...currentProfile,
          $type: "community.opensocial.profile",
          links: normalized,
        },
      });

      return res.json({ success: true, links: normalized });
    } catch (err) {
      logger.error(
        { error: err, communityDid: req.params.did },
        "Failed to update community links",
      );
      return res.status(500).json({
        error: "Failed to update community links",
        details: err instanceof Error ? err.message : "Unknown error",
      });
    }
  });

  // Update community app password (for when the old one is revoked)
  router.put(
    "/communities/:did/app-password",
    authRateLimiter,
    async (req: Request, res: Response) => {
      try {
        const agent = await getSessionAgent(req, res, oauthClient);
        if (!agent) {
          return res.status(401).json({ error: "Not authenticated" });
        }

        const communityDid = decodeURIComponent(req.params.did);
        const { appPassword } = req.body;

        if (
          !appPassword ||
          typeof appPassword !== "string" ||
          !appPassword.trim()
        ) {
          return res.status(400).json({ error: "appPassword is required" });
        }

        // Check community exists
        const community = await db
          .selectFrom("communities")
          .selectAll()
          .where("did", "=", communityDid)
          .executeTakeFirst();

        if (!community) {
          return res.status(404).json({ error: "Community not found" });
        }

        // Verify the caller is an admin via public PDS API (since the community agent may not work).
        // We use the actual PDS, not the Bluesky AppView, because custom collections
        // like community.opensocial.admins are only served by the PDS.
        try {
          const pdsUrl = await resolvePdsEndpoint(
            communityDid,
            community.pds_host,
          );
          const pdsAgent = new BskyAgent({ service: pdsUrl });
          const adminsResponse = await pdsAgent.api.com.atproto.repo.getRecord({
            repo: communityDid,
            collection: "community.opensocial.admins",
            rkey: "self",
          });
          const adminsValue = adminsResponse.data.value as { admins: string[] };
          if (!isAdminInList(agent.assertDid, adminsValue.admins)) {
            return res
              .status(403)
              .json({ error: "Not authorized. Must be an admin." });
          }
        } catch (err) {
          logger.error(
            { error: err, communityDid },
            "Failed to verify admin status",
          );
          return res
            .status(403)
            .json({ error: "Could not verify admin status" });
        }

        // Verify the new app password works by attempting login. Target the
        // OAuth auth server (entryway) so verification works in both
        // single-PDS and entryway architectures.
        const pdsUrl = await resolvePdsEndpoint(
          communityDid,
          community.pds_host,
        );
        const authServerUrl = await resolveAuthServer(communityDid, pdsUrl);
        const testAgent = new BskyAgent({ service: authServerUrl });
        try {
          await testAgent.login({
            identifier: communityDid,
            password: appPassword.trim(),
          });
        } catch (err) {
          logger.warn(
            { error: err, communityDid },
            "New app password verification failed",
          );
          return res.status(400).json({
            error:
              "Invalid app password. Please make sure you created a new app password in Bluesky settings and copied it correctly.",
          });
        }

        // Password verified — update the database
        await db
          .updateTable("communities")
          .set({
            app_password: encrypt(appPassword.trim()),
            pds_host: pdsUrl, // Also update PDS host in case it changed
          })
          .where("did", "=", communityDid)
          .execute();

        // Evict the old cached agent so the next request uses the new password
        invalidateCommunityAgent(communityDid);

        logger.info(
          { communityDid, updatedBy: agent.assertDid },
          "Community app password updated",
        );

        return res.json({ success: true });
      } catch (err) {
        logger.error(
          { error: err, communityDid: req.params.did },
          "Failed to update app password",
        );
        return res.status(500).json({
          error: "Failed to update app password",
          details: err instanceof Error ? err.message : "Unknown error",
        });
      }
    },
  );

  // Delete a community
  router.delete("/communities/:did", async (req: Request, res: Response) => {
    try {
      const agent = await getSessionAgent(req, res, oauthClient);

      if (!agent) {
        return res.status(401).json({ error: "Not authenticated" });
      }

      const { did } = req.params;
      const userDid = agent.assertDid;

      // Get community credentials from database
      const community = await db
        .selectFrom("communities")
        .selectAll()
        .where("did", "=", did)
        .executeTakeFirst();

      if (!community) {
        return res.status(404).json({ error: "Community not found" });
      }

      // Create agent for the community
      const communityAgent = await createCommunityAgent(db, did);

      // Fetch admins to verify permissions
      const adminRecord = await communityAgent.api.com.atproto.repo.getRecord({
        repo: did,
        collection: "community.opensocial.admins",
        rkey: "self",
      });

      const admins = (adminRecord.data.value as any).admins || [];

      // Check if user is an admin
      const isAdmin = admins.some((admin: any) => admin.did === userDid);
      if (!isAdmin) {
        return res.status(403).json({
          error: "Only admins can delete a community",
        });
      }

      // Check if there's only one admin
      if (admins.length > 1) {
        return res.status(403).json({
          error: "Community can only be deleted when there is a single admin",
        });
      }

      // Delete from database
      await db.deleteFrom("communities").where("did", "=", did).execute();

      return res.json({
        success: true,
        message: "Community deleted successfully",
      });
    } catch (err) {
      logger.error(
        { error: err, communityDid: req.params.did },
        "Failed to delete community",
      );
      return res.status(500).json({
        error: "Failed to delete community",
        details: err instanceof Error ? err.message : "Unknown error",
      });
    }
  });

  // ── Admin member management routes ─────────────────────────────────────

  // List all group members. Visible to any authenticated member of the
  // community; admins additionally receive `callerIsAdmin: true` so the
  // frontend can show admin actions.
  router.get(
    "/communities/:did/members",
    async (req: Request, res: Response) => {
      try {
        const agent = await getSessionAgent(req, res, oauthClient);
        if (!agent) {
          return res.status(401).json({ error: "Not authenticated" });
        }

        const communityDid = decodeURIComponent(req.params.did);
        const search = req.query.search as string | undefined;

        // Get community from database
        const community = await db
          .selectFrom("communities")
          .selectAll()
          .where("did", "=", communityDid)
          .executeTakeFirst();

        if (!community) {
          return res.status(404).json({ error: "Community not found" });
        }

        // Create community agent
        const communityAgent = await createCommunityAgent(db, communityDid);

        // Load admin record (used both to check admin status and to compute
        // per-member isAdmin flags below).
        const adminsResponse =
          await communityAgent.api.com.atproto.repo.getRecord({
            repo: communityDid,
            collection: "community.opensocial.admins",
            rkey: "self",
          });

        const admins = (adminsResponse.data.value as any).admins || [];
        const callerIsAdmin = isAdminInList(agent.assertDid, admins);

        // List all membershipProof records (paginated)
        let cursor: string | undefined;
        const allProofs: any[] = [];
        do {
          const response =
            await communityAgent.api.com.atproto.repo.listRecords({
              repo: communityDid,
              collection: "community.opensocial.membershipProof",
              limit: 100,
              cursor,
            });
          allProofs.push(...response.data.records);
          cursor = response.data.cursor;
        } while (cursor);

        // Authorization: the caller must be either an admin or a confirmed
        // member of this community. Non-members can still see basic community
        // info via the community details endpoint but cannot enumerate members.
        const callerIsMember =
          callerIsAdmin ||
          allProofs.some((p: any) => p.value.memberDid === agent.assertDid);
        if (!callerIsMember) {
          return res.status(403).json({
            error:
              "Not authorized. You must be a member of this community to view its members.",
          });
        }

        // Build member list
        let members = allProofs.map((record: any) => {
          const memberDid = record.value.memberDid || null;
          return {
            uri: record.uri,
            did: memberDid,
            cid: record.value.cid,
            confirmedAt: record.value.confirmedAt || null,
            isAdmin: memberDid ? isAdminInList(memberDid, admins) : false,
          };
        });

        // Backfill: admins whose DID is in the admins record but missing from
        // proof memberDid (legacy proofs created without memberDid). Match by
        // checking if a proof's CID corresponds to this admin's membership record.
        const proofDids = new Set(members.map((m) => m.did).filter(Boolean));
        const missingAdmins = admins.filter((a: any) => {
          const did = typeof a === "string" ? a : a.did;
          return did && !proofDids.has(did);
        });

        for (const admin of missingAdmins) {
          const adminDid = typeof admin === "string" ? admin : admin.did;
          // Find a proof record that lacks memberDid — likely belongs to this admin
          const orphanProof = allProofs.find((p: any) => !p.value.memberDid);
          if (orphanProof) {
            // Patch the existing entry in members
            const idx = members.findIndex((m) => m.uri === orphanProof.uri);
            if (idx !== -1) {
              members[idx] = { ...members[idx], did: adminDid, isAdmin: true };
            }
          } else {
            // Admin has no proof at all — still include them so they appear
            members.push({
              uri: "",
              did: adminDid,
              cid: "",
              confirmedAt: null,
              isAdmin: true,
            });
          }
        }

        // Resolve Bluesky profiles (handle + avatar) for each member
        const enriched = await Promise.all(
          members.map(async (member) => {
            if (!member.did)
              return {
                ...member,
                handle: null,
                displayName: null,
                avatar: null,
              };
            const profile = await resolveBlueskyProfile(member.did);
            return { ...member, ...profile };
          }),
        );

        // Filter by search term against DID, handle, or display name
        let results = enriched;
        if (search) {
          const lowerSearch = search.toLowerCase();
          results = enriched.filter(
            (m) =>
              (m.did && m.did.toLowerCase().includes(lowerSearch)) ||
              (m.handle && m.handle.toLowerCase().includes(lowerSearch)) ||
              (m.displayName &&
                m.displayName.toLowerCase().includes(lowerSearch)),
          );
        }

        // Fetch custom role assignments for all members
        const memberDids = results
          .map((m) => m.did)
          .filter(Boolean) as string[];
        let roleAssignments: { member_did: string; role_name: string }[] = [];
        if (memberDids.length > 0) {
          roleAssignments = await db
            .selectFrom("community_member_roles")
            .select(["member_did", "role_name"])
            .where("community_did", "=", communityDid)
            .where("member_did", "in", memberDids)
            .execute();
        }

        // Fetch role display names
        const roleNames = [...new Set(roleAssignments.map((r) => r.role_name))];
        let roleDisplayNames: Record<string, string> = {};
        if (roleNames.length > 0) {
          const roles = await db
            .selectFrom("community_roles")
            .select(["name", "display_name"])
            .where("community_did", "=", communityDid)
            .where("name", "in", roleNames)
            .execute();
          roleDisplayNames = Object.fromEntries(
            roles.map((r) => [r.name, r.display_name]),
          );
        }

        // Build per-member role arrays
        const rolesByMember = new Map<
          string,
          { name: string; displayName: string }[]
        >();
        for (const ra of roleAssignments) {
          if (!rolesByMember.has(ra.member_did))
            rolesByMember.set(ra.member_did, []);
          rolesByMember.get(ra.member_did)!.push({
            name: ra.role_name,
            displayName: roleDisplayNames[ra.role_name] || ra.role_name,
          });
        }

        const primaryAdminDid = getOriginalAdminDid(admins);

        const resultsWithRoles = results.map((m) => ({
          ...m,
          roles: m.did ? rolesByMember.get(m.did) || [] : [],
          isPrimaryAdmin: m.did === primaryAdminDid,
        }));

        return res.json({
          members: resultsWithRoles,
          total: resultsWithRoles.length,
          primaryAdminDid,
          callerIsAdmin,
        });
      } catch (err) {
        logger.error(
          { error: err, communityDid: req.params.did },
          "Failed to list members",
        );
        return res.status(500).json({
          error: "Failed to list members",
          details: err instanceof Error ? err.message : "Unknown error",
        });
      }
    },
  );

  // Promote a member to admin
  router.post(
    "/communities/:did/members/:memberDid/admin",
    async (req: Request, res: Response) => {
      try {
        const agent = await getSessionAgent(req, res, oauthClient);
        if (!agent) {
          return res.status(401).json({ error: "Not authenticated" });
        }

        const communityDid = decodeURIComponent(req.params.did);
        const memberDid = decodeURIComponent(req.params.memberDid);

        const community = await db
          .selectFrom("communities")
          .selectAll()
          .where("did", "=", communityDid)
          .executeTakeFirst();

        if (!community) {
          return res.status(404).json({ error: "Community not found" });
        }

        const communityAgent = await createCommunityAgent(db, communityDid);

        // Verify caller is an admin
        const adminsResponse =
          await communityAgent.api.com.atproto.repo.getRecord({
            repo: communityDid,
            collection: "community.opensocial.admins",
            rkey: "self",
          });

        const admins = (adminsResponse.data.value as any).admins || [];
        if (!isAdminInList(agent.assertDid, admins)) {
          return res
            .status(403)
            .json({ error: "Not authorized. Must be an admin." });
        }

        // Check if already an admin
        if (isAdminInList(memberDid, admins)) {
          return res.status(409).json({ error: "Member is already an admin." });
        }

        // Verify the member has a membershipProof in this community
        let cursor: string | undefined;
        let found = false;
        do {
          const response =
            await communityAgent.api.com.atproto.repo.listRecords({
              repo: communityDid,
              collection: "community.opensocial.membershipProof",
              limit: 100,
              cursor,
            });
          found = response.data.records.some(
            (r: any) => r.value.memberDid === memberDid,
          );
          cursor = response.data.cursor;
        } while (cursor && !found);

        if (!found) {
          return res
            .status(404)
            .json({ error: "Member not found in this community." });
        }

        // Add member to admin list (normalize to canonical format)
        const updatedAdmins = normalizeAdmins(admins);
        updatedAdmins.push({
          did: memberDid,
          addedAt: new Date().toISOString(),
        });

        await communityAgent.api.com.atproto.repo.putRecord({
          repo: communityDid,
          collection: "community.opensocial.admins",
          rkey: "self",
          record: {
            $type: "community.opensocial.admins",
            admins: updatedAdmins,
          },
        });

        await auditLog.log({
          communityDid,
          adminDid: agent.assertDid,
          action: "admin.promoted",
          targetDid: memberDid,
        });

        return res.json({ success: true, admins: updatedAdmins });
      } catch (err) {
        logger.error(
          {
            error: err,
            communityDid: req.params.did,
            memberDid: req.params.memberDid,
          },
          "Failed to promote member to admin",
        );
        return res.status(500).json({
          error: "Failed to promote member to admin",
          details: err instanceof Error ? err.message : "Unknown error",
        });
      }
    },
  );

  // Demote an admin (cannot demote the original group creator)
  router.delete(
    "/communities/:did/members/:memberDid/admin",
    async (req: Request, res: Response) => {
      try {
        const agent = await getSessionAgent(req, res, oauthClient);
        if (!agent) {
          return res.status(401).json({ error: "Not authenticated" });
        }

        const communityDid = decodeURIComponent(req.params.did);
        const memberDid = decodeURIComponent(req.params.memberDid);

        const community = await db
          .selectFrom("communities")
          .selectAll()
          .where("did", "=", communityDid)
          .executeTakeFirst();

        if (!community) {
          return res.status(404).json({ error: "Community not found" });
        }

        const communityAgent = await createCommunityAgent(db, communityDid);

        // Verify caller is an admin
        const adminsResponse =
          await communityAgent.api.com.atproto.repo.getRecord({
            repo: communityDid,
            collection: "community.opensocial.admins",
            rkey: "self",
          });

        const admins = (adminsResponse.data.value as any).admins || [];
        if (!isAdminInList(agent.assertDid, admins)) {
          return res
            .status(403)
            .json({ error: "Not authorized. Must be an admin." });
        }

        // Protect the original group creator
        const originalAdminDid = getOriginalAdminDid(admins);
        if (memberDid === originalAdminDid) {
          return res.status(403).json({
            error: "Cannot demote the original group creator.",
          });
        }

        // Verify the target is actually an admin
        if (!isAdminInList(memberDid, admins)) {
          return res.status(404).json({ error: "Member is not an admin." });
        }

        // Remove from admin list
        const updatedAdmins = normalizeAdmins(admins).filter(
          (a) => a.did !== memberDid,
        );

        await communityAgent.api.com.atproto.repo.putRecord({
          repo: communityDid,
          collection: "community.opensocial.admins",
          rkey: "self",
          record: {
            $type: "community.opensocial.admins",
            admins: updatedAdmins,
          },
        });

        await auditLog.log({
          communityDid,
          adminDid: agent.assertDid,
          action: "admin.demoted",
          targetDid: memberDid,
        });

        return res.json({ success: true, admins: updatedAdmins });
      } catch (err) {
        logger.error(
          {
            error: err,
            communityDid: req.params.did,
            memberDid: req.params.memberDid,
          },
          "Failed to demote admin",
        );
        return res.status(500).json({
          error: "Failed to demote admin",
          details: err instanceof Error ? err.message : "Unknown error",
        });
      }
    },
  );

  // Remove a member from the group by deleting their membershipProof
  router.delete(
    "/communities/:did/members/:memberDid",
    async (req: Request, res: Response) => {
      try {
        const agent = await getSessionAgent(req, res, oauthClient);
        if (!agent) {
          return res.status(401).json({ error: "Not authenticated" });
        }

        const communityDid = decodeURIComponent(req.params.did);
        const memberDid = decodeURIComponent(req.params.memberDid);

        const community = await db
          .selectFrom("communities")
          .selectAll()
          .where("did", "=", communityDid)
          .executeTakeFirst();

        if (!community) {
          return res.status(404).json({ error: "Community not found" });
        }

        const communityAgent = await createCommunityAgent(db, communityDid);

        // Verify caller is an admin
        const adminsResponse =
          await communityAgent.api.com.atproto.repo.getRecord({
            repo: communityDid,
            collection: "community.opensocial.admins",
            rkey: "self",
          });

        const admins = (adminsResponse.data.value as any).admins || [];
        if (!isAdminInList(agent.assertDid, admins)) {
          return res
            .status(403)
            .json({ error: "Not authorized. Must be an admin." });
        }

        // Prevent removing the original group creator
        const originalAdminDid = getOriginalAdminDid(admins);
        if (memberDid === originalAdminDid) {
          return res.status(403).json({
            error: "Cannot remove the original group creator.",
          });
        }

        // Find the membershipProof record for this member
        let cursor: string | undefined;
        let memberProof: any = null;
        do {
          const response =
            await communityAgent.api.com.atproto.repo.listRecords({
              repo: communityDid,
              collection: "community.opensocial.membershipProof",
              limit: 100,
              cursor,
            });
          memberProof = response.data.records.find(
            (r: any) => r.value.memberDid === memberDid,
          );
          cursor = response.data.cursor;
        } while (cursor && !memberProof);

        if (!memberProof) {
          return res
            .status(404)
            .json({ error: "Member not found in this community." });
        }

        // Delete the membershipProof record
        const rkey = memberProof.uri.split("/").pop()!;
        await communityAgent.api.com.atproto.repo.deleteRecord({
          repo: communityDid,
          collection: "community.opensocial.membershipProof",
          rkey,
        });

        // If the removed member was also an admin, remove them from the admin list
        if (isAdminInList(memberDid, admins)) {
          const updatedAdmins = normalizeAdmins(admins).filter(
            (a) => a.did !== memberDid,
          );
          await communityAgent.api.com.atproto.repo.putRecord({
            repo: communityDid,
            collection: "community.opensocial.admins",
            rkey: "self",
            record: {
              $type: "community.opensocial.admins",
              admins: updatedAdmins,
            },
          });
        }

        await auditLog.log({
          communityDid,
          adminDid: agent.assertDid,
          action: "member.removed",
          targetDid: memberDid,
        });

        return res.json({
          success: true,
          message: `Member ${memberDid} removed from community. Their membership record remains in their PDS but is no longer verified.`,
        });
      } catch (err) {
        logger.error(
          {
            error: err,
            communityDid: req.params.did,
            memberDid: req.params.memberDid,
          },
          "Failed to remove member",
        );
        return res.status(500).json({
          error: "Failed to remove member",
          details: err instanceof Error ? err.message : "Unknown error",
        });
      }
    },
  );

  // Transfer primary admin to another admin
  router.post(
    "/communities/:did/transfer-admin",
    async (req: Request, res: Response) => {
      try {
        const agent = await getSessionAgent(req, res, oauthClient);
        if (!agent) return res.status(401).json({ error: "Not authenticated" });

        const communityDid = decodeURIComponent(req.params.did);
        const { newOwnerDid } = req.body;
        if (!newOwnerDid)
          return res.status(400).json({ error: "newOwnerDid is required" });

        const communityAgent = await createCommunityAgent(db, communityDid);

        const adminsResponse =
          await communityAgent.api.com.atproto.repo.getRecord({
            repo: communityDid,
            collection: "community.opensocial.admins",
            rkey: "self",
          });
        const admins = (adminsResponse.data.value as any).admins || [];

        // Verify caller is the primary admin
        const originalAdmin = getOriginalAdminDid(admins);
        if (agent.assertDid !== originalAdmin) {
          return res
            .status(403)
            .json({ error: "Only the primary admin can transfer ownership" });
        }

        // Verify new owner is already an admin
        if (!isAdminInList(newOwnerDid, admins)) {
          return res.status(400).json({
            error: "New owner must already be an admin. Promote them first.",
          });
        }

        // Reorder: new owner goes first (becomes primary)
        const normalized = normalizeAdmins(admins);
        const newOwnerEntry = normalized.find((a) => a.did === newOwnerDid)!;
        const rest = normalized.filter((a) => a.did !== newOwnerDid);
        const updatedAdmins = [newOwnerEntry, ...rest];

        await communityAgent.api.com.atproto.repo.putRecord({
          repo: communityDid,
          collection: "community.opensocial.admins",
          rkey: "self",
          record: {
            $type: "community.opensocial.admins",
            admins: updatedAdmins,
          },
        });

        await auditLog.log({
          communityDid,
          adminDid: agent.assertDid,
          action: "admin.transferred",
          targetDid: newOwnerDid,
        });

        return res.json({
          success: true,
          message: `Primary admin transferred to ${newOwnerDid}`,
          admins: updatedAdmins,
        });
      } catch (err) {
        logger.error(
          {
            error: err,
            communityDid: req.params.did,
            newOwnerDid: req.body.newOwnerDid,
          },
          "Failed to transfer admin",
        );
        return res.status(500).json({ error: "Failed to transfer admin role" });
      }
    },
  );

  // ═══════════════════════════════════════════════════════════════════
  // SESSION-AUTHENTICATED PERMISSION / SETTINGS / ROLES ROUTES
  // ═══════════════════════════════════════════════════════════════════

  const auditLog = createAuditLogService(db);

  /** Helper: verify the session user is a community admin. Returns DID or null. */
  async function requireSessionAdmin(
    req: Request,
    res: Response,
    communityDid: string,
  ): Promise<string | null> {
    const agent = await getSessionAgent(req, res, oauthClient);
    if (!agent) {
      res.status(401).json({ error: "Not authenticated" });
      return null;
    }
    const isAdm = await checkAdmin(
      await createCommunityAgent(db, communityDid),
      communityDid,
      agent.assertDid,
    );
    if (!isAdm) {
      res.status(403).json({ error: "Not authorized. Must be an admin." });
      return null;
    }
    return agent.assertDid;
  }

  // ─── Community settings ────────────────────────────────────────────

  router.get(
    "/communities/:did/settings",
    async (req: Request, res: Response) => {
      try {
        const agent = await getSessionAgent(req, res, oauthClient);
        if (!agent) return res.status(401).json({ error: "Not authenticated" });

        const communityDid = decodeURIComponent(req.params.did);
        const settings = await db
          .selectFrom("community_settings")
          .selectAll()
          .where("community_did", "=", communityDid)
          .executeTakeFirst();

        // Also fetch community type from ATProto profile
        let communityType = "open";
        try {
          const communityAgent = await createCommunityAgent(db, communityDid);
          const profileRes =
            await communityAgent.api.com.atproto.repo.getRecord({
              repo: communityDid,
              collection: "community.opensocial.profile",
              rkey: "self",
            });
          communityType = (profileRes.data.value as any).type || "open";
        } catch {
          /* profile may not exist yet */
        }

        if (!settings) {
          return res.json({
            settings: {
              communityDid,
              appVisibilityDefault: "open",
              blockedAppIds: [],
              communityType,
            },
          });
        }

        res.json({
          settings: {
            communityDid: settings.community_did,
            appVisibilityDefault: settings.app_visibility_default,
            blockedAppIds: JSON.parse(settings.blocked_app_ids),
            communityType,
          },
        });
      } catch (error) {
        logger.error(
          { error, communityDid: req.params.did },
          "Error getting community settings",
        );
        res.status(500).json({ error: "Failed to get community settings" });
      }
    },
  );

  router.put(
    "/communities/:did/settings",
    async (req: Request, res: Response) => {
      try {
        const communityDid = decodeURIComponent(req.params.did);
        const adminDid = await requireSessionAdmin(req, res, communityDid);
        if (!adminDid) return;

        const { appVisibilityDefault, blockedAppIds, communityType } = req.body;

        // Update DB settings (app visibility, blocked apps)
        const existing = await db
          .selectFrom("community_settings")
          .selectAll()
          .where("community_did", "=", communityDid)
          .executeTakeFirst();

        if (existing) {
          const values: Record<string, any> = { updated_at: new Date() };
          if (appVisibilityDefault)
            values.app_visibility_default = appVisibilityDefault;
          if (blockedAppIds)
            values.blocked_app_ids = JSON.stringify(blockedAppIds);
          await db
            .updateTable("community_settings")
            .set(values)
            .where("community_did", "=", communityDid)
            .execute();
        } else {
          await db
            .insertInto("community_settings")
            .values({
              community_did: communityDid,
              app_visibility_default: appVisibilityDefault || "open",
              blocked_app_ids: blockedAppIds
                ? JSON.stringify(blockedAppIds)
                : "[]",
            })
            .execute();
        }

        // If communityType was provided, update the ATProto profile record
        if (
          communityType &&
          ["open", "admin-approved", "private"].includes(communityType)
        ) {
          try {
            const communityAgent = await createCommunityAgent(db, communityDid);
            const profileRes =
              await communityAgent.api.com.atproto.repo.getRecord({
                repo: communityDid,
                collection: "community.opensocial.profile",
                rkey: "self",
              });
            const currentProfile = profileRes.data.value as any;
            await communityAgent.api.com.atproto.repo.putRecord({
              repo: communityDid,
              collection: "community.opensocial.profile",
              rkey: "self",
              record: {
                ...currentProfile,
                $type: "community.opensocial.profile",
                type: communityType,
              },
            });
          } catch (err) {
            logger.error(
              { error: err, communityDid },
              "Failed to update community type in profile",
            );
          }
        }

        await auditLog.log({
          communityDid,
          adminDid,
          action: "settings.updated",
          metadata: { appVisibilityDefault, blockedAppIds, communityType },
        });
        res.json({ success: true });
      } catch (error) {
        logger.error(
          { error, communityDid: req.params.did },
          "Error updating community settings",
        );
        res.status(500).json({ error: "Failed to update community settings" });
      }
    },
  );

  // ─── App visibility ────────────────────────────────────────────────

  router.get("/communities/:did/apps", async (req: Request, res: Response) => {
    try {
      const agent = await getSessionAgent(req, res, oauthClient);
      if (!agent) return res.status(401).json({ error: "Not authenticated" });

      const communityDid = decodeURIComponent(req.params.did);

      const rows = await db
        .selectFrom("community_app_visibility")
        .selectAll()
        .where("community_did", "=", communityDid)
        .orderBy("created_at", "desc")
        .execute();

      const enriched = await Promise.all(
        rows.map(async (row) => {
          const app = await db
            .selectFrom("apps")
            .select(["name", "domain"])
            .where("app_id", "=", row.app_id)
            .executeTakeFirst();
          return {
            appId: row.app_id,
            appName: app?.name || null,
            appDomain: app?.domain || null,
            status: row.status,
            reviewedBy: row.reviewed_by,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
          };
        }),
      );

      // Also list all active apps so admins can discover apps to enable
      const allApps = await db
        .selectFrom("apps")
        .select(["app_id", "name", "domain"])
        .where("status", "=", "active")
        .execute();

      res.json({ apps: enriched, allApps });
    } catch (error) {
      logger.error(
        { error, communityDid: req.params.did },
        "Error listing app visibility",
      );
      res.status(500).json({ error: "Failed to list app visibility" });
    }
  });

  router.put(
    "/communities/:did/apps/:appId",
    async (req: Request, res: Response) => {
      try {
        const communityDid = decodeURIComponent(req.params.did);
        const appId = req.params.appId;
        const adminDid = await requireSessionAdmin(req, res, communityDid);
        if (!adminDid) return;

        const { status } = req.body;
        if (!["enabled", "disabled", "pending"].includes(status)) {
          return res
            .status(400)
            .json({ error: "status must be enabled, disabled, or pending" });
        }

        const existing = await db
          .selectFrom("community_app_visibility")
          .selectAll()
          .where("community_did", "=", communityDid)
          .where("app_id", "=", appId)
          .executeTakeFirst();

        if (existing) {
          await db
            .updateTable("community_app_visibility")
            .set({ status, reviewed_by: adminDid, updated_at: new Date() })
            .where("id", "=", existing.id)
            .execute();
        } else {
          await db
            .insertInto("community_app_visibility")
            .values({
              community_did: communityDid,
              app_id: appId,
              status,
              requested_by: adminDid,
              reviewed_by: adminDid,
            })
            .execute();
        }

        if (status === "enabled")
          await seedCollectionPermissions(db, communityDid, appId);

        const actionMap = {
          enabled: "app.visibility.enabled",
          disabled: "app.visibility.disabled",
          pending: "app.visibility.pending",
        } as const;
        await auditLog.log({
          communityDid,
          adminDid,
          action: actionMap[status as keyof typeof actionMap],
          metadata: { appId },
        });
        res.json({ success: true });
      } catch (error) {
        logger.error(
          { error, communityDid: req.params.did, appId: req.params.appId },
          "Error updating app visibility",
        );
        res.status(500).json({ error: "Failed to update app visibility" });
      }
    },
  );

  // ─── Collection permissions ────────────────────────────────────────

  router.get(
    "/communities/:did/apps/:appId/permissions",
    async (req: Request, res: Response) => {
      try {
        const agent = await getSessionAgent(req, res, oauthClient);
        if (!agent) return res.status(401).json({ error: "Not authenticated" });

        const communityDid = decodeURIComponent(req.params.did);
        const appId = req.params.appId;

        const rows = await db
          .selectFrom("community_app_collection_permissions")
          .selectAll()
          .where("community_did", "=", communityDid)
          .where("app_id", "=", appId)
          .orderBy("collection", "asc")
          .execute();

        res.json({
          permissions: rows.map((r) => ({
            collection: r.collection,
            canCreate: r.can_create,
            canRead: r.can_read,
            canUpdate: r.can_update,
            canDelete: r.can_delete,
          })),
        });
      } catch (error) {
        logger.error(
          { error, communityDid: req.params.did, appId: req.params.appId },
          "Error listing collection permissions",
        );
        res
          .status(500)
          .json({ error: "Failed to list collection permissions" });
      }
    },
  );

  router.put(
    "/communities/:did/apps/:appId/permissions",
    async (req: Request, res: Response) => {
      try {
        const communityDid = decodeURIComponent(req.params.did);
        const appId = req.params.appId;
        const adminDid = await requireSessionAdmin(req, res, communityDid);
        if (!adminDid) return;

        const { collection, canCreate, canRead, canUpdate, canDelete } =
          req.body;
        if (!collection)
          return res.status(400).json({ error: "collection is required" });

        const existing = await db
          .selectFrom("community_app_collection_permissions")
          .selectAll()
          .where("community_did", "=", communityDid)
          .where("app_id", "=", appId)
          .where("collection", "=", collection)
          .executeTakeFirst();

        if (existing) {
          const updates: Record<string, any> = { updated_at: new Date() };
          if (canCreate) updates.can_create = canCreate;
          if (canRead) updates.can_read = canRead;
          if (canUpdate) updates.can_update = canUpdate;
          if (canDelete) updates.can_delete = canDelete;
          await db
            .updateTable("community_app_collection_permissions")
            .set(updates)
            .where("id", "=", existing.id)
            .execute();
        } else {
          await db
            .insertInto("community_app_collection_permissions")
            .values({
              community_did: communityDid,
              app_id: appId,
              collection,
              can_create: canCreate || "member",
              can_read: canRead || "member",
              can_update: canUpdate || "member",
              can_delete: canDelete || "admin",
            })
            .execute();
        }

        await auditLog.log({
          communityDid,
          adminDid,
          action: "collection.permission.updated",
          metadata: { appId, collection },
        });
        res.json({ success: true });
      } catch (error) {
        logger.error(
          { error, communityDid: req.params.did, appId: req.params.appId },
          "Error setting collection permission",
        );
        res.status(500).json({ error: "Failed to set collection permission" });
      }
    },
  );

  router.delete(
    "/communities/:did/apps/:appId/permissions",
    async (req: Request, res: Response) => {
      try {
        const communityDid = decodeURIComponent(req.params.did);
        const appId = req.params.appId;
        const adminDid = await requireSessionAdmin(req, res, communityDid);
        if (!adminDid) return;

        const { collection } = req.body;
        if (!collection)
          return res.status(400).json({ error: "collection is required" });

        await db
          .deleteFrom("community_app_collection_permissions")
          .where("community_did", "=", communityDid)
          .where("app_id", "=", appId)
          .where("collection", "=", collection)
          .execute();

        await auditLog.log({
          communityDid,
          adminDid,
          action: "collection.permission.deleted",
          metadata: { appId, collection },
        });
        res.json({ success: true });
      } catch (error) {
        logger.error(
          { error, communityDid: req.params.did, appId: req.params.appId },
          "Error deleting collection permission",
        );
        res
          .status(500)
          .json({ error: "Failed to delete collection permission" });
      }
    },
  );

  // ─── Custom roles ──────────────────────────────────────────────────

  router.get("/communities/:did/roles", async (req: Request, res: Response) => {
    try {
      const agent = await getSessionAgent(req, res, oauthClient);
      if (!agent) return res.status(401).json({ error: "Not authenticated" });

      const communityDid = decodeURIComponent(req.params.did);
      const roles = await db
        .selectFrom("community_roles")
        .selectAll()
        .where("community_did", "=", communityDid)
        .orderBy("name", "asc")
        .execute();

      res.json({
        roles: roles.map((r) => ({
          name: r.name,
          displayName: r.display_name,
          description: r.description,
          visible: r.visible,
          canViewAuditLog: r.can_view_audit_log,
          createdAt: r.created_at,
        })),
      });
    } catch (error) {
      logger.error(
        { error, communityDid: req.params.did },
        "Error listing roles",
      );
      res.status(500).json({ error: "Failed to list roles" });
    }
  });

  router.post(
    "/communities/:did/roles",
    async (req: Request, res: Response) => {
      try {
        const communityDid = decodeURIComponent(req.params.did);
        const adminDid = await requireSessionAdmin(req, res, communityDid);
        if (!adminDid) return;

        const { name, displayName, description, visible, canViewAuditLog } =
          req.body;
        if (!name || !displayName)
          return res
            .status(400)
            .json({ error: "name and displayName are required" });
        if (name === "admin" || name === "member")
          return res
            .status(400)
            .json({ error: `"${name}" is a built-in role` });

        const dup = await db
          .selectFrom("community_roles")
          .select("id")
          .where("community_did", "=", communityDid)
          .where("name", "=", name)
          .executeTakeFirst();
        if (dup)
          return res
            .status(409)
            .json({ error: `Role "${name}" already exists` });

        await db
          .insertInto("community_roles")
          .values({
            community_did: communityDid,
            name,
            display_name: displayName,
            description: description || null,
            visible: visible ?? false,
            can_view_audit_log: canViewAuditLog ?? false,
          })
          .execute();

        await auditLog.log({
          communityDid,
          adminDid,
          action: "role.created",
          metadata: { name, displayName, visible, canViewAuditLog },
        });
        res.status(201).json({
          success: true,
          role: { name, displayName, description, visible, canViewAuditLog },
        });
      } catch (error) {
        logger.error(
          { error, communityDid: req.params.did },
          "Error creating role",
        );
        res.status(500).json({ error: "Failed to create role" });
      }
    },
  );

  router.put(
    "/communities/:did/roles/:roleName",
    async (req: Request, res: Response) => {
      try {
        const communityDid = decodeURIComponent(req.params.did);
        const roleName = req.params.roleName;
        const adminDid = await requireSessionAdmin(req, res, communityDid);
        if (!adminDid) return;

        const { displayName, description, visible, canViewAuditLog } = req.body;
        const updates: Record<string, any> = { updated_at: new Date() };
        if (displayName !== undefined) updates.display_name = displayName;
        if (description !== undefined) updates.description = description;
        if (visible !== undefined) updates.visible = visible;
        if (canViewAuditLog !== undefined)
          updates.can_view_audit_log = canViewAuditLog;

        const result = await db
          .updateTable("community_roles")
          .set(updates)
          .where("community_did", "=", communityDid)
          .where("name", "=", roleName)
          .executeTakeFirst();
        if (!result.numUpdatedRows || result.numUpdatedRows === 0n)
          return res.status(404).json({ error: "Role not found" });

        await auditLog.log({
          communityDid,
          adminDid,
          action: "role.updated",
          metadata: { roleName, displayName, description, visible },
        });
        res.json({ success: true });
      } catch (error) {
        logger.error(
          {
            error,
            communityDid: req.params.did,
            roleName: req.params.roleName,
          },
          "Error updating role",
        );
        res.status(500).json({ error: "Failed to update role" });
      }
    },
  );

  router.delete(
    "/communities/:did/roles/:roleName",
    async (req: Request, res: Response) => {
      try {
        const communityDid = decodeURIComponent(req.params.did);
        const roleName = req.params.roleName;
        const adminDid = await requireSessionAdmin(req, res, communityDid);
        if (!adminDid) return;

        await db
          .deleteFrom("community_member_roles")
          .where("community_did", "=", communityDid)
          .where("role_name", "=", roleName)
          .execute();
        const result = await db
          .deleteFrom("community_roles")
          .where("community_did", "=", communityDid)
          .where("name", "=", roleName)
          .executeTakeFirst();
        if (!result.numDeletedRows || result.numDeletedRows === 0n)
          return res.status(404).json({ error: "Role not found" });

        memberRolesCache.invalidatePrefix(`${communityDid}:`);
        await auditLog.log({
          communityDid,
          adminDid,
          action: "role.deleted",
          metadata: { roleName },
        });
        res.json({ success: true });
      } catch (error) {
        logger.error(
          {
            error,
            communityDid: req.params.did,
            roleName: req.params.roleName,
          },
          "Error deleting role",
        );
        res.status(500).json({ error: "Failed to delete role" });
      }
    },
  );

  // ─── Role assignments ──────────────────────────────────────────────

  router.get(
    "/communities/:did/members/:memberDid/roles",
    async (req: Request, res: Response) => {
      try {
        const agent = await getSessionAgent(req, res, oauthClient);
        if (!agent) return res.status(401).json({ error: "Not authenticated" });

        const communityDid = decodeURIComponent(req.params.did);
        const memberDid = decodeURIComponent(req.params.memberDid);

        const assignments = await db
          .selectFrom("community_member_roles")
          .select(["role_name", "assigned_by", "created_at"])
          .where("community_did", "=", communityDid)
          .where("member_did", "=", memberDid)
          .execute();

        res.json({
          roles: assignments.map((r) => ({
            roleName: r.role_name,
            assignedBy: r.assigned_by,
            assignedAt: r.created_at,
          })),
        });
      } catch (error) {
        logger.error(
          {
            error,
            communityDid: req.params.did,
            memberDid: req.params.memberDid,
          },
          "Error listing member roles",
        );
        res.status(500).json({ error: "Failed to list member roles" });
      }
    },
  );

  router.post(
    "/communities/:did/members/:memberDid/roles",
    async (req: Request, res: Response) => {
      try {
        const communityDid = decodeURIComponent(req.params.did);
        const memberDid = decodeURIComponent(req.params.memberDid);
        const adminDid = await requireSessionAdmin(req, res, communityDid);
        if (!adminDid) return;

        const { roleName } = req.body;
        if (!roleName)
          return res.status(400).json({ error: "roleName is required" });

        if (roleName !== "admin" && roleName !== "member") {
          const role = await db
            .selectFrom("community_roles")
            .select("id")
            .where("community_did", "=", communityDid)
            .where("name", "=", roleName)
            .executeTakeFirst();
          if (!role)
            return res
              .status(404)
              .json({ error: `Role "${roleName}" does not exist` });
        }

        const dup = await db
          .selectFrom("community_member_roles")
          .select("id")
          .where("community_did", "=", communityDid)
          .where("member_did", "=", memberDid)
          .where("role_name", "=", roleName)
          .executeTakeFirst();
        if (dup)
          return res
            .status(409)
            .json({ error: `Member already has role "${roleName}"` });

        await db
          .insertInto("community_member_roles")
          .values({
            community_did: communityDid,
            member_did: memberDid,
            role_name: roleName,
            assigned_by: adminDid,
          })
          .execute();
        memberRolesCache.invalidate(`${communityDid}:${memberDid}`);

        await auditLog.log({
          communityDid,
          adminDid,
          action: "role.assigned",
          targetDid: memberDid,
          metadata: { roleName },
        });
        res.status(201).json({ success: true });
      } catch (error) {
        logger.error(
          {
            error,
            communityDid: req.params.did,
            memberDid: req.params.memberDid,
          },
          "Error assigning role",
        );
        res.status(500).json({ error: "Failed to assign role" });
      }
    },
  );

  router.delete(
    "/communities/:did/members/:memberDid/roles/:roleName",
    async (req: Request, res: Response) => {
      try {
        const communityDid = decodeURIComponent(req.params.did);
        const memberDid = decodeURIComponent(req.params.memberDid);
        const roleName = req.params.roleName;
        const adminDid = await requireSessionAdmin(req, res, communityDid);
        if (!adminDid) return;

        const result = await db
          .deleteFrom("community_member_roles")
          .where("community_did", "=", communityDid)
          .where("member_did", "=", memberDid)
          .where("role_name", "=", roleName)
          .executeTakeFirst();
        if (!result.numDeletedRows || result.numDeletedRows === 0n)
          return res.status(404).json({ error: "Role assignment not found" });

        memberRolesCache.invalidate(`${communityDid}:${memberDid}`);
        await auditLog.log({
          communityDid,
          adminDid,
          action: "role.revoked",
          targetDid: memberDid,
          metadata: { roleName },
        });
        res.json({ success: true });
      } catch (error) {
        logger.error(
          {
            error,
            communityDid: req.params.did,
            memberDid: req.params.memberDid,
            roleName: req.params.roleName,
          },
          "Error revoking role",
        );
        res.status(500).json({ error: "Failed to revoke role" });
      }
    },
  );

  // ─── Audit log viewing ─────────────────────────────────────────────

  /**
   * Check whether a user can view the audit log.
   * Admins always can. Custom roles with can_view_audit_log=true can.
   * Members (built-in) cannot by default.
   */
  async function canViewAuditLog(
    communityDid: string,
    userDid: string,
  ): Promise<boolean> {
    // Check if admin
    try {
      const communityAgent = await createCommunityAgent(db, communityDid);
      const isAdm = await checkAdmin(communityAgent, communityDid, userDid);
      if (isAdm) return true;
    } catch {
      /* not admin */
    }

    // Check custom roles assigned to user that have can_view_audit_log
    const roleAssignments = await db
      .selectFrom("community_member_roles")
      .select("role_name")
      .where("community_did", "=", communityDid)
      .where("member_did", "=", userDid)
      .execute();

    if (roleAssignments.length === 0) return false;

    const roleNames = roleAssignments.map((r) => r.role_name);
    const matchingRoles = await db
      .selectFrom("community_roles")
      .select("name")
      .where("community_did", "=", communityDid)
      .where("name", "in", roleNames)
      .where("can_view_audit_log", "=", true)
      .execute();

    return matchingRoles.length > 0;
  }

  router.get(
    "/communities/:did/audit-log",
    async (req: Request, res: Response) => {
      try {
        const agent = await getSessionAgent(req, res, oauthClient);
        if (!agent) return res.status(401).json({ error: "Not authenticated" });

        const communityDid = decodeURIComponent(req.params.did);
        const userDid = agent.assertDid;

        const hasAccess = await canViewAuditLog(communityDid, userDid);
        if (!hasAccess) {
          return res
            .status(403)
            .json({ error: "Not authorized to view audit log" });
        }

        const cursor = req.query.cursor as string | undefined;
        const limit = Math.min(
          Math.max(parseInt(req.query.limit as string) || 20, 1),
          100,
        );

        const result = await auditLog.query({ communityDid, cursor, limit });
        res.json(result);
      } catch (error) {
        logger.error(
          { error, communityDid: req.params.did },
          "Error fetching audit log",
        );
        res.status(500).json({ error: "Failed to fetch audit log" });
      }
    },
  );

  // Return whether the current user can view the audit log (for UI gating)
  router.get(
    "/communities/:did/audit-log/access",
    async (req: Request, res: Response) => {
      try {
        const agent = await getSessionAgent(req, res, oauthClient);
        if (!agent) return res.status(401).json({ error: "Not authenticated" });

        const communityDid = decodeURIComponent(req.params.did);
        const hasAccess = await canViewAuditLog(communityDid, agent.assertDid);
        res.json({ canViewAuditLog: hasAccess });
      } catch (error) {
        logger.error(
          { error, communityDid: req.params.did },
          "Error checking audit log access",
        );
        res.status(500).json({ error: "Failed to check audit log access" });
      }
    },
  );

  // ─── Hierarchy routes (session-based, for web UI) ────────────────────

  const HIERARCHY_COLLECTION = "community.opensocial.hierarchy";
  const SHARED_CONTENT_COLLECTION = "community.opensocial.sharedContent";

  /**
   * Helper: fetch admins list from community's PDS.
   */
  async function getHierarchyAdmins(
    communityAgent: any,
    communityDid: string,
  ): Promise<any[]> {
    try {
      const res = await communityAgent.api.com.atproto.repo.getRecord({
        repo: communityDid,
        collection: "community.opensocial.admins",
        rkey: "self",
      });
      return (res.data.value as any)?.admins || [];
    } catch {
      return [];
    }
  }

  /**
   * Helper: check if the session user is an admin of the given community.
   * Returns the communityAgent on success, or sends a 403 and returns null.
   */
  async function requireCommunityAdmin(
    req: Request,
    res: Response,
    communityDid: string,
    userDid: string,
  ) {
    const communityAgent = await createCommunityAgent(db, communityDid);
    const admins = await getHierarchyAdmins(communityAgent, communityDid);
    if (!isAdminInList(userDid, admins)) {
      res
        .status(403)
        .json({ error: "Not authorized. Must be a community admin." });
      return null;
    }
    return communityAgent;
  }

  /**
   * Helper: run a DB operation against pending_hierarchy_requests.
   * If the table doesn't exist yet (migration 009 not applied), logs a
   * warning and returns silently so PDS operations aren't blocked.
   */
  async function pendingTableOp<T>(
    operation: () => Promise<T>,
    fallback: T,
  ): Promise<T> {
    try {
      return await operation();
    } catch (err: any) {
      if (
        err?.message?.includes("pending_hierarchy_requests") &&
        err?.message?.includes("does not exist")
      ) {
        logger.warn(
          "pending_hierarchy_requests table does not exist yet — skipping DB operation",
        );
        return fallback;
      }
      throw err;
    }
  }

  // GET /communities/:did/hierarchy — list all hierarchy relationships
  router.get(
    "/communities/:did/hierarchy",
    async (req: Request, res: Response) => {
      try {
        const communityDid = decodeURIComponent(req.params.did);

        const community = await db
          .selectFrom("communities")
          .selectAll()
          .where("did", "=", communityDid)
          .executeTakeFirst();
        if (!community) {
          return res.status(404).json({ error: "Community not found" });
        }

        const communityAgent = await createCommunityAgent(db, communityDid);
        const response = await communityAgent.api.com.atproto.repo.listRecords({
          repo: communityDid,
          collection: HIERARCHY_COLLECTION,
          limit: 100,
        });

        const raw = response.data.records.map((r: any) => ({
          uri: r.uri,
          rkey: r.uri.split("/").pop(),
          role: r.value.role,
          counterpartyDid: r.value.counterpartyDid,
          status: r.value.status,
          requestedBy: r.value.requestedBy,
          createdAt: r.value.createdAt,
        }));

        // Enrich with counterparty display info
        const counterpartyDids = raw.map((r: any) => r.counterpartyDid);
        const counterpartyRows =
          counterpartyDids.length > 0
            ? await db
                .selectFrom("communities")
                .select([
                  "did",
                  "display_name",
                  "handle",
                  "avatar_url",
                  "description",
                ])
                .where("did", "in", counterpartyDids)
                .execute()
            : [];
        const counterpartyMap = new Map(
          counterpartyRows.map((c) => [c.did, c]),
        );

        const relationships = raw.map((r: any) => {
          const info = counterpartyMap.get(r.counterpartyDid);
          return {
            ...r,
            displayName: info?.display_name ?? null,
            handle: info?.handle ?? null,
            avatar: info?.avatar_url ?? null,
            description: info?.description ?? null,
          };
        });

        res.json({ relationships });
      } catch (error) {
        logger.error(
          { error, communityDid: req.params.did },
          "Error listing hierarchy",
        );
        res.status(500).json({
          error: "Failed to list hierarchy relationships",
          details: error instanceof Error ? error.message : "Unknown error",
        });
      }
    },
  );

  // GET /communities/:did/hierarchy/pending — incoming pending requests
  router.get(
    "/communities/:did/hierarchy/pending",
    async (req: Request, res: Response) => {
      try {
        const agent = await getSessionAgent(req, res, oauthClient);
        if (!agent) return res.status(401).json({ error: "Not authenticated" });

        const communityDid = decodeURIComponent(req.params.did);
        const communityAgent = await requireCommunityAdmin(
          req,
          res,
          communityDid,
          agent.assertDid,
        );
        if (!communityAgent) return;

        let rows: any[] = [];
        rows = await pendingTableOp(
          () =>
            db
              .selectFrom("pending_hierarchy_requests as p")
              .innerJoin("communities as c", "c.did", "p.requester_did")
              .select([
                "p.id",
                "p.requester_did as requesterDid",
                "p.target_did as targetDid",
                "p.requester_role as requesterRole",
                "p.requester_record_rkey as requesterRecordRkey",
                "p.admin_did as adminDid",
                "p.created_at as createdAt",
                "c.display_name as displayName",
                "c.handle",
                "c.avatar_url as avatar",
                "c.description",
              ])
              .where("p.target_did", "=", communityDid)
              .orderBy("p.created_at", "desc")
              .execute(),
          [],
        );

        // Fallback: if no DB rows, scan other communities' PDS records for
        // pending hierarchy records that reference this community.
        if (rows.length === 0) {
          const otherCommunities = await db
            .selectFrom("communities")
            .select([
              "did",
              "display_name",
              "handle",
              "avatar_url",
              "description",
            ])
            .where("did", "!=", communityDid)
            .execute();

          for (const other of otherCommunities) {
            try {
              const otherAgent = await createCommunityAgent(db, other.did);
              let scanCursor: string | undefined;
              do {
                const records =
                  await otherAgent.api.com.atproto.repo.listRecords({
                    repo: other.did,
                    collection: HIERARCHY_COLLECTION,
                    limit: 100,
                    cursor: scanCursor,
                  });
                for (const r of records.data.records) {
                  const val = r.value as any;
                  if (
                    val.counterpartyDid === communityDid &&
                    val.status === "pending"
                  ) {
                    rows.push({
                      id: 0,
                      requesterDid: other.did,
                      targetDid: communityDid,
                      requesterRole: val.role,
                      requesterRecordRkey: r.uri.split("/").pop(),
                      adminDid: val.requestedBy || other.did,
                      createdAt: val.createdAt,
                      displayName: other.display_name,
                      handle: other.handle,
                      avatar: other.avatar_url,
                      description: other.description,
                    });
                  }
                }
                scanCursor = records.data.cursor;
              } while (scanCursor);
            } catch (scanErr) {
              logger.warn(
                { error: scanErr, otherDid: other.did },
                "Could not scan community for pending hierarchy",
              );
            }
          }
        }

        res.json({ requests: rows });
      } catch (error) {
        logger.error(
          { error, communityDid: req.params.did },
          "Error listing pending hierarchy",
        );
        res.status(500).json({
          error: "Failed to list pending hierarchy requests",
          details: error instanceof Error ? error.message : "Unknown error",
        });
      }
    },
  );

  // GET /communities/:did/hierarchy/content — aggregated child content
  router.get(
    "/communities/:did/hierarchy/content",
    async (req: Request, res: Response) => {
      try {
        const communityDid = decodeURIComponent(req.params.did);
        const contentType = req.query.type as string | undefined;
        const limit = Math.min(
          Math.max(parseInt(req.query.limit as string) || 50, 1),
          100,
        );

        const community = await db
          .selectFrom("communities")
          .selectAll()
          .where("did", "=", communityDid)
          .executeTakeFirst();
        if (!community) {
          return res.status(404).json({ error: "Community not found" });
        }

        const parentAgent = await createCommunityAgent(db, communityDid);

        // Collect approved child DIDs
        const approvedChildDids: string[] = [];
        let hierarchyCursor: string | undefined;
        do {
          const hierarchyRecords =
            await parentAgent.api.com.atproto.repo.listRecords({
              repo: communityDid,
              collection: HIERARCHY_COLLECTION,
              limit: 100,
              cursor: hierarchyCursor,
            });
          for (const r of hierarchyRecords.data.records) {
            const val = r.value as any;
            if (val.role === "parent" && val.status === "approved") {
              approvedChildDids.push(val.counterpartyDid);
            }
          }
          hierarchyCursor = hierarchyRecords.data.cursor;
        } while (hierarchyCursor);

        if (approvedChildDids.length === 0) {
          return res.json({ records: [] });
        }

        const allRecords: any[] = [];
        for (const childDid of approvedChildDids) {
          try {
            const childCommunity = await db
              .selectFrom("communities")
              .selectAll()
              .where("did", "=", childDid)
              .executeTakeFirst();
            if (!childCommunity) continue;

            const childAgent = await createCommunityAgent(db, childDid);
            const contentResponse =
              await childAgent.api.com.atproto.repo.listRecords({
                repo: childDid,
                collection: SHARED_CONTENT_COLLECTION,
                limit: Math.min(limit, 100),
              });

            for (const r of contentResponse.data.records) {
              const recordType = (r.value as any).type;
              if (contentType && recordType !== contentType) continue;

              allRecords.push({
                uri: r.uri,
                rkey: r.uri.split("/").pop(),
                sourceCommunityDid: childDid,
                type: recordType,
                documentUri: (r.value as any).documentUri,
                documentCid: (r.value as any).documentCid,
                sharedBy: (r.value as any).sharedBy,
                title: (r.value as any).title,
                path: (r.value as any).path,
                sharedAt: (r.value as any).sharedAt,
                ...((r.value as any).startsAt !== undefined
                  ? { startsAt: (r.value as any).startsAt }
                  : {}),
                ...((r.value as any).endsAt !== undefined
                  ? { endsAt: (r.value as any).endsAt }
                  : {}),
                ...((r.value as any).location !== undefined
                  ? { location: (r.value as any).location }
                  : {}),
                ...((r.value as any).mode !== undefined
                  ? { mode: (r.value as any).mode }
                  : {}),
              });
            }
          } catch (childError) {
            logger.warn(
              { error: childError, childDid, communityDid },
              "Failed to fetch child content",
            );
          }
        }

        allRecords.sort((a, b) => {
          const aTime = a.sharedAt ? new Date(a.sharedAt).getTime() : 0;
          const bTime = b.sharedAt ? new Date(b.sharedAt).getTime() : 0;
          return bTime - aTime;
        });

        res.json({ records: allRecords.slice(0, limit) });
      } catch (error) {
        logger.error(
          { error, communityDid: req.params.did },
          "Error fetching hierarchy content",
        );
        res.status(500).json({
          error: "Failed to fetch hierarchy content",
          details: error instanceof Error ? error.message : "Unknown error",
        });
      }
    },
  );

  // POST /communities/:did/hierarchy/request — child requests parent relationship
  router.post(
    "/communities/:did/hierarchy/request",
    async (req: Request, res: Response) => {
      try {
        const agent = await getSessionAgent(req, res, oauthClient);
        if (!agent) return res.status(401).json({ error: "Not authenticated" });

        const childDid = decodeURIComponent(req.params.did);
        const { parentDid } = req.body;

        if (!parentDid)
          return res.status(400).json({ error: "parentDid is required" });
        if (childDid === parentDid)
          return res
            .status(400)
            .json({ error: "A community cannot be its own parent" });

        // Verify both communities exist
        const [childCommunity, parentCommunity] = await Promise.all([
          db
            .selectFrom("communities")
            .selectAll()
            .where("did", "=", childDid)
            .executeTakeFirst(),
          db
            .selectFrom("communities")
            .selectAll()
            .where("did", "=", parentDid)
            .executeTakeFirst(),
        ]);
        if (!childCommunity)
          return res.status(404).json({ error: "Community not found" });
        if (!parentCommunity)
          return res.status(404).json({ error: "Parent community not found" });

        const childAgent = await requireCommunityAdmin(
          req,
          res,
          childDid,
          agent.assertDid,
        );
        if (!childAgent) return;

        // Check for existing relationship
        let cursor: string | undefined;
        do {
          const existing = await childAgent.api.com.atproto.repo.listRecords({
            repo: childDid,
            collection: HIERARCHY_COLLECTION,
            limit: 100,
            cursor,
          });
          if (
            existing.data.records.find(
              (r: any) => r.value.counterpartyDid === parentDid,
            )
          ) {
            return res.status(409).json({
              error: "A hierarchy relationship with this parent already exists",
            });
          }
          cursor = existing.data.cursor;
        } while (cursor);

        const response = await childAgent.api.com.atproto.repo.createRecord({
          repo: childDid,
          collection: HIERARCHY_COLLECTION,
          record: {
            $type: HIERARCHY_COLLECTION,
            role: "child",
            counterpartyDid: parentDid,
            status: "pending",
            requestedBy: agent.assertDid,
            createdAt: new Date().toISOString(),
          },
        });

        const rkey = response.data.uri.split("/").pop()!;
        await pendingTableOp(
          () =>
            db
              .insertInto("pending_hierarchy_requests")
              .values({
                requester_did: childDid,
                target_did: parentDid,
                requester_role: "child",
                requester_record_rkey: rkey,
                admin_did: agent.assertDid,
              })
              .onConflict((oc) =>
                oc.columns(["requester_did", "target_did"]).doNothing(),
              )
              .execute(),
          undefined,
        );

        await auditLog.log({
          communityDid: childDid,
          adminDid: agent.assertDid,
          action: "hierarchy.requested",
          targetDid: parentDid,
          metadata: { role: "child" },
        });

        res.status(201).json({
          uri: response.data.uri,
          cid: response.data.cid,
          rkey,
          status: "pending",
          message:
            "Hierarchy request created. Waiting for parent community approval.",
        });
      } catch (error) {
        logger.error(
          { error, communityDid: req.params.did },
          "Error requesting hierarchy",
        );
        res.status(500).json({
          error: "Failed to request hierarchy relationship",
          details: error instanceof Error ? error.message : "Unknown error",
        });
      }
    },
  );

  // POST /communities/:did/hierarchy/invite — parent invites child
  router.post(
    "/communities/:did/hierarchy/invite",
    async (req: Request, res: Response) => {
      try {
        const agent = await getSessionAgent(req, res, oauthClient);
        if (!agent) return res.status(401).json({ error: "Not authenticated" });

        const parentDid = decodeURIComponent(req.params.did);
        const { childDid } = req.body;

        if (!childDid)
          return res.status(400).json({ error: "childDid is required" });
        if (parentDid === childDid)
          return res
            .status(400)
            .json({ error: "A community cannot be its own child" });

        const [parentCommunity, childCommunity] = await Promise.all([
          db
            .selectFrom("communities")
            .selectAll()
            .where("did", "=", parentDid)
            .executeTakeFirst(),
          db
            .selectFrom("communities")
            .selectAll()
            .where("did", "=", childDid)
            .executeTakeFirst(),
        ]);
        if (!parentCommunity)
          return res.status(404).json({ error: "Community not found" });
        if (!childCommunity)
          return res.status(404).json({ error: "Child community not found" });

        const parentAgent = await requireCommunityAdmin(
          req,
          res,
          parentDid,
          agent.assertDid,
        );
        if (!parentAgent) return;

        // Check for existing relationship
        let cursor: string | undefined;
        do {
          const existing = await parentAgent.api.com.atproto.repo.listRecords({
            repo: parentDid,
            collection: HIERARCHY_COLLECTION,
            limit: 100,
            cursor,
          });
          if (
            existing.data.records.find(
              (r: any) => r.value.counterpartyDid === childDid,
            )
          ) {
            return res.status(409).json({
              error: "A hierarchy relationship with this child already exists",
            });
          }
          cursor = existing.data.cursor;
        } while (cursor);

        const response = await parentAgent.api.com.atproto.repo.createRecord({
          repo: parentDid,
          collection: HIERARCHY_COLLECTION,
          record: {
            $type: HIERARCHY_COLLECTION,
            role: "parent",
            counterpartyDid: childDid,
            status: "pending",
            requestedBy: agent.assertDid,
            createdAt: new Date().toISOString(),
          },
        });

        const rkey = response.data.uri.split("/").pop()!;
        await pendingTableOp(
          () =>
            db
              .insertInto("pending_hierarchy_requests")
              .values({
                requester_did: parentDid,
                target_did: childDid,
                requester_role: "parent",
                requester_record_rkey: rkey,
                admin_did: agent.assertDid,
              })
              .onConflict((oc) =>
                oc.columns(["requester_did", "target_did"]).doNothing(),
              )
              .execute(),
          undefined,
        );

        await auditLog.log({
          communityDid: parentDid,
          adminDid: agent.assertDid,
          action: "hierarchy.invited",
          targetDid: childDid,
          metadata: { role: "parent" },
        });

        res.status(201).json({
          uri: response.data.uri,
          cid: response.data.cid,
          rkey,
          status: "pending",
          message:
            "Hierarchy invite created. Waiting for child community approval.",
        });
      } catch (error) {
        logger.error(
          { error, communityDid: req.params.did },
          "Error inviting child",
        );
        res.status(500).json({
          error: "Failed to invite child community",
          details: error instanceof Error ? error.message : "Unknown error",
        });
      }
    },
  );

  // POST /communities/:did/hierarchy/approve — parent approves child's request
  router.post(
    "/communities/:did/hierarchy/approve",
    async (req: Request, res: Response) => {
      try {
        const agent = await getSessionAgent(req, res, oauthClient);
        if (!agent) return res.status(401).json({ error: "Not authenticated" });

        const parentDid = decodeURIComponent(req.params.did);
        const { childDid } = req.body;

        if (!childDid)
          return res.status(400).json({ error: "childDid is required" });
        if (parentDid === childDid)
          return res
            .status(400)
            .json({ error: "A community cannot be its own child" });

        const [parentCommunity, childCommunity] = await Promise.all([
          db
            .selectFrom("communities")
            .selectAll()
            .where("did", "=", parentDid)
            .executeTakeFirst(),
          db
            .selectFrom("communities")
            .selectAll()
            .where("did", "=", childDid)
            .executeTakeFirst(),
        ]);
        if (!parentCommunity)
          return res.status(404).json({ error: "Community not found" });
        if (!childCommunity)
          return res.status(404).json({ error: "Child community not found" });

        const parentAgent = await requireCommunityAdmin(
          req,
          res,
          parentDid,
          agent.assertDid,
        );
        if (!parentAgent) return;

        // Check parent doesn't already have a record for this child
        let pCursor: string | undefined;
        do {
          const existing = await parentAgent.api.com.atproto.repo.listRecords({
            repo: parentDid,
            collection: HIERARCHY_COLLECTION,
            limit: 100,
            cursor: pCursor,
          });
          if (
            existing.data.records.find(
              (r: any) => r.value.counterpartyDid === childDid,
            )
          ) {
            return res.status(409).json({
              error: "This hierarchy relationship has already been approved",
            });
          }
          pCursor = existing.data.cursor;
        } while (pCursor);

        // Find child's pending request
        const childAgent = await createCommunityAgent(db, childDid);
        let childRecordRkey: string | null = null;
        let childRecordRequestedBy: string = agent.assertDid;
        let childRecordCreatedAt: string = new Date().toISOString();
        let cCursor: string | undefined;
        do {
          const childRecords =
            await childAgent.api.com.atproto.repo.listRecords({
              repo: childDid,
              collection: HIERARCHY_COLLECTION,
              limit: 100,
              cursor: cCursor,
            });
          const match = childRecords.data.records.find(
            (r: any) =>
              r.value.counterpartyDid === parentDid && r.value.role === "child",
          );
          if (match) {
            childRecordRkey = match.uri.split("/").pop() ?? null;
            childRecordRequestedBy =
              (match.value as any).requestedBy ?? agent.assertDid;
            childRecordCreatedAt =
              (match.value as any).createdAt ?? new Date().toISOString();
            break;
          }
          cCursor = childRecords.data.cursor;
        } while (cCursor);

        if (!childRecordRkey) {
          return res.status(404).json({
            error:
              "No pending hierarchy request found from this child community",
          });
        }

        // Update child's record to approved
        await childAgent.api.com.atproto.repo.putRecord({
          repo: childDid,
          collection: HIERARCHY_COLLECTION,
          rkey: childRecordRkey,
          record: {
            $type: HIERARCHY_COLLECTION,
            role: "child",
            counterpartyDid: parentDid,
            status: "approved",
            requestedBy: childRecordRequestedBy,
            createdAt: childRecordCreatedAt,
          },
        });

        // Create parent's approved record
        const parentResponse =
          await parentAgent.api.com.atproto.repo.createRecord({
            repo: parentDid,
            collection: HIERARCHY_COLLECTION,
            record: {
              $type: HIERARCHY_COLLECTION,
              role: "parent",
              counterpartyDid: childDid,
              status: "approved",
              requestedBy: agent.assertDid,
              createdAt: new Date().toISOString(),
            },
          });

        await pendingTableOp(
          () =>
            db
              .deleteFrom("pending_hierarchy_requests")
              .where("requester_did", "=", childDid)
              .where("target_did", "=", parentDid)
              .execute(),
          undefined,
        );

        await auditLog.log({
          communityDid: parentDid,
          adminDid: agent.assertDid,
          action: "hierarchy.approved",
          targetDid: childDid,
          metadata: { role: "parent" },
        });

        res.status(201).json({
          uri: parentResponse.data.uri,
          cid: parentResponse.data.cid,
          rkey: parentResponse.data.uri.split("/").pop(),
          status: "approved",
          message: "Hierarchy relationship approved.",
        });
      } catch (error) {
        logger.error(
          { error, communityDid: req.params.did },
          "Error approving hierarchy",
        );
        res.status(500).json({
          error: "Failed to approve hierarchy relationship",
          details: error instanceof Error ? error.message : "Unknown error",
        });
      }
    },
  );

  // POST /communities/:did/hierarchy/accept — child accepts parent's invite
  router.post(
    "/communities/:did/hierarchy/accept",
    async (req: Request, res: Response) => {
      try {
        const agent = await getSessionAgent(req, res, oauthClient);
        if (!agent) return res.status(401).json({ error: "Not authenticated" });

        const childDid = decodeURIComponent(req.params.did);
        const { parentDid } = req.body;

        if (!parentDid)
          return res.status(400).json({ error: "parentDid is required" });
        if (childDid === parentDid)
          return res
            .status(400)
            .json({ error: "A community cannot be its own parent" });

        const [childCommunity, parentCommunity] = await Promise.all([
          db
            .selectFrom("communities")
            .selectAll()
            .where("did", "=", childDid)
            .executeTakeFirst(),
          db
            .selectFrom("communities")
            .selectAll()
            .where("did", "=", parentDid)
            .executeTakeFirst(),
        ]);
        if (!childCommunity)
          return res.status(404).json({ error: "Community not found" });
        if (!parentCommunity)
          return res.status(404).json({ error: "Parent community not found" });

        const childAgent = await requireCommunityAdmin(
          req,
          res,
          childDid,
          agent.assertDid,
        );
        if (!childAgent) return;

        // Check child doesn't already have a record for this parent
        let eCursor: string | undefined;
        do {
          const existing = await childAgent.api.com.atproto.repo.listRecords({
            repo: childDid,
            collection: HIERARCHY_COLLECTION,
            limit: 100,
            cursor: eCursor,
          });
          if (
            existing.data.records.find(
              (r: any) => r.value.counterpartyDid === parentDid,
            )
          ) {
            return res.status(409).json({
              error: "A hierarchy relationship with this parent already exists",
            });
          }
          eCursor = existing.data.cursor;
        } while (eCursor);

        // Find parent's pending invite
        const parentAgent = await createCommunityAgent(db, parentDid);
        let parentRecordRkey: string | null = null;
        let parentRecordRequestedBy: string = agent.assertDid;
        let parentRecordCreatedAt: string = new Date().toISOString();
        let pCursor: string | undefined;
        do {
          const parentRecords =
            await parentAgent.api.com.atproto.repo.listRecords({
              repo: parentDid,
              collection: HIERARCHY_COLLECTION,
              limit: 100,
              cursor: pCursor,
            });
          const match = parentRecords.data.records.find(
            (r: any) =>
              r.value.counterpartyDid === childDid && r.value.role === "parent",
          );
          if (match) {
            parentRecordRkey = match.uri.split("/").pop() ?? null;
            parentRecordRequestedBy =
              (match.value as any).requestedBy ?? agent.assertDid;
            parentRecordCreatedAt =
              (match.value as any).createdAt ?? new Date().toISOString();
            break;
          }
          pCursor = parentRecords.data.cursor;
        } while (pCursor);

        if (!parentRecordRkey) {
          return res.status(404).json({
            error:
              "No pending hierarchy invite found from this parent community",
          });
        }

        // Update parent's record to approved
        await parentAgent.api.com.atproto.repo.putRecord({
          repo: parentDid,
          collection: HIERARCHY_COLLECTION,
          rkey: parentRecordRkey,
          record: {
            $type: HIERARCHY_COLLECTION,
            role: "parent",
            counterpartyDid: childDid,
            status: "approved",
            requestedBy: parentRecordRequestedBy,
            createdAt: parentRecordCreatedAt,
          },
        });

        // Create child's approved record
        const childResponse =
          await childAgent.api.com.atproto.repo.createRecord({
            repo: childDid,
            collection: HIERARCHY_COLLECTION,
            record: {
              $type: HIERARCHY_COLLECTION,
              role: "child",
              counterpartyDid: parentDid,
              status: "approved",
              requestedBy: agent.assertDid,
              createdAt: new Date().toISOString(),
            },
          });

        await pendingTableOp(
          () =>
            db
              .deleteFrom("pending_hierarchy_requests")
              .where("requester_did", "=", parentDid)
              .where("target_did", "=", childDid)
              .execute(),
          undefined,
        );

        await auditLog.log({
          communityDid: childDid,
          adminDid: agent.assertDid,
          action: "hierarchy.accepted",
          targetDid: parentDid,
          metadata: { role: "child" },
        });

        res.status(201).json({
          uri: childResponse.data.uri,
          cid: childResponse.data.cid,
          rkey: childResponse.data.uri.split("/").pop(),
          status: "approved",
          message: "Hierarchy invite accepted.",
        });
      } catch (error) {
        logger.error(
          { error, communityDid: req.params.did },
          "Error accepting hierarchy invite",
        );
        res.status(500).json({
          error: "Failed to accept hierarchy invite",
          details: error instanceof Error ? error.message : "Unknown error",
        });
      }
    },
  );

  // POST /communities/:did/hierarchy/reject — reject incoming request/invite
  router.post(
    "/communities/:did/hierarchy/reject",
    async (req: Request, res: Response) => {
      try {
        const agent = await getSessionAgent(req, res, oauthClient);
        if (!agent) return res.status(401).json({ error: "Not authenticated" });

        const communityDid = decodeURIComponent(req.params.did);
        const { counterpartyDid } = req.body;

        if (!counterpartyDid)
          return res.status(400).json({ error: "counterpartyDid is required" });

        const community = await db
          .selectFrom("communities")
          .selectAll()
          .where("did", "=", communityDid)
          .executeTakeFirst();
        if (!community)
          return res.status(404).json({ error: "Community not found" });

        const communityAgent = await requireCommunityAdmin(
          req,
          res,
          communityDid,
          agent.assertDid,
        );
        if (!communityAgent) return;

        const pendingRow = await pendingTableOp(
          () =>
            db
              .selectFrom("pending_hierarchy_requests")
              .selectAll()
              .where("requester_did", "=", counterpartyDid)
              .where("target_did", "=", communityDid)
              .executeTakeFirst(),
          undefined,
        );

        // If the table doesn't exist or no row found, try to find and delete
        // the counterparty's PDS record directly
        if (!pendingRow) {
          // Attempt to find the counterparty's pending record in their PDS
          try {
            const counterpartyCommunity = await db
              .selectFrom("communities")
              .selectAll()
              .where("did", "=", counterpartyDid)
              .executeTakeFirst();
            if (counterpartyCommunity) {
              const counterpartyAgent = await createCommunityAgent(
                db,
                counterpartyDid,
              );
              let cCursor: string | undefined;
              do {
                const records =
                  await counterpartyAgent.api.com.atproto.repo.listRecords({
                    repo: counterpartyDid,
                    collection: HIERARCHY_COLLECTION,
                    limit: 100,
                    cursor: cCursor,
                  });
                const match = records.data.records.find(
                  (r: any) =>
                    r.value.counterpartyDid === communityDid &&
                    r.value.status === "pending",
                );
                if (match) {
                  const matchRkey = match.uri.split("/").pop() ?? "";
                  if (matchRkey) {
                    await counterpartyAgent.api.com.atproto.repo.deleteRecord({
                      repo: counterpartyDid,
                      collection: HIERARCHY_COLLECTION,
                      rkey: matchRkey,
                    });
                  }
                  break;
                }
                cCursor = records.data.cursor;
              } while (cCursor);
            }
          } catch (deleteError) {
            logger.warn(
              { error: deleteError, communityDid, counterpartyDid },
              "Could not remove counterparty hierarchy record on rejection",
            );
          }
          await auditLog.log({
            communityDid,
            adminDid: agent.assertDid,
            action: "hierarchy.rejected",
            targetDid: counterpartyDid,
          });
          return res.json({
            success: true,
            message: "Hierarchy request rejected",
          });
        }

        // Delete the requester's PDS record (best-effort)
        try {
          const counterpartyCommunity = await db
            .selectFrom("communities")
            .selectAll()
            .where("did", "=", counterpartyDid)
            .executeTakeFirst();
          if (counterpartyCommunity) {
            const counterpartyAgent = await createCommunityAgent(
              db,
              counterpartyDid,
            );
            await counterpartyAgent.api.com.atproto.repo.deleteRecord({
              repo: counterpartyDid,
              collection: HIERARCHY_COLLECTION,
              rkey: pendingRow.requester_record_rkey,
            });
          }
        } catch (deleteError) {
          logger.warn(
            { error: deleteError, communityDid, counterpartyDid },
            "Could not remove counterparty hierarchy record on rejection",
          );
        }

        await pendingTableOp(
          () =>
            db
              .deleteFrom("pending_hierarchy_requests")
              .where("id", "=", pendingRow.id)
              .execute(),
          undefined,
        );

        await auditLog.log({
          communityDid,
          adminDid: agent.assertDid,
          action: "hierarchy.rejected",
          targetDid: counterpartyDid,
        });

        res.json({ success: true, message: "Hierarchy request rejected" });
      } catch (error) {
        logger.error(
          { error, communityDid: req.params.did },
          "Error rejecting hierarchy",
        );
        res.status(500).json({
          error: "Failed to reject hierarchy request",
          details: error instanceof Error ? error.message : "Unknown error",
        });
      }
    },
  );

  // DELETE /communities/:did/hierarchy/:rkey — revoke a hierarchy relationship
  router.delete(
    "/communities/:did/hierarchy/:rkey",
    async (req: Request, res: Response) => {
      try {
        const agent = await getSessionAgent(req, res, oauthClient);
        if (!agent) return res.status(401).json({ error: "Not authenticated" });

        const communityDid = decodeURIComponent(req.params.did);
        const rkey = req.params.rkey;

        const community = await db
          .selectFrom("communities")
          .selectAll()
          .where("did", "=", communityDid)
          .executeTakeFirst();
        if (!community)
          return res.status(404).json({ error: "Community not found" });

        const communityAgent = await requireCommunityAdmin(
          req,
          res,
          communityDid,
          agent.assertDid,
        );
        if (!communityAgent) return;

        // Fetch the record
        let hierarchyRecord: any;
        try {
          const record = await communityAgent.api.com.atproto.repo.getRecord({
            repo: communityDid,
            collection: HIERARCHY_COLLECTION,
            rkey,
          });
          hierarchyRecord = record.data.value;
        } catch {
          return res.status(404).json({ error: "Hierarchy record not found" });
        }

        const counterpartyDid = hierarchyRecord.counterpartyDid;

        // Delete this community's record
        await communityAgent.api.com.atproto.repo.deleteRecord({
          repo: communityDid,
          collection: HIERARCHY_COLLECTION,
          rkey,
        });

        // Best-effort: remove counterparty's record
        try {
          const counterpartyCommunity = await db
            .selectFrom("communities")
            .selectAll()
            .where("did", "=", counterpartyDid)
            .executeTakeFirst();
          if (counterpartyCommunity) {
            const counterpartyAgent = await createCommunityAgent(
              db,
              counterpartyDid,
            );
            let cCursor: string | undefined;
            do {
              const records =
                await counterpartyAgent.api.com.atproto.repo.listRecords({
                  repo: counterpartyDid,
                  collection: HIERARCHY_COLLECTION,
                  limit: 100,
                  cursor: cCursor,
                });
              const match = records.data.records.find(
                (r: any) => r.value.counterpartyDid === communityDid,
              );
              if (match) {
                const counterpartyRkey = match.uri.split("/").pop() ?? "";
                if (counterpartyRkey) {
                  await counterpartyAgent.api.com.atproto.repo.deleteRecord({
                    repo: counterpartyDid,
                    collection: HIERARCHY_COLLECTION,
                    rkey: counterpartyRkey,
                  });
                }
                break;
              }
              cCursor = records.data.cursor;
            } while (cCursor);
          }
        } catch (counterpartyError) {
          logger.warn(
            { error: counterpartyError, communityDid, counterpartyDid },
            "Could not remove counterparty hierarchy record",
          );
        }

        // Clean up pending requests
        await pendingTableOp(
          () =>
            db
              .deleteFrom("pending_hierarchy_requests")
              .where((eb) =>
                eb.or([
                  eb.and([
                    eb("requester_did", "=", communityDid),
                    eb("target_did", "=", counterpartyDid),
                  ]),
                  eb.and([
                    eb("requester_did", "=", counterpartyDid),
                    eb("target_did", "=", communityDid),
                  ]),
                ]),
              )
              .execute(),
          undefined,
        );

        await auditLog.log({
          communityDid,
          adminDid: agent.assertDid,
          action: "hierarchy.revoked",
          targetDid: counterpartyDid,
          metadata: { role: hierarchyRecord.role },
        });

        res.json({ success: true, message: "Hierarchy relationship revoked" });
      } catch (error) {
        logger.error(
          { error, communityDid: req.params.did },
          "Error revoking hierarchy",
        );
        res.status(500).json({
          error: "Failed to revoke hierarchy relationship",
          details: error instanceof Error ? error.message : "Unknown error",
        });
      }
    },
  );

  return router;
}
