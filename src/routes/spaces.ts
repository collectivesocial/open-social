/**
 * Routes for first-class spaces (permissioned data Phase 1).
 *
 * Implements the space methods proposed in the group management methods
 * discussion: listGroupSpaces (GET /:did/spaces), createGroupSpace
 * (POST /:did/spaces), and invite/revokeInvite for invite-only spaces.
 *
 * Mounted under /api/v1/communities and protected by API key auth.
 * Admin-only operations verify the caller via the AT Proto admins record,
 * mirroring the permissions router.
 */

import { Router } from "express";
import type { Kysely } from "kysely";
import type { Database } from "../db";
import {
  createVerifyApiKey,
  type AuthenticatedRequest,
} from "../middleware/auth";
import {
  createSpaceSchema,
  updateSpaceSchema,
  deleteSpaceSchema,
  createSpaceInviteSchema,
  revokeSpaceInviteSchema,
} from "../validation/schemas";
import { createCommunityAgent } from "../services/atproto";
import {
  checkAdmin,
  checkAppVisibility,
  getUserRoles,
} from "../services/permissions";
import {
  SPACE_COLLECTION,
  canReadSpace,
  canWriteSpace,
  getSpace,
  listSpaces,
  parseSpaceCollections,
  type SpaceRow,
} from "../services/spaces";
import { createAuditLogService } from "../services/auditLog";
import { logger } from "../lib/logger";

function serializeSpace(space: SpaceRow) {
  return {
    spaceKey: space.space_key,
    name: space.name,
    description: space.description ?? undefined,
    spaceType: space.space_type,
    readAccess: space.read_access,
    writeAccess: space.write_access,
    collections: parseSpaceCollections(space),
    createdBy: space.created_by,
    createdAt: space.created_at,
    updatedAt: space.updated_at,
  };
}

export function createSpacesRouter(db: Kysely<Database>): Router {
  const router = Router();
  const verifyApiKey = createVerifyApiKey(db);
  const auditLog = createAuditLogService(db);

  async function requireAdmin(
    communityDid: string,
    adminDid: string,
    res: any,
  ): Promise<any | null> {
    const communityAgent = await createCommunityAgent(db, communityDid);
    const isAdm = await checkAdmin(communityAgent, communityDid, adminDid);
    if (!isAdm) {
      res.status(403).json({ error: "Not authorized. Must be an admin." });
      return null;
    }
    return communityAgent;
  }

  async function requireCommunityAndVisibility(
    req: AuthenticatedRequest,
    res: any,
    communityDid: string,
  ): Promise<boolean> {
    const appId = req.app_data?.app_id;
    if (appId) {
      const visibility = await checkAppVisibility(db, communityDid, appId);
      if (!visibility.allowed) {
        res.status(403).json({ error: visibility.reason });
        return false;
      }
    }
    const community = await db
      .selectFrom("communities")
      .select("did")
      .where("did", "=", communityDid)
      .executeTakeFirst();
    if (!community) {
      res.status(404).json({ error: "Community not found" });
      return false;
    }
    return true;
  }

  /**
   * Best-effort mirror of the space definition into the community's repo
   * (collection community.opensocial.space, rkey = spaceKey) so spaces are
   * discoverable on-protocol. The database row is authoritative for
   * enforcement, so a failed repo write only logs a warning.
   */
  async function mirrorSpaceRecord(communityDid: string, space: SpaceRow) {
    try {
      const communityAgent = await createCommunityAgent(db, communityDid);
      await communityAgent.api.com.atproto.repo.putRecord({
        repo: communityDid,
        collection: SPACE_COLLECTION,
        rkey: space.space_key,
        record: {
          $type: SPACE_COLLECTION,
          name: space.name,
          ...(space.description ? { description: space.description } : {}),
          spaceType: space.space_type,
          readAccess: space.read_access,
          writeAccess: space.write_access,
          collections: parseSpaceCollections(space),
          createdBy: space.created_by,
          createdAt:
            space.created_at instanceof Date
              ? space.created_at.toISOString()
              : String(space.created_at),
          updatedAt: new Date().toISOString(),
        },
      });
    } catch (err) {
      logger.warn(
        { error: err, communityDid, spaceKey: space.space_key },
        "Failed to mirror space record to community repo",
      );
    }
  }

  async function deleteSpaceRecord(communityDid: string, spaceKey: string) {
    try {
      const communityAgent = await createCommunityAgent(db, communityDid);
      await communityAgent.api.com.atproto.repo.deleteRecord({
        repo: communityDid,
        collection: SPACE_COLLECTION,
        rkey: spaceKey,
      });
    } catch (err) {
      logger.warn(
        { error: err, communityDid, spaceKey },
        "Failed to delete space record from community repo",
      );
    }
  }

  /** Reject collections already claimed by a different space. */
  async function findCollectionConflict(
    communityDid: string,
    collections: string[],
    excludeSpaceKey?: string,
  ): Promise<{ collection: string; spaceKey: string } | null> {
    const spaces = await listSpaces(db, communityDid);
    for (const space of spaces) {
      if (excludeSpaceKey && space.space_key === excludeSpaceKey) continue;
      const owned = parseSpaceCollections(space);
      const clash = collections.find((c) => owned.includes(c));
      if (clash) return { collection: clash, spaceKey: space.space_key };
    }
    return null;
  }

  // ─── GET /:did/spaces — listGroupSpaces ───────────────────────────────
  router.get(
    "/:did/spaces",
    verifyApiKey,
    async (req: AuthenticatedRequest, res) => {
      const communityDid = decodeURIComponent(req.params.did);
      try {
        if (!(await requireCommunityAndVisibility(req, res, communityDid)))
          return;

        const userDid = req.query.userDid as string | undefined;
        const spaces = await listSpaces(db, communityDid);

        if (!userDid) {
          return res.json({ spaces: spaces.map(serializeSpace) });
        }

        const communityAgent = await createCommunityAgent(db, communityDid);
        const userRoles = await getUserRoles(
          db,
          communityDid,
          userDid,
          communityAgent,
        );
        const withAccess = await Promise.all(
          spaces.map(async (space) => ({
            ...serializeSpace(space),
            canRead: await canReadSpace(db, space, userDid, userRoles),
            canWrite: canWriteSpace(space, userRoles),
          })),
        );
        res.json({ spaces: withAccess });
      } catch (error: any) {
        logger.error({ error, communityDid }, "Error listing spaces");
        res
          .status(500)
          .json({ error: error.message || "Failed to list spaces" });
      }
    },
  );

  // ─── POST /:did/spaces — createGroupSpace ─────────────────────────────
  router.post(
    "/:did/spaces",
    verifyApiKey,
    async (req: AuthenticatedRequest, res) => {
      const communityDid = decodeURIComponent(req.params.did);
      try {
        const parsed = createSpaceSchema.safeParse(req.body);
        if (!parsed.success) {
          return res
            .status(400)
            .json({ error: "Invalid input", details: parsed.error.flatten() });
        }
        const {
          adminDid,
          spaceKey,
          name,
          description,
          spaceType,
          readAccess,
          writeAccess,
          collections,
        } = parsed.data;

        if (!(await requireCommunityAndVisibility(req, res, communityDid)))
          return;
        if (!(await requireAdmin(communityDid, adminDid, res))) return;

        const existing = await getSpace(db, communityDid, spaceKey);
        if (existing) {
          return res
            .status(409)
            .json({ error: `Space '${spaceKey}' already exists` });
        }

        const conflict = await findCollectionConflict(
          communityDid,
          collections,
        );
        if (conflict) {
          return res.status(409).json({
            error: `Collection ${conflict.collection} already belongs to space '${conflict.spaceKey}'`,
          });
        }

        await db
          .insertInto("community_spaces")
          .values({
            community_did: communityDid,
            space_key: spaceKey,
            name,
            description: description ?? null,
            space_type: spaceType ?? SPACE_COLLECTION,
            read_access: readAccess,
            write_access: writeAccess,
            collections: JSON.stringify(collections),
            created_by: adminDid,
          })
          .execute();

        const space = (await getSpace(db, communityDid, spaceKey))!;
        await mirrorSpaceRecord(communityDid, space);

        await auditLog.log({
          communityDid,
          adminDid,
          action: "space.created",
          metadata: { spaceKey, readAccess, writeAccess, collections },
        });

        res.status(201).json({ space: serializeSpace(space) });
      } catch (error: any) {
        logger.error({ error, communityDid }, "Error creating space");
        res
          .status(500)
          .json({ error: error.message || "Failed to create space" });
      }
    },
  );

  // ─── GET /:did/spaces/:spaceKey ───────────────────────────────────────
  router.get(
    "/:did/spaces/:spaceKey",
    verifyApiKey,
    async (req: AuthenticatedRequest, res) => {
      const communityDid = decodeURIComponent(req.params.did);
      const spaceKey = req.params.spaceKey;
      try {
        if (!(await requireCommunityAndVisibility(req, res, communityDid)))
          return;

        const space = await getSpace(db, communityDid, spaceKey);
        if (!space) {
          return res.status(404).json({ error: "Space not found" });
        }

        const userDid = req.query.userDid as string | undefined;
        if (!userDid) {
          return res.json({ space: serializeSpace(space) });
        }

        const communityAgent = await createCommunityAgent(db, communityDid);
        const userRoles = await getUserRoles(
          db,
          communityDid,
          userDid,
          communityAgent,
        );
        res.json({
          space: {
            ...serializeSpace(space),
            canRead: await canReadSpace(db, space, userDid, userRoles),
            canWrite: canWriteSpace(space, userRoles),
          },
        });
      } catch (error: any) {
        logger.error({ error, communityDid, spaceKey }, "Error fetching space");
        res
          .status(500)
          .json({ error: error.message || "Failed to fetch space" });
      }
    },
  );

  // ─── PUT /:did/spaces/:spaceKey ───────────────────────────────────────
  router.put(
    "/:did/spaces/:spaceKey",
    verifyApiKey,
    async (req: AuthenticatedRequest, res) => {
      const communityDid = decodeURIComponent(req.params.did);
      const spaceKey = req.params.spaceKey;
      try {
        const parsed = updateSpaceSchema.safeParse(req.body);
        if (!parsed.success) {
          return res
            .status(400)
            .json({ error: "Invalid input", details: parsed.error.flatten() });
        }
        const {
          adminDid,
          name,
          description,
          readAccess,
          writeAccess,
          collections,
        } = parsed.data;

        if (!(await requireCommunityAndVisibility(req, res, communityDid)))
          return;
        if (!(await requireAdmin(communityDid, adminDid, res))) return;

        const space = await getSpace(db, communityDid, spaceKey);
        if (!space) {
          return res.status(404).json({ error: "Space not found" });
        }

        if (collections) {
          const conflict = await findCollectionConflict(
            communityDid,
            collections,
            spaceKey,
          );
          if (conflict) {
            return res.status(409).json({
              error: `Collection ${conflict.collection} already belongs to space '${conflict.spaceKey}'`,
            });
          }
        }

        await db
          .updateTable("community_spaces")
          .set({
            ...(name !== undefined ? { name } : {}),
            ...(description !== undefined ? { description } : {}),
            ...(readAccess !== undefined ? { read_access: readAccess } : {}),
            ...(writeAccess !== undefined ? { write_access: writeAccess } : {}),
            ...(collections !== undefined
              ? { collections: JSON.stringify(collections) }
              : {}),
            updated_at: new Date(),
          })
          .where("community_did", "=", communityDid)
          .where("space_key", "=", spaceKey)
          .execute();

        const updated = (await getSpace(db, communityDid, spaceKey))!;
        await mirrorSpaceRecord(communityDid, updated);

        await auditLog.log({
          communityDid,
          adminDid,
          action: "space.updated",
          metadata: { spaceKey },
        });

        res.json({ space: serializeSpace(updated) });
      } catch (error: any) {
        logger.error({ error, communityDid, spaceKey }, "Error updating space");
        res
          .status(500)
          .json({ error: error.message || "Failed to update space" });
      }
    },
  );

  // ─── DELETE /:did/spaces/:spaceKey ────────────────────────────────────
  router.delete(
    "/:did/spaces/:spaceKey",
    verifyApiKey,
    async (req: AuthenticatedRequest, res) => {
      const communityDid = decodeURIComponent(req.params.did);
      const spaceKey = req.params.spaceKey;
      try {
        const parsed = deleteSpaceSchema.safeParse(req.body);
        if (!parsed.success) {
          return res
            .status(400)
            .json({ error: "Invalid input", details: parsed.error.flatten() });
        }
        const { adminDid } = parsed.data;

        if (!(await requireCommunityAndVisibility(req, res, communityDid)))
          return;
        if (!(await requireAdmin(communityDid, adminDid, res))) return;

        const space = await getSpace(db, communityDid, spaceKey);
        if (!space) {
          return res.status(404).json({ error: "Space not found" });
        }

        await db
          .deleteFrom("space_invites")
          .where("community_did", "=", communityDid)
          .where("space_key", "=", spaceKey)
          .execute();
        await db
          .deleteFrom("community_spaces")
          .where("community_did", "=", communityDid)
          .where("space_key", "=", spaceKey)
          .execute();
        await deleteSpaceRecord(communityDid, spaceKey);

        await auditLog.log({
          communityDid,
          adminDid,
          action: "space.deleted",
          metadata: { spaceKey },
        });

        res.json({ success: true });
      } catch (error: any) {
        logger.error({ error, communityDid, spaceKey }, "Error deleting space");
        res
          .status(500)
          .json({ error: error.message || "Failed to delete space" });
      }
    },
  );

  // ─── POST /:did/spaces/:spaceKey/invites — invite ─────────────────────
  router.post(
    "/:did/spaces/:spaceKey/invites",
    verifyApiKey,
    async (req: AuthenticatedRequest, res) => {
      const communityDid = decodeURIComponent(req.params.did);
      const spaceKey = req.params.spaceKey;
      try {
        const parsed = createSpaceInviteSchema.safeParse(req.body);
        if (!parsed.success) {
          return res
            .status(400)
            .json({ error: "Invalid input", details: parsed.error.flatten() });
        }
        const { adminDid, inviteeDid } = parsed.data;

        if (!(await requireCommunityAndVisibility(req, res, communityDid)))
          return;
        if (!(await requireAdmin(communityDid, adminDid, res))) return;

        const space = await getSpace(db, communityDid, spaceKey);
        if (!space) {
          return res.status(404).json({ error: "Space not found" });
        }

        await db
          .insertInto("space_invites")
          .values({
            community_did: communityDid,
            space_key: spaceKey,
            invitee_did: inviteeDid,
            invited_by: adminDid,
          })
          .onConflict((oc) =>
            oc
              .columns(["community_did", "space_key", "invitee_did"])
              .doNothing(),
          )
          .execute();

        await auditLog.log({
          communityDid,
          adminDid,
          action: "space.invite.created",
          targetDid: inviteeDid,
          metadata: { spaceKey },
        });

        res.status(201).json({ success: true, spaceKey, inviteeDid });
      } catch (error: any) {
        logger.error(
          { error, communityDid, spaceKey },
          "Error creating space invite",
        );
        res
          .status(500)
          .json({ error: error.message || "Failed to create invite" });
      }
    },
  );

  // ─── GET /:did/spaces/:spaceKey/invites ───────────────────────────────
  router.get(
    "/:did/spaces/:spaceKey/invites",
    verifyApiKey,
    async (req: AuthenticatedRequest, res) => {
      const communityDid = decodeURIComponent(req.params.did);
      const spaceKey = req.params.spaceKey;
      try {
        const adminDid = req.query.adminDid as string | undefined;
        if (!adminDid) {
          return res
            .status(400)
            .json({ error: "adminDid query parameter is required" });
        }

        if (!(await requireCommunityAndVisibility(req, res, communityDid)))
          return;
        if (!(await requireAdmin(communityDid, adminDid, res))) return;

        const space = await getSpace(db, communityDid, spaceKey);
        if (!space) {
          return res.status(404).json({ error: "Space not found" });
        }

        const invites = await db
          .selectFrom("space_invites")
          .selectAll()
          .where("community_did", "=", communityDid)
          .where("space_key", "=", spaceKey)
          .orderBy("created_at", "desc")
          .execute();

        res.json({
          invites: invites.map((i) => ({
            inviteeDid: i.invitee_did,
            invitedBy: i.invited_by,
            createdAt: i.created_at,
          })),
        });
      } catch (error: any) {
        logger.error(
          { error, communityDid, spaceKey },
          "Error listing space invites",
        );
        res
          .status(500)
          .json({ error: error.message || "Failed to list invites" });
      }
    },
  );

  // ─── DELETE /:did/spaces/:spaceKey/invites/:inviteeDid — revokeInvite ─
  router.delete(
    "/:did/spaces/:spaceKey/invites/:inviteeDid",
    verifyApiKey,
    async (req: AuthenticatedRequest, res) => {
      const communityDid = decodeURIComponent(req.params.did);
      const spaceKey = req.params.spaceKey;
      const inviteeDid = decodeURIComponent(req.params.inviteeDid);
      try {
        const parsed = revokeSpaceInviteSchema.safeParse(req.body);
        if (!parsed.success) {
          return res
            .status(400)
            .json({ error: "Invalid input", details: parsed.error.flatten() });
        }
        const { adminDid } = parsed.data;

        if (!(await requireCommunityAndVisibility(req, res, communityDid)))
          return;
        if (!(await requireAdmin(communityDid, adminDid, res))) return;

        const result = await db
          .deleteFrom("space_invites")
          .where("community_did", "=", communityDid)
          .where("space_key", "=", spaceKey)
          .where("invitee_did", "=", inviteeDid)
          .executeTakeFirst();

        if (!result || result.numDeletedRows === BigInt(0)) {
          return res.status(404).json({ error: "Invite not found" });
        }

        await auditLog.log({
          communityDid,
          adminDid,
          action: "space.invite.revoked",
          targetDid: inviteeDid,
          metadata: { spaceKey },
        });

        res.json({ success: true });
      } catch (error: any) {
        logger.error(
          { error, communityDid, spaceKey },
          "Error revoking space invite",
        );
        res
          .status(500)
          .json({ error: error.message || "Failed to revoke invite" });
      }
    },
  );

  return router;
}
