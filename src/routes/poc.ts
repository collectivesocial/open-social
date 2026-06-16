/**
 * Dev-only PoC router for experimenting with permissioned-space communities.
 *
 * These endpoints intentionally have NO auth and take the acting DID explicitly
 * (`actorDid`) so the open-social-web "act as" switcher can experiment as the
 * seeded admin vs member without a real OAuth login. Mounted only outside
 * production (see index.ts). The interesting logic — role-gated posting read
 * from the management space — is the real thing; only the HTTP auth is stubbed.
 */
import { Router } from "express";
import type { Kysely } from "kysely";
import type { Database } from "../db";
import { getCommunitySpace, getSpaceClient } from "../services/spaces";
import { listRoleAssignments, listRoleDefinitions } from "../services/roles";
import {
  createCommunityPost,
  listCommunityPosts,
  NotAllowedError,
} from "../services/posts";
import { logger } from "../lib/logger";

export function createPocRouter(db: Kysely<Database>): Router {
  const router = Router();

  // List communities so the UI can pick one.
  router.get("/", async (_req, res) => {
    const rows = await db
      .selectFrom("communities")
      .select(["did", "handle", "display_name"])
      .execute();
    res.json({ communities: rows });
  });

  // Space member list joined with each member's roles (from the management space).
  router.get("/:did/members", async (req, res) => {
    const communityDid = decodeURIComponent(req.params.did);
    try {
      const mgmt = await getCommunitySpace(db, communityDid, "management");
      if (!mgmt) return res.json({ members: [], provisioned: false });
      const client = await getSpaceClient(db, communityDid);
      const { members } = await client.getMembers(mgmt);
      const assignments = await listRoleAssignments(db, communityDid);
      const rolesByDid = new Map<string, string[]>();
      for (const a of assignments) {
        const list = rolesByDid.get(a.subject) ?? [];
        list.push(a.role);
        rolesByDid.set(a.subject, list);
      }
      res.json({
        provisioned: true,
        members: members.map((m) => ({
          did: m.did,
          roles: rolesByDid.get(m.did) ?? [],
        })),
      });
    } catch (err) {
      logger.error({ err, communityDid }, "poc/members failed");
      res.status(500).json({ error: "Failed to load members" });
    }
  });

  // Role definitions + assignments (governance records in the management space).
  router.get("/:did/roles", async (req, res) => {
    const communityDid = decodeURIComponent(req.params.did);
    try {
      const [definitions, assignments] = await Promise.all([
        listRoleDefinitions(db, communityDid),
        listRoleAssignments(db, communityDid),
      ]);
      res.json({ definitions, assignments });
    } catch (err) {
      logger.error({ err, communityDid }, "poc/roles failed");
      res.status(500).json({ error: "Failed to load roles" });
    }
  });

  router.get("/:did/posts", async (req, res) => {
    const communityDid = decodeURIComponent(req.params.did);
    try {
      res.json({ posts: await listCommunityPosts(db, communityDid) });
    } catch (err) {
      logger.error({ err, communityDid }, "poc/posts list failed");
      res.status(500).json({ error: "Failed to load posts" });
    }
  });

  // Post on behalf of the community as `actorDid`. Role-gated.
  router.post("/:did/posts", async (req, res) => {
    const communityDid = decodeURIComponent(req.params.did);
    const { actorDid, text } = req.body ?? {};
    if (!actorDid || typeof text !== "string" || text.trim().length === 0) {
      return res.status(400).json({ error: "actorDid and text are required" });
    }
    try {
      const result = await createCommunityPost(
        db,
        communityDid,
        actorDid,
        text.trim(),
      );
      res.status(201).json(result);
    } catch (err) {
      if (err instanceof NotAllowedError) {
        return res.status(403).json({ error: err.message });
      }
      logger.error({ err, communityDid }, "poc/posts create failed");
      res.status(500).json({ error: "Failed to create post" });
    }
  });

  return router;
}
