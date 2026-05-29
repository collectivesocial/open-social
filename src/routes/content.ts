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
import {
  checkAppVisibility,
  getRequiredRole,
  getUserRoles,
  satisfiesRole,
  type Operation,
} from "../services/permissions";
import { logger } from "../lib/logger";
import { resolveDocumentWebUrl } from "../lib/documentUrl";
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
const SHARED_CONTENT_COLLECTION = "community.opensocial.sharedContent";
const SHARED_DOCUMENT_COLLECTION = "community.opensocial.sharedDocument";
const SHARED_EVENT_COLLECTION = "community.opensocial.sharedEvent";
const CALENDAR_EVENT_COLLECTION = "community.lexicon.calendar.event";

// ── Helpers for parsing community.lexicon.calendar.event records ────────────
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

function extractEventUrl(uris: unknown): string | undefined {
  if (!Array.isArray(uris) || uris.length === 0) return undefined;
  const eventPage = uris.find(
    (u: any) =>
      typeof u?.uri === "string" &&
      u.uri.startsWith("http") &&
      typeof u?.name === "string" &&
      /event/i.test(u.name) &&
      !/image/i.test(u.name),
  );
  if (eventPage) return (eventPage as any).uri;
  const fallback = uris.find(
    (u: any) =>
      typeof u?.uri === "string" &&
      u.uri.startsWith("http") &&
      !/\.(jpg|jpeg|png|gif|webp|svg)(\?|$)/i.test(u.uri),
  );
  if (fallback) return (fallback as any).uri;
  return undefined;
}

// ── Legacy validation schema (keep for backward compat) ─────────────────────
const shareContentSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("document"),
    documentUri: z.string().min(1).startsWith("at://"),
    documentCid: z.string().min(1),
    title: z.string().min(1).max(512),
    path: z.string().max(1024).optional(),
  }),
  z.object({
    type: z.literal("event"),
    documentUri: z.string().min(1).startsWith("at://"),
    documentCid: z.string().min(1),
    title: z.string().min(1).max(512),
    path: z.string().max(1024).optional(),
    startsAt: z.string().datetime().optional(),
    endsAt: z.string().datetime().optional(),
    location: z.string().max(512).optional(),
    mode: z.enum(["in-person", "virtual", "hybrid"]).optional(),
  }),
]);

// ── New validation schemas ──────────────────────────────────────────────────
const shareDocumentSchema = z.object({
  documentUri: z.string().min(1).startsWith("at://"),
  documentCid: z.string().min(1),
  title: z.string().min(1).max(512),
  url: z.string().url(),
  source: z.string().min(1).max(128),
  author: z.string().min(1).startsWith("did:"),
  path: z.string().max(1024).optional(),
  tags: z.array(z.string().max(128)).max(32).optional(),
});

const shareEventSchema = z.object({
  documentUri: z.string().min(1).startsWith("at://"),
  documentCid: z.string().min(1),
  title: z.string().min(1).max(512),
  url: z.string().url(),
  source: z.string().min(1).max(128),
  author: z.string().min(1).startsWith("did:"),
  path: z.string().max(1024).optional(),
  startsAt: z.string().datetime().optional(),
  endsAt: z.string().datetime().optional(),
  location: z.string().max(512).optional(),
  mode: z.enum(["in-person", "virtual", "hybrid"]).optional(),
});

const listContentSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().optional(),
});

export function createContentRouter(
  oauthClient: NodeOAuthClient,
  db: Kysely<Database>,
): Router {
  const router = Router({ mergeParams: true });
  const webhooks = createWebhookService(db);

  /**
   * Shared helper: verify system app visibility and check collection-level
   * permission for the given operation using the system app's permissions.
   */
  async function enforceContentPermission(
    res: Response,
    communityDid: string,
    userDid: string,
    operation: Operation,
    collection: string = SHARED_CONTENT_COLLECTION,
  ) {
    // 1. App visibility gate (system app)
    const visibility = await checkAppVisibility(
      db,
      communityDid,
      SYSTEM_APP_ID,
    );
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
      SYSTEM_APP_ID,
      collection,
      operation,
    );

    // Fall back to app defaults, then 'member'
    let effectiveRequiredRole: string = requiredRole ?? "";
    if (!effectiveRequiredRole) {
      const col = `default_can_${operation}` as const;
      const appDefault = await db
        .selectFrom("app_default_permissions")
        .select(col as any)
        .where("app_id", "=", SYSTEM_APP_ID)
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

    return { communityAgent, userRoles };
  }

  /**
   * GET /communities/:did/content/check?documentUri=...
   * Check if a specific document is already shared with this community.
   * Returns the shared record info if found (rkey, sharedBy), or null.
   */
  router.get("/check", async (req: Request, res: Response) => {
    const communityDid = decodeURIComponent(req.params.did);
    const documentUri = req.query.documentUri as string;
    try {
      if (!documentUri) {
        return res
          .status(400)
          .json({ error: "documentUri query parameter is required" });
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

      let cursor: string | undefined;
      do {
        const response = await communityAgent.api.com.atproto.repo.listRecords({
          repo: communityDid,
          collection: SHARED_CONTENT_COLLECTION,
          limit: 100,
          cursor,
        });

        const match = response.data.records.find(
          (r: any) => r.value.documentUri === documentUri,
        );

        if (match) {
          return res.json({
            shared: true,
            rkey: match.uri.split("/").pop(),
            sharedBy: (match.value as any).sharedBy,
            sharedAt: (match.value as any).sharedAt,
          });
        }

        cursor = response.data.cursor;
      } while (cursor);

      res.json({ shared: false });
    } catch (error: any) {
      logger.error({ error, communityDid }, "Error checking shared content");
      res
        .status(500)
        .json({ error: error.message || "Failed to check shared content" });
    }
  });

  /**
   * GET /communities/:did/content
   * List all shared content for a community. Paginated via cursor.
   */
  router.get("/", async (req: Request, res: Response) => {
    const communityDid = decodeURIComponent(req.params.did);
    try {
      const parsed = listContentSchema.safeParse(req.query);
      if (!parsed.success) {
        return res
          .status(400)
          .json({ error: "Invalid query", details: parsed.error.flatten() });
      }

      const { limit, cursor } = parsed.data;

      // Verify community exists
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
        collection: SHARED_CONTENT_COLLECTION,
        limit,
        cursor,
      });

      const records = response.data.records.map((r: any) => ({
        uri: r.uri,
        rkey: r.uri.split("/").pop(),
        type: r.value.type,
        documentUri: r.value.documentUri,
        documentCid: r.value.documentCid,
        sharedBy: r.value.sharedBy,
        title: r.value.title,
        path: r.value.path,
        sharedAt: r.value.sharedAt,
        // Event-specific cached fields (present only when type=event)
        ...(r.value.startsAt !== undefined
          ? { startsAt: r.value.startsAt }
          : {}),
        ...(r.value.endsAt !== undefined ? { endsAt: r.value.endsAt } : {}),
        ...(r.value.location !== undefined
          ? { location: r.value.location }
          : {}),
        ...(r.value.mode !== undefined ? { mode: r.value.mode } : {}),
      }));

      // Also list native community.lexicon.calendar.event records owned by the
      // community's repo, and merge them in as event entries. These are events
      // the community itself created (rather than shared wrappers around an
      // external event), and historically didn't show up on the events page.
      // Only fetched on the first page (no cursor) so we don't interleave
      // pagination across two collections.
      const nativeEventRecords: any[] = [];
      if (!cursor) {
        try {
          let nativeCursor: string | undefined;
          do {
            const nativeRes =
              await communityAgent.api.com.atproto.repo.listRecords({
                repo: communityDid,
                collection: CALENDAR_EVENT_COLLECTION,
                limit: 100,
                cursor: nativeCursor,
              });
            nativeEventRecords.push(...nativeRes.data.records);
            nativeCursor = nativeRes.data.cursor;
          } while (nativeCursor);
        } catch (err: any) {
          // Collection may simply not exist on this repo; that's fine.
          logger.debug(
            { err, communityDid },
            "No native community.lexicon.calendar.event records (or fetch failed)",
          );
        }
      }

      // Build a set of source event URIs already referenced by sharedContent
      // entries so we don't show duplicates when a native event has also been
      // explicitly shared.
      const sharedSourceUris = new Set<string>();
      for (const r of records) {
        if (r.type === "event" && typeof r.documentUri === "string") {
          sharedSourceUris.add(r.documentUri);
        }
      }

      const nativeEvents = nativeEventRecords
        .filter((r: any) => !sharedSourceUris.has(r.uri))
        .map((r: any) => {
          const v = r.value || {};
          const rkey = r.uri.split("/").pop();
          return {
            uri: r.uri,
            rkey,
            type: "event" as const,
            documentUri: r.uri,
            documentCid: r.cid,
            sharedBy: communityDid,
            title: (v.name as string) || "Untitled Event",
            // For native events, prefer an external URL when available so
            // the events page can link out.
            ...(extractEventUrl(v.uris)
              ? { eventUrl: extractEventUrl(v.uris) }
              : {}),
            sharedAt:
              (v.createdAt as string) ||
              (v.startsAt as string) ||
              new Date(0).toISOString(),
            ...(v.startsAt ? { startsAt: v.startsAt as string } : {}),
            ...(v.endsAt ? { endsAt: v.endsAt as string } : {}),
            ...(extractEventLocation(v.locations)
              ? { location: extractEventLocation(v.locations) }
              : {}),
            ...(v.mode !== undefined ? { mode: parseEventMode(v.mode) } : {}),
            isNative: true as const,
          };
        });

      // Resolve author handles from documentUri DIDs for URL building. Native
      // events are owned by the community itself, so include the community DID
      // too (it may already be the same as documentUri's author).
      const authorDids = new Set<string>();
      for (const r of records) {
        if (r.documentUri?.startsWith("at://")) {
          const did = r.documentUri.replace("at://", "").split("/")[0];
          if (did) authorDids.add(did);
        }
      }
      for (const r of nativeEvents) {
        const did = r.documentUri.replace("at://", "").split("/")[0];
        if (did) authorDids.add(did);
      }

      const handleMap = new Map<string, string>();
      await Promise.all(
        [...authorDids].map(async (did) => {
          try {
            const res = await fetch(
              `https://public.api.bsky.app/xrpc/app.bsky.actor.getProfile?actor=${encodeURIComponent(did)}`,
            );
            if (res.ok) {
              const data = (await res.json()) as any;
              if (data.handle) handleMap.set(did, data.handle);
            }
          } catch {
            /* skip unresolvable */
          }
        }),
      );

      const attachHandle = (r: any) => {
        if (!r.documentUri?.startsWith("at://")) return r;
        const did = r.documentUri.replace("at://", "").split("/")[0];
        const authorHandle = did ? (handleMap.get(did) ?? null) : null;
        return { ...r, authorHandle };
      };

      const enrichedRecords = [
        ...records.map(attachHandle),
        ...nativeEvents.map(attachHandle),
      ];

      // Resolve canonical web URLs for document records via their
      // site.standard.publication, so the client doesn't have to guess the URL
      // from the author's handle (which is wrong for Leaflet and other
      // standard.site publications hosted on their own domain).
      await Promise.all(
        enrichedRecords.map(async (r) => {
          if (r.type !== "document" || !r.documentUri) return;
          const url = await resolveDocumentWebUrl(r.documentUri);
          if (url) r.url = url;
        }),
      );

      res.json({
        records: enrichedRecords,
        cursor: response.data.cursor,
      });
    } catch (error: any) {
      logger.error({ error, communityDid }, "Error listing shared content");
      res
        .status(500)
        .json({ error: error.message || "Failed to list shared content" });
    }
  });

  /**
   * POST /communities/:did/content
   * Share content with a community. Requires member role.
   *
   * Body: { userDid, type, documentUri, documentCid, title, path? }
   */
  router.post("/", async (req: Request, res: Response) => {
    const communityDid = decodeURIComponent(req.params.did);
    try {
      const agent = await getSessionAgent(req, res, oauthClient);
      if (!agent) {
        return res.status(401).json({ error: "Not authenticated" });
      }
      const userDid = agent.assertDid;

      const parsed = shareContentSchema.safeParse(req.body);
      if (!parsed.success) {
        return res
          .status(400)
          .json({ error: "Invalid input", details: parsed.error.flatten() });
      }

      const { type, documentUri, documentCid, title, path } = parsed.data;

      const result = await enforceContentPermission(
        res,
        communityDid,
        userDid,
        "create",
      );
      if (!result) return;

      const { communityAgent } = result;

      // Duplicate check: ensure this document hasn't already been shared
      let cursor: string | undefined;
      let isDuplicate = false;
      do {
        const existing = await communityAgent.api.com.atproto.repo.listRecords({
          repo: communityDid,
          collection: SHARED_CONTENT_COLLECTION,
          limit: 100,
          cursor,
        });
        isDuplicate = existing.data.records.some(
          (r: any) => r.value.documentUri === documentUri,
        );
        cursor = existing.data.cursor;
      } while (cursor && !isDuplicate);

      if (isDuplicate) {
        return res.status(409).json({
          error: "This content has already been shared with this community",
        });
      }

      // Build event-specific fields if type=event
      const eventFields: Record<string, string> = {};
      if (parsed.data.type === "event") {
        const { startsAt, endsAt, location, mode } = parsed.data;
        if (startsAt) eventFields.startsAt = startsAt;
        if (endsAt) eventFields.endsAt = endsAt;
        if (location) eventFields.location = location;
        if (mode) eventFields.mode = mode;
      }

      const response = await communityAgent.api.com.atproto.repo.createRecord({
        repo: communityDid,
        collection: SHARED_CONTENT_COLLECTION,
        record: {
          $type: SHARED_CONTENT_COLLECTION,
          type,
          documentUri,
          documentCid,
          sharedBy: userDid,
          title,
          ...(path ? { path } : {}),
          ...eventFields,
          sharedAt: new Date().toISOString(),
        },
      });

      await webhooks.dispatch("record.created", communityDid, {
        communityDid,
        collection: SHARED_CONTENT_COLLECTION,
        uri: response.data.uri,
        userDid,
      });

      res.status(201).json({
        uri: response.data.uri,
        cid: response.data.cid,
      });
    } catch (error: any) {
      logger.error({ error, communityDid }, "Error sharing content");
      res
        .status(500)
        .json({ error: error.message || "Failed to share content" });
    }
  });

  /**
   * DELETE /communities/:did/content/:rkey
   * Remove shared content. Allowed if:
   *  - The authenticated user is the original sharer (owner can always revoke), OR
   *  - The authenticated user has delete permission on the collection.
   */
  router.delete("/:rkey", async (req: Request, res: Response) => {
    const communityDid = decodeURIComponent(req.params.did);
    const rkey = req.params.rkey;
    try {
      const agent = await getSessionAgent(req, res, oauthClient);
      if (!agent) {
        return res.status(401).json({ error: "Not authenticated" });
      }
      const userDid = agent.assertDid;

      // Verify community exists
      const community = await db
        .selectFrom("communities")
        .selectAll()
        .where("did", "=", communityDid)
        .executeTakeFirst();
      if (!community) {
        return res.status(404).json({ error: "Community not found" });
      }

      const communityAgent = await createCommunityAgent(db, communityDid);

      // Fetch the record to check ownership
      let isOwner = false;
      try {
        const record = await communityAgent.api.com.atproto.repo.getRecord({
          repo: communityDid,
          collection: SHARED_CONTENT_COLLECTION,
          rkey,
        });
        isOwner = (record.data.value as any).sharedBy === userDid;
      } catch {
        return res.status(404).json({ error: "Shared content not found" });
      }

      // If not the owner, fall back to permission check
      if (!isOwner) {
        const result = await enforceContentPermission(
          res,
          communityDid,
          userDid,
          "delete",
        );
        if (!result) return;
      }

      await communityAgent.api.com.atproto.repo.deleteRecord({
        repo: communityDid,
        collection: SHARED_CONTENT_COLLECTION,
        rkey,
      });

      await webhooks.dispatch("record.deleted", communityDid, {
        communityDid,
        collection: SHARED_CONTENT_COLLECTION,
        rkey,
        userDid,
      });

      res.json({ success: true });
    } catch (error: any) {
      logger.error(
        { error, communityDid, rkey },
        "Error removing shared content",
      );
      res
        .status(500)
        .json({ error: error.message || "Failed to remove shared content" });
    }
  });

  // ─── Shared helpers ─────────────────────────────────────────────────────

  /**
   * Check if a documentUri already exists in one or more collections.
   * Returns true if a duplicate is found.
   */
  async function isDuplicateAcrossCollections(
    communityAgent: any,
    communityDid: string,
    documentUri: string,
    collections: string[],
  ): Promise<boolean> {
    for (const collection of collections) {
      let cursor: string | undefined;
      do {
        const existing = await communityAgent.api.com.atproto.repo.listRecords({
          repo: communityDid,
          collection,
          limit: 100,
          cursor,
        });
        const found = existing.data.records.some(
          (r: any) => r.value.documentUri === documentUri,
        );
        if (found) return true;
        cursor = existing.data.cursor;
      } while (cursor);
    }
    return false;
  }

  // ─── POST /communities/:did/content/documents ───────────────────────────
  router.post("/documents", async (req: Request, res: Response) => {
    const communityDid = decodeURIComponent(req.params.did);
    try {
      const agent = await getSessionAgent(req, res, oauthClient);
      if (!agent) {
        return res.status(401).json({ error: "Not authenticated" });
      }
      const userDid = agent.assertDid;

      const parsed = shareDocumentSchema.safeParse(req.body);
      if (!parsed.success) {
        return res
          .status(400)
          .json({ error: "Invalid input", details: parsed.error.flatten() });
      }

      const {
        documentUri,
        documentCid,
        title,
        url,
        source,
        author,
        path,
        tags,
      } = parsed.data;

      const result = await enforceContentPermission(
        res,
        communityDid,
        userDid,
        "create",
        SHARED_DOCUMENT_COLLECTION,
      );
      if (!result) return;

      const { communityAgent } = result;

      // Duplicate check across new + legacy collections
      const duplicate = await isDuplicateAcrossCollections(
        communityAgent,
        communityDid,
        documentUri,
        [SHARED_DOCUMENT_COLLECTION, SHARED_CONTENT_COLLECTION],
      );
      if (duplicate) {
        return res.status(409).json({
          error: "This document has already been shared with this community",
        });
      }

      const response = await communityAgent.api.com.atproto.repo.createRecord({
        repo: communityDid,
        collection: SHARED_DOCUMENT_COLLECTION,
        record: {
          $type: SHARED_DOCUMENT_COLLECTION,
          documentUri,
          documentCid,
          sharedBy: userDid,
          title,
          url,
          source,
          author,
          ...(path ? { path } : {}),
          ...(tags && tags.length > 0 ? { tags } : {}),
          sharedAt: new Date().toISOString(),
        },
      });

      await webhooks.dispatch("record.created", communityDid, {
        communityDid,
        collection: SHARED_DOCUMENT_COLLECTION,
        uri: response.data.uri,
        userDid,
      });

      res.status(201).json({
        uri: response.data.uri,
        cid: response.data.cid,
      });
    } catch (error: any) {
      logger.error({ error, communityDid }, "Error sharing document");
      res
        .status(500)
        .json({ error: error.message || "Failed to share document" });
    }
  });

  // ─── POST /communities/:did/content/events ─────────────────────────────
  router.post("/events", async (req: Request, res: Response) => {
    const communityDid = decodeURIComponent(req.params.did);
    try {
      const agent = await getSessionAgent(req, res, oauthClient);
      if (!agent) {
        return res.status(401).json({ error: "Not authenticated" });
      }
      const userDid = agent.assertDid;

      const parsed = shareEventSchema.safeParse(req.body);
      if (!parsed.success) {
        return res
          .status(400)
          .json({ error: "Invalid input", details: parsed.error.flatten() });
      }

      const {
        documentUri,
        documentCid,
        title,
        url,
        source,
        author,
        path,
        startsAt,
        endsAt,
        location,
        mode,
      } = parsed.data;

      const result = await enforceContentPermission(
        res,
        communityDid,
        userDid,
        "create",
        SHARED_EVENT_COLLECTION,
      );
      if (!result) return;

      const { communityAgent } = result;

      // Duplicate check across new + legacy collections
      const duplicate = await isDuplicateAcrossCollections(
        communityAgent,
        communityDid,
        documentUri,
        [SHARED_EVENT_COLLECTION, SHARED_CONTENT_COLLECTION],
      );
      if (duplicate) {
        return res.status(409).json({
          error: "This event has already been shared with this community",
        });
      }

      const eventFields: Record<string, string> = {};
      if (startsAt) eventFields.startsAt = startsAt;
      if (endsAt) eventFields.endsAt = endsAt;
      if (location) eventFields.location = location;
      if (mode) eventFields.mode = mode;

      const response = await communityAgent.api.com.atproto.repo.createRecord({
        repo: communityDid,
        collection: SHARED_EVENT_COLLECTION,
        record: {
          $type: SHARED_EVENT_COLLECTION,
          documentUri,
          documentCid,
          sharedBy: userDid,
          title,
          url,
          source,
          author,
          ...(path ? { path } : {}),
          ...eventFields,
          sharedAt: new Date().toISOString(),
        },
      });

      await webhooks.dispatch("record.created", communityDid, {
        communityDid,
        collection: SHARED_EVENT_COLLECTION,
        uri: response.data.uri,
        userDid,
      });

      res.status(201).json({
        uri: response.data.uri,
        cid: response.data.cid,
      });
    } catch (error: any) {
      logger.error({ error, communityDid }, "Error sharing event");
      res.status(500).json({ error: error.message || "Failed to share event" });
    }
  });

  // ─── GET /communities/:did/content/documents ─\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
  router.get("/documents", async (req: Request, res: Response) => {
    const communityDid = decodeURIComponent(req.params.did);
    try {
      const parsed = listContentSchema.safeParse(req.query);
      if (!parsed.success) {
        return res
          .status(400)
          .json({ error: "Invalid query", details: parsed.error.flatten() });
      }

      const { limit, cursor } = parsed.data;

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
        collection: SHARED_DOCUMENT_COLLECTION,
        limit,
        cursor,
      });

      const records = response.data.records.map((r: any) => ({
        uri: r.uri,
        rkey: r.uri.split("/").pop(),
        documentUri: r.value.documentUri,
        documentCid: r.value.documentCid,
        sharedBy: r.value.sharedBy,
        title: r.value.title,
        url: r.value.url,
        source: r.value.source,
        author: r.value.author,
        path: r.value.path,
        tags: r.value.tags,
        sharedAt: r.value.sharedAt,
      }));

      res.json({
        records,
        cursor: response.data.cursor,
      });
    } catch (error: any) {
      logger.error({ error, communityDid }, "Error listing shared documents");
      res
        .status(500)
        .json({ error: error.message || "Failed to list shared documents" });
    }
  });

  // ─── GET /communities/:did/content/events ───────────────────────────────
  router.get("/events", async (req: Request, res: Response) => {
    const communityDid = decodeURIComponent(req.params.did);
    try {
      const parsed = listContentSchema.safeParse(req.query);
      if (!parsed.success) {
        return res
          .status(400)
          .json({ error: "Invalid query", details: parsed.error.flatten() });
      }

      const { limit, cursor } = parsed.data;

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
        collection: SHARED_EVENT_COLLECTION,
        limit,
        cursor,
      });

      const records = response.data.records.map((r: any) => ({
        uri: r.uri,
        rkey: r.uri.split("/").pop(),
        documentUri: r.value.documentUri,
        documentCid: r.value.documentCid,
        sharedBy: r.value.sharedBy,
        title: r.value.title,
        url: r.value.url,
        source: r.value.source,
        author: r.value.author,
        path: r.value.path,
        startsAt: r.value.startsAt,
        endsAt: r.value.endsAt,
        location: r.value.location,
        mode: r.value.mode,
        sharedAt: r.value.sharedAt,
      }));

      res.json({
        records,
        cursor: response.data.cursor,
      });
    } catch (error: any) {
      logger.error({ error, communityDid }, "Error listing shared events");
      res
        .status(500)
        .json({ error: error.message || "Failed to list shared events" });
    }
  });

  // ─── DELETE /communities/:did/content/documents/:rkey ───────────────────
  router.delete("/documents/:rkey", async (req: Request, res: Response) => {
    const communityDid = decodeURIComponent(req.params.did);
    const rkey = req.params.rkey;
    try {
      const agent = await getSessionAgent(req, res, oauthClient);
      if (!agent) {
        return res.status(401).json({ error: "Not authenticated" });
      }
      const userDid = agent.assertDid;

      const community = await db
        .selectFrom("communities")
        .selectAll()
        .where("did", "=", communityDid)
        .executeTakeFirst();
      if (!community) {
        return res.status(404).json({ error: "Community not found" });
      }

      const communityAgent = await createCommunityAgent(db, communityDid);

      let isOwner = false;
      try {
        const record = await communityAgent.api.com.atproto.repo.getRecord({
          repo: communityDid,
          collection: SHARED_DOCUMENT_COLLECTION,
          rkey,
        });
        isOwner = (record.data.value as any).sharedBy === userDid;
      } catch {
        return res.status(404).json({ error: "Shared document not found" });
      }

      if (!isOwner) {
        const result = await enforceContentPermission(
          res,
          communityDid,
          userDid,
          "delete",
          SHARED_DOCUMENT_COLLECTION,
        );
        if (!result) return;
      }

      await communityAgent.api.com.atproto.repo.deleteRecord({
        repo: communityDid,
        collection: SHARED_DOCUMENT_COLLECTION,
        rkey,
      });

      await webhooks.dispatch("record.deleted", communityDid, {
        communityDid,
        collection: SHARED_DOCUMENT_COLLECTION,
        rkey,
        userDid,
      });

      res.json({ success: true });
    } catch (error: any) {
      logger.error(
        { error, communityDid, rkey },
        "Error removing shared document",
      );
      res
        .status(500)
        .json({ error: error.message || "Failed to remove shared document" });
    }
  });

  // ─── DELETE /communities/:did/content/events/:rkey ──────────────────────
  router.delete("/events/:rkey", async (req: Request, res: Response) => {
    const communityDid = decodeURIComponent(req.params.did);
    const rkey = req.params.rkey;
    try {
      const agent = await getSessionAgent(req, res, oauthClient);
      if (!agent) {
        return res.status(401).json({ error: "Not authenticated" });
      }
      const userDid = agent.assertDid;

      const community = await db
        .selectFrom("communities")
        .selectAll()
        .where("did", "=", communityDid)
        .executeTakeFirst();
      if (!community) {
        return res.status(404).json({ error: "Community not found" });
      }

      const communityAgent = await createCommunityAgent(db, communityDid);

      let isOwner = false;
      try {
        const record = await communityAgent.api.com.atproto.repo.getRecord({
          repo: communityDid,
          collection: SHARED_EVENT_COLLECTION,
          rkey,
        });
        isOwner = (record.data.value as any).sharedBy === userDid;
      } catch {
        return res.status(404).json({ error: "Shared event not found" });
      }

      if (!isOwner) {
        const result = await enforceContentPermission(
          res,
          communityDid,
          userDid,
          "delete",
          SHARED_EVENT_COLLECTION,
        );
        if (!result) return;
      }

      await communityAgent.api.com.atproto.repo.deleteRecord({
        repo: communityDid,
        collection: SHARED_EVENT_COLLECTION,
        rkey,
      });

      await webhooks.dispatch("record.deleted", communityDid, {
        communityDid,
        collection: SHARED_EVENT_COLLECTION,
        rkey,
        userDid,
      });

      res.json({ success: true });
    } catch (error: any) {
      logger.error(
        { error, communityDid, rkey },
        "Error removing shared event",
      );
      res
        .status(500)
        .json({ error: error.message || "Failed to remove shared event" });
    }
  });

  return router;
}
