import { Agent } from "@atproto/api";
import { Router, type Request, type Response } from "express";
import { getIronSession } from "iron-session";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { NodeOAuthClient } from "@atproto/oauth-client-node";
import type { Kysely } from "kysely";
import type { Database } from "../db";
import { config } from "../config";
import { createCommunityAgent } from "../services/atproto";
import { createWebhookService } from "../services/webhook";
import { createAuditLogService } from "../services/auditLog";
import {
  checkAppVisibility,
  getRequiredRole,
  getUserRoles,
  satisfiesRole,
  type Operation,
} from "../services/permissions";
import { logger } from "../lib/logger";
import { z } from "zod";

type Session = { did?: string };

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
  try {
    const oauthSession = await oauthClient.restore(session.did);
    return oauthSession ? new Agent(oauthSession) : null;
  } catch (err) {
    logger.warn({ error: err }, "OAuth restore failed");
    await session.destroy();
    return null;
  }
}

const SYSTEM_APP_ID = "app_system";
export const ANNOUNCEMENT_COLLECTION = "community.opensocial.announcement";

// ── Validation schemas ───────────────────────────────────────────────────────
const createAnnouncementSchema = z.object({
  title: z.string().min(1).max(300),
  text: z.string().min(1).max(10000),
  pinned: z.boolean().optional(),
});

const updateAnnouncementSchema = z.object({
  title: z.string().min(1).max(300).optional(),
  text: z.string().min(1).max(10000).optional(),
  pinned: z.boolean().optional(),
});

const listAnnouncementsSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().optional(),
});

function mapAnnouncement(r: any) {
  return {
    uri: r.uri,
    cid: r.cid,
    rkey: r.uri.split("/").pop(),
    title: r.value.title,
    text: r.value.text,
    createdBy: r.value.createdBy,
    createdAt: r.value.createdAt,
    updatedAt: r.value.updatedAt,
    pinned: r.value.pinned ?? false,
  };
}

/**
 * Group-only announcement space.
 *
 * Announcements live in the community's repo under
 * `community.opensocial.announcement`. By default only admins can
 * create/update/delete, and — unlike shared content — **reads are
 * permission-checked too** (member role required), which is what makes
 * this space group-only. Both sides of that boundary are configurable
 * per community through the collection-permission tables.
 */
export function createAnnouncementsRouter(
  oauthClient: NodeOAuthClient,
  db: Kysely<Database>,
): Router {
  const router = Router({ mergeParams: true });
  const webhooks = createWebhookService(db);
  const auditLog = createAuditLogService(db);

  /**
   * Verify system-app visibility and check the collection-level permission
   * for the given operation. Mirrors enforceContentPermission in content.ts.
   */
  async function enforceAnnouncementPermission(
    res: Response,
    communityDid: string,
    userDid: string,
    operation: Operation,
  ) {
    const visibility = await checkAppVisibility(
      db,
      communityDid,
      SYSTEM_APP_ID,
    );
    if (!visibility.allowed) {
      res.status(403).json({ error: visibility.reason });
      return null;
    }

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

    const requiredRole = await getRequiredRole(
      db,
      communityDid,
      SYSTEM_APP_ID,
      ANNOUNCEMENT_COLLECTION,
      operation,
    );

    // Fall back to app defaults, then 'admin' (announcements are a
    // restricted space — fail closed, unlike shared content).
    let effectiveRequiredRole: string = requiredRole ?? "";
    if (!effectiveRequiredRole) {
      const col = `default_can_${operation}` as const;
      const appDefault = await db
        .selectFrom("app_default_permissions")
        .select(col as any)
        .where("app_id", "=", SYSTEM_APP_ID)
        .where("collection", "=", ANNOUNCEMENT_COLLECTION)
        .executeTakeFirst();
      effectiveRequiredRole = appDefault
        ? (appDefault as any)[col]
        : operation === "read"
          ? "member"
          : "admin";
    }

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

    return { communityAgent, userRoles };
  }

  // ─── POST /communities/:did/announcements ────────────────────────────────
  router.post("/", async (req: Request, res: Response) => {
    const communityDid = decodeURIComponent(req.params.did);
    try {
      const agent = await getSessionAgent(req, res, oauthClient);
      if (!agent) {
        return res.status(401).json({ error: "Not authenticated" });
      }
      const userDid = agent.assertDid;

      const parsed = createAnnouncementSchema.safeParse(req.body);
      if (!parsed.success) {
        return res
          .status(400)
          .json({ error: "Invalid input", details: parsed.error.flatten() });
      }
      const { title, text, pinned } = parsed.data;

      const result = await enforceAnnouncementPermission(
        res,
        communityDid,
        userDid,
        "create",
      );
      if (!result) return;

      const { communityAgent } = result;

      const response = await communityAgent.api.com.atproto.repo.createRecord({
        repo: communityDid,
        collection: ANNOUNCEMENT_COLLECTION,
        record: {
          $type: ANNOUNCEMENT_COLLECTION,
          title,
          text,
          createdBy: userDid,
          createdAt: new Date().toISOString(),
          ...(pinned !== undefined ? { pinned } : {}),
        },
      });

      await auditLog.log({
        communityDid,
        adminDid: userDid,
        action: "announcement.created",
        metadata: { uri: response.data.uri, title },
      });

      await webhooks.dispatch("record.created", communityDid, {
        communityDid,
        collection: ANNOUNCEMENT_COLLECTION,
        uri: response.data.uri,
        userDid,
      });

      res.status(201).json({
        uri: response.data.uri,
        cid: response.data.cid,
      });
    } catch (error: any) {
      logger.error({ error, communityDid }, "Error creating announcement");
      res
        .status(500)
        .json({ error: error.message || "Failed to create announcement" });
    }
  });

  // ─── GET /communities/:did/announcements ─────────────────────────────────
  // Group-only: unlike shared content, listing requires an authenticated
  // session with read permission (member by default).
  router.get("/", async (req: Request, res: Response) => {
    const communityDid = decodeURIComponent(req.params.did);
    try {
      const agent = await getSessionAgent(req, res, oauthClient);
      if (!agent) {
        return res.status(401).json({ error: "Not authenticated" });
      }
      const userDid = agent.assertDid;

      const parsed = listAnnouncementsSchema.safeParse(req.query);
      if (!parsed.success) {
        return res
          .status(400)
          .json({ error: "Invalid query", details: parsed.error.flatten() });
      }
      const { limit, cursor } = parsed.data;

      const result = await enforceAnnouncementPermission(
        res,
        communityDid,
        userDid,
        "read",
      );
      if (!result) return;

      const { communityAgent } = result;

      const response = await communityAgent.api.com.atproto.repo.listRecords({
        repo: communityDid,
        collection: ANNOUNCEMENT_COLLECTION,
        limit,
        cursor,
      });

      const records = response.data.records.map(mapAnnouncement);
      // Pinned announcements first within the page, newest first otherwise
      // (listRecords already returns reverse-chronological order).
      records.sort((a: any, b: any) => Number(b.pinned) - Number(a.pinned));

      res.json({
        records,
        cursor: response.data.cursor,
      });
    } catch (error: any) {
      logger.error({ error, communityDid }, "Error listing announcements");
      res
        .status(500)
        .json({ error: error.message || "Failed to list announcements" });
    }
  });

  // ─── GET /communities/:did/announcements/:rkey ───────────────────────────
  router.get("/:rkey", async (req: Request, res: Response) => {
    const communityDid = decodeURIComponent(req.params.did);
    const rkey = req.params.rkey;
    try {
      const agent = await getSessionAgent(req, res, oauthClient);
      if (!agent) {
        return res.status(401).json({ error: "Not authenticated" });
      }
      const userDid = agent.assertDid;

      const result = await enforceAnnouncementPermission(
        res,
        communityDid,
        userDid,
        "read",
      );
      if (!result) return;

      const { communityAgent } = result;

      try {
        const record = await communityAgent.api.com.atproto.repo.getRecord({
          repo: communityDid,
          collection: ANNOUNCEMENT_COLLECTION,
          rkey,
        });
        res.json(mapAnnouncement(record.data));
      } catch {
        res.status(404).json({ error: "Announcement not found" });
      }
    } catch (error: any) {
      logger.error(
        { error, communityDid, rkey },
        "Error fetching announcement",
      );
      res
        .status(500)
        .json({ error: error.message || "Failed to fetch announcement" });
    }
  });

  // ─── PUT /communities/:did/announcements/:rkey ───────────────────────────
  router.put("/:rkey", async (req: Request, res: Response) => {
    const communityDid = decodeURIComponent(req.params.did);
    const rkey = req.params.rkey;
    try {
      const agent = await getSessionAgent(req, res, oauthClient);
      if (!agent) {
        return res.status(401).json({ error: "Not authenticated" });
      }
      const userDid = agent.assertDid;

      const parsed = updateAnnouncementSchema.safeParse(req.body);
      if (!parsed.success) {
        return res
          .status(400)
          .json({ error: "Invalid input", details: parsed.error.flatten() });
      }
      if (Object.keys(parsed.data).length === 0) {
        return res.status(400).json({ error: "No fields to update" });
      }

      const result = await enforceAnnouncementPermission(
        res,
        communityDid,
        userDid,
        "update",
      );
      if (!result) return;

      const { communityAgent } = result;

      let existing: any;
      try {
        const record = await communityAgent.api.com.atproto.repo.getRecord({
          repo: communityDid,
          collection: ANNOUNCEMENT_COLLECTION,
          rkey,
        });
        existing = record.data.value;
      } catch {
        return res.status(404).json({ error: "Announcement not found" });
      }

      const updated = {
        ...existing,
        ...(parsed.data.title !== undefined
          ? { title: parsed.data.title }
          : {}),
        ...(parsed.data.text !== undefined ? { text: parsed.data.text } : {}),
        ...(parsed.data.pinned !== undefined
          ? { pinned: parsed.data.pinned }
          : {}),
        updatedAt: new Date().toISOString(),
      };

      const response = await communityAgent.api.com.atproto.repo.putRecord({
        repo: communityDid,
        collection: ANNOUNCEMENT_COLLECTION,
        rkey,
        record: updated,
      });

      await auditLog.log({
        communityDid,
        adminDid: userDid,
        action: "announcement.updated",
        metadata: { uri: response.data.uri },
      });

      await webhooks.dispatch("record.updated", communityDid, {
        communityDid,
        collection: ANNOUNCEMENT_COLLECTION,
        uri: response.data.uri,
        userDid,
      });

      res.json({
        uri: response.data.uri,
        cid: response.data.cid,
      });
    } catch (error: any) {
      logger.error(
        { error, communityDid, rkey },
        "Error updating announcement",
      );
      res
        .status(500)
        .json({ error: error.message || "Failed to update announcement" });
    }
  });

  // ─── DELETE /communities/:did/announcements/:rkey ────────────────────────
  router.delete("/:rkey", async (req: Request, res: Response) => {
    const communityDid = decodeURIComponent(req.params.did);
    const rkey = req.params.rkey;
    try {
      const agent = await getSessionAgent(req, res, oauthClient);
      if (!agent) {
        return res.status(401).json({ error: "Not authenticated" });
      }
      const userDid = agent.assertDid;

      const result = await enforceAnnouncementPermission(
        res,
        communityDid,
        userDid,
        "delete",
      );
      if (!result) return;

      const { communityAgent } = result;

      try {
        await communityAgent.api.com.atproto.repo.getRecord({
          repo: communityDid,
          collection: ANNOUNCEMENT_COLLECTION,
          rkey,
        });
      } catch {
        return res.status(404).json({ error: "Announcement not found" });
      }

      await communityAgent.api.com.atproto.repo.deleteRecord({
        repo: communityDid,
        collection: ANNOUNCEMENT_COLLECTION,
        rkey,
      });

      await auditLog.log({
        communityDid,
        adminDid: userDid,
        action: "announcement.deleted",
        metadata: { rkey },
      });

      await webhooks.dispatch("record.deleted", communityDid, {
        communityDid,
        collection: ANNOUNCEMENT_COLLECTION,
        rkey,
        userDid,
      });

      res.json({ success: true });
    } catch (error: any) {
      logger.error(
        { error, communityDid, rkey },
        "Error deleting announcement",
      );
      res
        .status(500)
        .json({ error: error.message || "Failed to delete announcement" });
    }
  });

  return router;
}
