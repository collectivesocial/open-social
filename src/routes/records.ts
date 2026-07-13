import { Router } from "express";
import type { Kysely } from "kysely";
import type { Database } from "../db";
import {
  createVerifyApiKey,
  type AuthenticatedRequest,
} from "../middleware/auth";
import {
  createRecordSchema,
  updateRecordSchema,
  deleteRecordSchema,
  listRecordsSchema,
  membershipCheckSchema,
} from "../validation/schemas";
import { createCommunityAgent } from "../services/atproto";
import { createWebhookService } from "../services/webhook";
import {
  checkAppVisibility,
  getRequiredRole,
  getUserRoles,
  satisfiesRole,
  type Operation,
} from "../services/permissions";
import { enforceSpaceBoundary } from "../services/spaces";
import { logger } from "../lib/logger";

export function createRecordsRouter(db: Kysely<Database>): Router {
  const router = Router();
  const verifyApiKey = createVerifyApiKey(db);
  const webhooks = createWebhookService(db);

  /**
   * Shared helper: verify app visibility, resolve user roles, and check
   * collection-level permission for the given operation.
   *
   * Returns an object with the communityAgent and userRoles on success,
   * or sends an error response and returns null.
   */
  async function enforcePermission(
    req: AuthenticatedRequest,
    res: any,
    communityDid: string,
    userDid: string,
    collection: string,
    operation: Operation,
  ) {
    const appId = req.app_data?.app_id;
    if (!appId) {
      res.status(401).json({ error: "App identification missing" });
      return null;
    }

    // 1. App visibility gate
    const visibility = await checkAppVisibility(db, communityDid, appId);
    if (!visibility.allowed) {
      res.status(403).json({ error: visibility.reason });
      return null;
    }

    // 2. Community exists?
    const community = await db
      .selectFrom("communities")
      .selectAll()
      .where("did", "=", communityDid)
      .executeTakeFirst();
    if (!community) {
      res.status(404).json({ error: "Community not found" });
      return null;
    }

    const communityAgent = await createCommunityAgent(db, communityDid);

    // 3. Collection permission check
    const requiredRole = await getRequiredRole(
      db,
      communityDid,
      appId,
      collection,
      operation,
    );

    // If no community-level permission row exists, check app defaults,
    // then fall back to 'member' if neither exists.
    let effectiveRequiredRole: string = requiredRole ?? "";
    if (!effectiveRequiredRole) {
      const col = `default_can_${operation}` as const;
      const appDefault = await db
        .selectFrom("app_default_permissions")
        .select(col as any)
        .where("app_id", "=", appId)
        .where("collection", "=", collection)
        .executeTakeFirst();
      effectiveRequiredRole = appDefault ? (appDefault as any)[col] : "member";
    }

    // 4. Resolve user's roles
    const userRoles = await getUserRoles(
      db,
      communityDid,
      userDid,
      communityAgent,
    );

    if (userRoles.length === 0) {
      res.status(403).json({ error: "User is not a member of this community" });
      return null;
    }

    if (!satisfiesRole(userRoles, effectiveRequiredRole)) {
      res.status(403).json({
        error: `Insufficient permissions. Required role: ${effectiveRequiredRole}`,
      });
      return null;
    }

    // 5. Space boundary: if the collection belongs to a space, the space's
    //    policy must also be satisfied (spaces only tighten access).
    const boundary = await enforceSpaceBoundary(
      db,
      communityDid,
      collection,
      operation,
      userDid,
      userRoles,
    );
    if (!boundary.allowed) {
      res.status(403).json({ error: boundary.reason });
      return null;
    }

    return { communityAgent, userRoles };
  }

  /**
   * POST /communities/:did/records
   * Create a record in the community's PDS repo on behalf of a member.
   *
   * Body: { userDid, collection, record, rkey? }
   */
  router.post(
    "/:did/records",
    verifyApiKey,
    async (req: AuthenticatedRequest, res) => {
      const communityDid = decodeURIComponent(req.params.did);
      let userDid: string | undefined;
      let collection: string | undefined;
      try {
        const parsed = createRecordSchema.safeParse(req.body);
        if (!parsed.success) {
          return res
            .status(400)
            .json({ error: "Invalid input", details: parsed.error.flatten() });
        }

        userDid = parsed.data.userDid;
        collection = parsed.data.collection;
        const { record, rkey } = parsed.data;

        const result = await enforcePermission(
          req,
          res,
          communityDid,
          userDid,
          collection,
          "create",
        );
        if (!result) return;

        const { communityAgent } = result;

        const response = await communityAgent.api.com.atproto.repo.createRecord(
          {
            repo: communityDid,
            collection,
            rkey,
            record: {
              $type: collection,
              ...record,
            },
          },
        );

        await webhooks.dispatch("record.created", communityDid, {
          communityDid,
          collection,
          uri: response.data.uri,
          userDid,
        });

        res.status(201).json({
          uri: response.data.uri,
          cid: response.data.cid,
        });
      } catch (error: any) {
        logger.error(
          { error, communityDid, collection, userDid },
          "Error creating community record",
        );
        res
          .status(500)
          .json({ error: error.message || "Failed to create record" });
      }
    },
  );

  /**
   * PUT /communities/:did/records
   * Update a record in the community's PDS repo.
   *
   * Body: { userDid, collection, rkey, record }
   */
  router.put(
    "/:did/records",
    verifyApiKey,
    async (req: AuthenticatedRequest, res) => {
      const communityDid = decodeURIComponent(req.params.did);
      let userDid: string | undefined;
      let collection: string | undefined;
      try {
        const parsed = updateRecordSchema.safeParse(req.body);
        if (!parsed.success) {
          return res
            .status(400)
            .json({ error: "Invalid input", details: parsed.error.flatten() });
        }

        userDid = parsed.data.userDid;
        collection = parsed.data.collection;
        const { rkey, record } = parsed.data;

        const result = await enforcePermission(
          req,
          res,
          communityDid,
          userDid,
          collection,
          "update",
        );
        if (!result) return;

        const { communityAgent } = result;

        const response = await communityAgent.api.com.atproto.repo.putRecord({
          repo: communityDid,
          collection,
          rkey,
          record: {
            $type: collection,
            ...record,
          },
        });

        await webhooks.dispatch("record.updated", communityDid, {
          communityDid,
          collection,
          rkey,
          uri: response.data.uri,
          userDid,
        });

        res.json({
          uri: response.data.uri,
          cid: response.data.cid,
        });
      } catch (error: any) {
        logger.error(
          { error, communityDid, collection, userDid },
          "Error updating community record",
        );
        res
          .status(500)
          .json({ error: error.message || "Failed to update record" });
      }
    },
  );

  /**
   * DELETE /communities/:did/records/:collection/:rkey
   * Delete a record from the community's PDS repo.
   *
   * Query: ?userDid=...
   */
  router.delete(
    "/:did/records/:collection/:rkey",
    verifyApiKey,
    async (req: AuthenticatedRequest, res) => {
      const communityDid = decodeURIComponent(req.params.did);
      const { collection, rkey } = req.params;
      let userDid: string | undefined;
      try {
        const parsed = deleteRecordSchema.safeParse(req.query);
        if (!parsed.success) {
          return res
            .status(400)
            .json({ error: "Invalid query", details: parsed.error.flatten() });
        }

        userDid = parsed.data.userDid;

        const result = await enforcePermission(
          req,
          res,
          communityDid,
          userDid,
          collection,
          "delete",
        );
        if (!result) return;

        const { communityAgent } = result;

        await communityAgent.api.com.atproto.repo.deleteRecord({
          repo: communityDid,
          collection,
          rkey,
        });

        await webhooks.dispatch("record.deleted", communityDid, {
          communityDid,
          collection,
          rkey,
          userDid,
        });

        res.json({ success: true });
      } catch (error: any) {
        logger.error(
          { error, communityDid, collection, userDid },
          "Error deleting community record",
        );
        res
          .status(500)
          .json({ error: error.message || "Failed to delete record" });
      }
    },
  );

  /**
   * GET /communities/:did/records/:collection
   * List records in a specific collection.
   *
   * Now subject to app visibility and read permission checks.
   */
  router.get(
    "/:did/records/:collection",
    verifyApiKey,
    async (req: AuthenticatedRequest, res) => {
      const communityDid = decodeURIComponent(req.params.did);
      const collection = req.params.collection;
      try {
        const parsed = listRecordsSchema.safeParse(req.query);
        if (!parsed.success) {
          return res
            .status(400)
            .json({ error: "Invalid query", details: parsed.error.flatten() });
        }

        const { limit, cursor } = parsed.data;
        const userDid = req.query.userDid as string | undefined;
        const appId = req.app_data?.app_id;

        // App visibility gate
        if (appId) {
          const visibility = await checkAppVisibility(db, communityDid, appId);
          if (!visibility.allowed) {
            return res.status(403).json({ error: visibility.reason });
          }
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

        // Check read permissions if a userDid is supplied and permission rows exist
        if (userDid && appId) {
          const requiredRole = await getRequiredRole(
            db,
            communityDid,
            appId,
            collection,
            "read",
          );
          if (requiredRole) {
            const userRoles = await getUserRoles(
              db,
              communityDid,
              userDid,
              communityAgent,
            );
            if (!satisfiesRole(userRoles, requiredRole)) {
              return res
                .status(403)
                .json({
                  error: `Insufficient permissions to read this collection. Required role: ${requiredRole}`,
                });
            }
          }
        }

        const response = await communityAgent.api.com.atproto.repo.listRecords({
          repo: communityDid,
          collection,
          limit,
          cursor,
        });

        res.json({
          records: response.data.records,
          cursor: response.data.cursor || undefined,
        });
      } catch (error: any) {
        logger.error(
          { error, communityDid, collection },
          "Error listing community records",
        );
        res
          .status(500)
          .json({ error: error.message || "Failed to list records" });
      }
    },
  );

  /**
   * GET /communities/:did/records/:collection/:rkey
   * Get a specific record.
   */
  router.get(
    "/:did/records/:collection/:rkey",
    verifyApiKey,
    async (req: AuthenticatedRequest, res) => {
      const communityDid = decodeURIComponent(req.params.did);
      const { collection, rkey } = req.params;
      try {
        const userDid = req.query.userDid as string | undefined;
        const appId = req.app_data?.app_id;

        // App visibility gate
        if (appId) {
          const visibility = await checkAppVisibility(db, communityDid, appId);
          if (!visibility.allowed) {
            return res.status(403).json({ error: visibility.reason });
          }
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

        // Check read permissions if a userDid is supplied and permission rows exist
        if (userDid && appId) {
          const requiredRole = await getRequiredRole(
            db,
            communityDid,
            appId,
            collection,
            "read",
          );
          if (requiredRole) {
            const userRoles = await getUserRoles(
              db,
              communityDid,
              userDid,
              communityAgent,
            );
            if (!satisfiesRole(userRoles, requiredRole)) {
              return res
                .status(403)
                .json({
                  error: `Insufficient permissions to read this collection. Required role: ${requiredRole}`,
                });
            }
          }
        }

        const response = await communityAgent.api.com.atproto.repo.getRecord({
          repo: communityDid,
          collection,
          rkey,
        });

        res.json({
          uri: response.data.uri,
          cid: response.data.cid,
          value: response.data.value,
        });
      } catch (error: any) {
        logger.error(
          { error, communityDid, collection, rkey },
          "Error getting community record",
        );
        res
          .status(500)
          .json({ error: error.message || "Failed to get record" });
      }
    },
  );

  return router;
}
