import { Router } from "express";
import { sql, type Kysely } from "kysely";
import type { Database } from "../db";
import {
  createVerifyApiKey,
  type AuthenticatedRequest,
} from "../middleware/auth";
import {
  createCommunityApiKeySchema,
  searchCommunitiesSchema,
  deleteCommunitySchema,
  updateCommunityProfileSchema,
} from "../validation/schemas";
import { parsePagination, encodeCursor, decodeCursor } from "../lib/pagination";
import { isAdminInList, normalizeAdmins } from "../lib/adminUtils";
import { encrypt } from "../lib/crypto";
import { createAuditLogService } from "../services/auditLog";
import { createWebhookService } from "../services/webhook";
import { createCommunityAgent } from "../services/atproto";
import {
  checkAppVisibility,
  seedCollectionPermissions,
} from "../services/permissions";
import { config } from "../config";
import { logger } from "../lib/logger";
import { sanitizeUserContent } from "../lib/sanitize";
import { searchRateLimiter } from "../middleware/rateLimit";
import { logWarning } from "../lib/errors";

/** How long the cached member_count / community_type columns stay fresh. */
const METADATA_CACHE_MS = 24 * 60 * 60 * 1000;

/**
 * Count membershipProof records, capped at 1000 (10 pages) to bound latency
 * and memory. Returns 1000 when the collection continues past the cap, which
 * callers can surface as "1000+".
 */
async function countMembersCapped(
  agent: Awaited<ReturnType<typeof createCommunityAgent>>,
  communityDid: string,
): Promise<number> {
  let count = 0;
  let cursor: string | undefined;
  let iterations = 0;
  do {
    const membersRes = await agent.api.com.atproto.repo.listRecords({
      repo: communityDid,
      collection: "community.opensocial.membershipProof",
      limit: 100,
      cursor,
    });
    count += membersRes.data.records.length;
    cursor = membersRes.data.cursor;
    iterations++;
  } while (cursor && iterations < 10);
  return cursor ? 1000 : count;
}

/**
 * Recount members and refresh the cached member_count column without holding
 * up the caller. Errors are logged and swallowed.
 */
function refreshMemberCountInBackground(
  db: Kysely<Database>,
  agent: Awaited<ReturnType<typeof createCommunityAgent>>,
  communityDid: string,
): void {
  countMembersCapped(agent, communityDid)
    .then((count) =>
      db
        .updateTable("communities")
        .set({ member_count: count, metadata_fetched_at: new Date() })
        .where("did", "=", communityDid)
        .execute(),
    )
    .catch((err) =>
      logWarning("Background member count refresh failed", {
        error: err,
        communityDid,
      }),
    );
}

export function createCommunityRouter(db: Kysely<Database>): Router {
  const router = Router();
  const verifyApiKey = createVerifyApiKey(db);
  const auditLog = createAuditLogService(db);
  const webhooks = createWebhookService(db);

  // Create a community (requires an existing AT Protocol account)
  router.post("/", verifyApiKey, async (req: AuthenticatedRequest, res) => {
    try {
      const parsed = createCommunityApiKeySchema.safeParse(req.body);
      if (!parsed.success) {
        return res
          .status(400)
          .json({ error: "Invalid input", details: parsed.error.flatten() });
      }

      const { did, appPassword, displayName, creatorDid, description } =
        parsed.data;

      // Resolve the DID to get its handle
      let handle: string;
      const pdsHost = config.pdsUrl || "https://bsky.social";
      try {
        const profileRes = await fetch(
          `${pdsHost}/xrpc/app.bsky.actor.getProfile?actor=${encodeURIComponent(did)}`,
        );
        if (profileRes.ok) {
          const profile = (await profileRes.json()) as any;
          handle = profile.handle || did;
        } else {
          handle = did;
        }
      } catch {
        handle = did;
      }

      // Verify credentials by logging in with the app password
      const { BskyAgent } = await import("@atproto/api");
      const bskyAgent = new BskyAgent({ service: pdsHost });
      try {
        await bskyAgent.login({ identifier: did, password: appPassword });
      } catch (e) {
        return res
          .status(400)
          .json({
            error:
              "Invalid DID or app password. Could not authenticate with the provided credentials.",
          });
      }

      // Store in database
      const encryptedPassword = encrypt(appPassword);
      await db
        .insertInto("communities")
        .values({
          did,
          handle,
          display_name: displayName,
          pds_host: pdsHost,
          app_password: encryptedPassword,
        })
        .execute();

      // Create profile and admins records
      try {
        const agent = await createCommunityAgent(db, did);

        // Try to copy creator's Bluesky avatar
        let avatarBlob;
        try {
          const creatorProfileRes = await fetch(
            `${pdsHost}/xrpc/app.bsky.actor.getProfile?actor=${encodeURIComponent(creatorDid)}`,
          );
          if (creatorProfileRes.ok) {
            const creatorProfile = (await creatorProfileRes.json()) as any;
            if (creatorProfile.avatar) {
              const blobRes = await fetch(creatorProfile.avatar);
              if (blobRes.ok) {
                const blobData = new Uint8Array(await blobRes.arrayBuffer());
                const contentType =
                  blobRes.headers.get("content-type") || "image/jpeg";
                const uploadRes = await agent.api.com.atproto.repo.uploadBlob(
                  blobData,
                  {
                    encoding: contentType,
                  },
                );
                avatarBlob = uploadRes.data.blob;
              }
            }
          }
        } catch (e) {
          logger.warn({ error: e }, "Could not copy creator avatar");
        }

        // Create profile record
        await agent.api.com.atproto.repo.putRecord({
          repo: did,
          collection: "community.opensocial.profile",
          rkey: "self",
          record: {
            $type: "community.opensocial.profile",
            displayName,
            description: description ? sanitizeUserContent(description) : "",
            createdAt: new Date().toISOString(),
            type: "open",
            ...(avatarBlob ? { avatar: avatarBlob } : {}),
          },
        });

        // Create admins record
        await agent.api.com.atproto.repo.putRecord({
          repo: did,
          collection: "community.opensocial.admins",
          rkey: "self",
          record: {
            $type: "community.opensocial.admins",
            admins: [{ did: creatorDid, addedAt: new Date().toISOString() }],
          },
        });

        // Create membership proof for creator
        await agent.api.com.atproto.repo.createRecord({
          repo: did,
          collection: "community.opensocial.membershipProof",
          record: {
            $type: "community.opensocial.membershipProof",
            memberDid: creatorDid,
            cid: "",
            confirmedAt: new Date().toISOString(),
          },
        });
      } catch (e) {
        logger.error({ error: e, did }, "Failed to create community records");
      }

      // Enable the system app for this community and seed default permissions
      try {
        await db
          .insertInto("community_app_visibility")
          .values({
            community_did: did,
            app_id: "app_system",
            status: "enabled",
            created_at: new Date(),
            updated_at: new Date(),
          })
          .onConflict((oc) =>
            oc.columns(["community_did", "app_id"]).doNothing(),
          )
          .execute();
        await seedCollectionPermissions(db, did, "app_system");
      } catch (e) {
        logger.warn(
          { error: e, did },
          "Failed to enable system app for new community",
        );
      }

      await auditLog.log({
        communityDid: did,
        adminDid: creatorDid,
        action: "community.created",
        metadata: { handle, displayName },
      });

      res.status(201).json({
        community: {
          did,
          handle,
          displayName,
          pdsHost,
          createdAt: new Date().toISOString(),
        },
        isAdmin: true,
      });
    } catch (error) {
      logger.error({ error }, "Create community error");
      res.status(500).json({ error: "Failed to create community" });
    }
  });

  // List / search communities
  router.get(
    "/",
    verifyApiKey,
    searchRateLimiter,
    async (req: AuthenticatedRequest, res) => {
      try {
        const parsed = searchCommunitiesSchema.safeParse(req.query);
        if (!parsed.success) {
          return res
            .status(400)
            .json({ error: "Invalid query", details: parsed.error.flatten() });
        }

        const { query, userDid, cursor, limit } = parsed.data;
        const offset = cursor ? decodeCursor(cursor) : 0;

        let dbQuery = db.selectFrom("communities").selectAll();

        // Search by name or handle — require at least 3 characters
        const trimmedQuery = query?.trim();
        if (trimmedQuery && trimmedQuery.length >= 3) {
          // Fuzzy search: trigram similarity + ILIKE fallback
          // All user input goes through Kysely parameterised bindings — safe from SQL injection
          dbQuery = dbQuery.where((eb) =>
            eb.or([
              eb(sql`similarity(handle, ${trimmedQuery})`, ">", sql`0.15`),
              eb(
                sql`similarity(display_name, ${trimmedQuery})`,
                ">",
                sql`0.15`,
              ),
              sql<boolean>`handle ILIKE ${"%" + trimmedQuery + "%"}`,
              sql<boolean>`display_name ILIKE ${"%" + trimmedQuery + "%"}`,
            ]),
          );
        } else if (
          trimmedQuery &&
          trimmedQuery.length > 0 &&
          trimmedQuery.length < 3
        ) {
          // Query too short — return empty
          return res.json({ communities: [], cursor: undefined });
        }

        const allCommunities = await dbQuery
          .orderBy(
            trimmedQuery && trimmedQuery.length >= 3
              ? sql`GREATEST(similarity(handle, ${trimmedQuery}), similarity(display_name, ${trimmedQuery}))`
              : sql`COALESCE(member_count, 0)`,
            "desc",
          )
          .offset(offset)
          .limit(limit + 1)
          .execute();

        const hasMore = allCommunities.length > limit;
        const page = hasMore ? allCommunities.slice(0, limit) : allCommunities;

        // Enrich with profile data, admin status, and member count
        // Also filter out communities not visible to the requesting app
        const appId = req.app_data?.app_id;
        const enrichedUnfiltered = await Promise.all(
          page.map(async (community) => {
            // Check app visibility
            if (appId) {
              const visibility = await checkAppVisibility(
                db,
                community.did,
                appId,
              );
              if (!visibility.allowed) return null;
            }

            let isAdmin = false;
            let type = "open";
            let memberCount = 0;

            try {
              const agent = await createCommunityAgent(db, community.did);

              // Get profile
              try {
                const profileRes = await agent.api.com.atproto.repo.getRecord({
                  repo: community.did,
                  collection: "community.opensocial.profile",
                  rkey: "self",
                });
                type = (profileRes.data.value as any)?.type || "open";
              } catch (e) {
                logWarning("Failed to fetch community profile", {
                  error: e,
                  communityDid: community.did,
                });
              }

              // Check admin status
              if (userDid) {
                try {
                  const adminsRes = await agent.api.com.atproto.repo.getRecord({
                    repo: community.did,
                    collection: "community.opensocial.admins",
                    rkey: "self",
                  });
                  const admins = (adminsRes.data.value as any)?.admins || [];
                  isAdmin = isAdminInList(userDid, admins);
                } catch (e) {
                  logWarning("Failed to fetch community admins", {
                    error: e,
                    communityDid: community.did,
                    userDid,
                  });
                }
              }

              // Get member count - use cached value if available and recent
              if (
                community.member_count !== null &&
                community.metadata_fetched_at
              ) {
                const cacheAge =
                  Date.now() - community.metadata_fetched_at.getTime();
                if (cacheAge < METADATA_CACHE_MS) {
                  memberCount = community.member_count;
                }
              }

              // If not cached or stale, fetch but limit to prevent OOM
              if (memberCount === 0) {
                try {
                  memberCount = await countMembersCapped(agent, community.did);
                } catch (e) {
                  logWarning("Failed to count community members", {
                    error: e,
                    communityDid: community.did,
                  });
                }
              }
            } catch (e) {
              logWarning("Failed to create community agent for enrichment", {
                error: e,
                communityDid: community.did,
              });
            }

            // Update metadata cache (fire-and-forget)
            db.updateTable("communities")
              .set({
                community_type: type,
                member_count: memberCount,
                metadata_fetched_at: new Date(),
              })
              .where("did", "=", community.did)
              .execute()
              .catch((err) =>
                logger.warn(
                  { error: err, communityDid: community.did },
                  "Failed to update community metadata cache",
                ),
              );

            return {
              did: community.did,
              handle: community.handle,
              displayName: community.display_name,
              pdsHost: community.pds_host,
              createdAt: community.created_at,
              type,
              isAdmin,
              memberCount,
            };
          }),
        );

        const enriched = enrichedUnfiltered.filter(Boolean);

        res.json({
          communities: enriched,
          cursor: hasMore ? encodeCursor(offset + limit) : undefined,
        });
      } catch (error) {
        logger.error({ error }, "List communities error");
        res.status(500).json({ error: "Failed to list communities" });
      }
    },
  );

  // Get community details
  router.get("/:did", verifyApiKey, async (req: AuthenticatedRequest, res) => {
    const communityDid = decodeURIComponent(req.params.did);
    try {
      const userDid = req.query.userDid as string | undefined;

      const community = await db
        .selectFrom("communities")
        .selectAll()
        .where("did", "=", communityDid)
        .executeTakeFirst();

      if (!community) {
        return res.status(404).json({ error: "Community not found" });
      }

      // App visibility gate
      const appId = req.app_data?.app_id;
      if (appId) {
        const visibility = await checkAppVisibility(db, community.did, appId);
        if (!visibility.allowed) {
          return res.status(403).json({ error: visibility.reason });
        }
      }

      let profile: any = {};
      let admins: any[] = [];
      let isAdmin = false;
      let memberCount = 0;

      try {
        const agent = await createCommunityAgent(db, communityDid);

        try {
          const profileRes = await agent.api.com.atproto.repo.getRecord({
            repo: communityDid,
            collection: "community.opensocial.profile",
            rkey: "self",
          });
          profile = profileRes.data.value as any;
        } catch (e) {
          logWarning("Failed to fetch community profile", {
            error: e,
            communityDid,
          });
        }

        try {
          const adminsRes = await agent.api.com.atproto.repo.getRecord({
            repo: communityDid,
            collection: "community.opensocial.admins",
            rkey: "self",
          });
          admins = (adminsRes.data.value as any)?.admins || [];
          if (userDid) {
            isAdmin = isAdminInList(userDid, admins);
          }
        } catch (e) {
          logWarning("Failed to fetch community admins", {
            error: e,
            communityDid,
            userDid,
          });
        }

        // Member count: serve the cached column and only recount when it's
        // missing (inline, capped) or stale (in the background) — never walk
        // the whole membership collection on the request path.
        try {
          const cacheAge = community.metadata_fetched_at
            ? Date.now() - community.metadata_fetched_at.getTime()
            : Infinity;

          if (community.member_count !== null) {
            memberCount = community.member_count;
            if (cacheAge >= METADATA_CACHE_MS) {
              refreshMemberCountInBackground(db, agent, communityDid);
            }
          } else {
            memberCount = await countMembersCapped(agent, communityDid);
            db.updateTable("communities")
              .set({
                member_count: memberCount,
                metadata_fetched_at: new Date(),
              })
              .where("did", "=", communityDid)
              .execute()
              .catch((err) =>
                logWarning("Failed to cache member count", {
                  error: err,
                  communityDid,
                }),
              );
          }
        } catch (e) {
          logWarning("Failed to count community members", {
            error: e,
            communityDid,
          });
        }
      } catch (e) {
        logWarning("Failed to create community agent", {
          error: e,
          communityDid,
        });
      }

      res.json({
        community: {
          did: community.did,
          handle: community.handle,
          pdsHost: community.pds_host,
          displayName: profile.displayName || community.display_name,
          description: profile.description || "",
          guidelines: profile.guidelines || "",
          type: profile.type || "open",
          avatar: profile.avatar || null,
          banner: profile.banner || null,
          admins: normalizeAdmins(admins).map((a) => a.did),
          createdAt: community.created_at,
          memberCount,
        },
        isAdmin,
      });
    } catch (error) {
      logger.error({ error, communityDid }, "Get community error");
      res.status(500).json({ error: "Failed to get community" });
    }
  });

  /**
   * GET /:did/permissions
   * Return the collection permissions for the requesting app AND the user's
   * effective roles in one response.  This lets the calling app resolve
   * permissions client-side without multiple round-trips.
   *
   * Query params:
   *   userDid  — optional. If provided, the user's roles are included.
   */
  router.get(
    "/:did/permissions",
    verifyApiKey,
    async (req: AuthenticatedRequest, res) => {
      const communityDid = decodeURIComponent(req.params.did);
      try {
        const userDid = req.query.userDid as string | undefined;
        const appId = req.app_data?.app_id;

        if (!appId) {
          return res.status(401).json({ error: "App identification required" });
        }

        // 1. App visibility gate
        const visibility = await checkAppVisibility(db, communityDid, appId);
        if (!visibility.allowed) {
          return res.status(403).json({ error: visibility.reason });
        }

        // 2. Collection permissions for this app + community
        //    First try community-level overrides, then fall back to app defaults.
        let permRows = await db
          .selectFrom("community_app_collection_permissions")
          .selectAll()
          .where("community_did", "=", communityDid)
          .where("app_id", "=", appId)
          .orderBy("collection", "asc")
          .execute();

        let permissions;
        if (permRows.length > 0) {
          permissions = permRows.map((r) => ({
            collection: r.collection,
            canCreate: r.can_create,
            canRead: r.can_read,
            canUpdate: r.can_update,
            canDelete: r.can_delete,
          }));
        } else {
          // No community-level overrides — try app defaults
          const defaultRows = await db
            .selectFrom("app_default_permissions")
            .selectAll()
            .where("app_id", "=", appId)
            .orderBy("collection", "asc")
            .execute();

          permissions = defaultRows.map((r) => ({
            collection: r.collection,
            canCreate: r.default_can_create,
            canRead: r.default_can_read,
            canUpdate: r.default_can_update,
            canDelete: r.default_can_delete,
          }));
        }

        // 3. User roles (if userDid provided)
        let userRoles: string[] = [];
        if (userDid) {
          // Check admin status from PDS
          try {
            const agent = await createCommunityAgent(db, communityDid);

            // Membership
            let isMember = false;
            let cursor: string | undefined;
            do {
              const membersRes = await agent.api.com.atproto.repo.listRecords({
                repo: communityDid,
                collection: "community.opensocial.membershipProof",
                limit: 100,
                cursor,
              });
              isMember = membersRes.data.records.some(
                (r: any) => r.value.memberDid === userDid,
              );
              cursor = membersRes.data.cursor;
            } while (cursor && !isMember);

            if (isMember) userRoles.push("member");

            // Admin
            try {
              const adminsRes = await agent.api.com.atproto.repo.getRecord({
                repo: communityDid,
                collection: "community.opensocial.admins",
                rkey: "self",
              });
              const admins = (adminsRes.data.value as any)?.admins || [];
              if (isAdminInList(userDid, admins)) {
                userRoles.push("admin");
              }
            } catch (e) {
              logWarning("Failed to check admin status", {
                error: e,
                communityDid,
                userDid,
              });
            }
          } catch (e) {
            logger.warn(
              { error: e, communityDid, userDid },
              "Failed to resolve user roles from PDS",
            );
          }

          // Custom roles from DB
          const customRoles = await db
            .selectFrom("community_member_roles")
            .select("role_name")
            .where("community_did", "=", communityDid)
            .where("member_did", "=", userDid)
            .execute();
          for (const r of customRoles) {
            if (!userRoles.includes(r.role_name)) {
              userRoles.push(r.role_name);
            }
          }
        }

        res.json({ permissions, userRoles });
      } catch (error) {
        logger.error({ error, communityDid }, "Get permissions error");
        res.status(500).json({ error: "Failed to get permissions" });
      }
    },
  );

  // Delete community
  router.delete(
    "/:did",
    verifyApiKey,
    async (req: AuthenticatedRequest, res) => {
      const communityDid = decodeURIComponent(req.params.did);
      try {
        const parsed = deleteCommunitySchema.safeParse(req.body);
        if (!parsed.success) {
          return res
            .status(400)
            .json({ error: "Invalid input", details: parsed.error.flatten() });
        }

        const { adminDid } = parsed.data;

        const community = await db
          .selectFrom("communities")
          .selectAll()
          .where("did", "=", communityDid)
          .executeTakeFirst();

        if (!community) {
          return res.status(404).json({ error: "Community not found" });
        }

        // Verify admin status
        try {
          const agent = await createCommunityAgent(db, communityDid);
          const adminsRes = await agent.api.com.atproto.repo.getRecord({
            repo: communityDid,
            collection: "community.opensocial.admins",
            rkey: "self",
          });
          const admins = (adminsRes.data.value as any)?.admins || [];

          if (!isAdminInList(adminDid, admins)) {
            return res
              .status(403)
              .json({ error: "Not an admin of this community" });
          }

          if (normalizeAdmins(admins).length > 1) {
            return res
              .status(400)
              .json({
                error:
                  "Community must have only one admin to be deleted. Remove other admins first.",
              });
          }
        } catch (e) {
          logger.error(
            { error: e, communityDid },
            "Failed to verify admin status",
          );
          return res
            .status(500)
            .json({ error: "Failed to verify admin status" });
        }

        await db
          .deleteFrom("communities")
          .where("did", "=", communityDid)
          .execute();
        await db
          .deleteFrom("pending_members")
          .where("community_did", "=", communityDid)
          .execute();
        await db
          .deleteFrom("community_settings")
          .where("community_did", "=", communityDid)
          .execute();
        await db
          .deleteFrom("community_app_visibility")
          .where("community_did", "=", communityDid)
          .execute();
        await db
          .deleteFrom("community_app_collection_permissions")
          .where("community_did", "=", communityDid)
          .execute();
        await db
          .deleteFrom("community_roles")
          .where("community_did", "=", communityDid)
          .execute();
        await db
          .deleteFrom("community_member_roles")
          .where("community_did", "=", communityDid)
          .execute();

        await auditLog.log({
          communityDid,
          adminDid,
          action: "community.deleted",
        });

        res.json({ success: true });
      } catch (error) {
        logger.error({ error, communityDid }, "Delete community error");
        res.status(500).json({ error: "Failed to delete community" });
      }
    },
  );

  return router;
}
