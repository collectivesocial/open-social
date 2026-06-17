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
import { getCommunitySpace } from "../services/spaces";
import { listRoleAssignments, listRoleDefinitions } from "../services/roles";
import {
  listMemberships,
  isMember,
  recordMembership,
  applyMembershipVisibility,
} from "../services/membership";
import {
  createCommunityPost,
  createMemberPost,
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

  // Roster from membership records (source of truth) + roles overlaid.
  router.get("/:did/members", async (req, res) => {
    const communityDid = decodeURIComponent(req.params.did);
    try {
      const mgmt = await getCommunitySpace(db, communityDid, "management");
      if (!mgmt) return res.json({ members: [], provisioned: false });

      const [roster, assignments] = await Promise.all([
        listMemberships(db, communityDid),
        listRoleAssignments(db, communityDid),
      ]);
      const rolesByDid = new Map<string, string[]>();
      for (const a of assignments) {
        const list = rolesByDid.get(a.subject) ?? [];
        list.push(a.role);
        rolesByDid.set(a.subject, list);
      }
      // Act-as viewer is always a member; default visibility = internal.
      const visible = applyMembershipVisibility(
        roster,
        { isMember: true, isAdmin: true },
        "internal",
      );
      res.json({
        provisioned: true,
        members: visible.map((m) => ({
          did: m.subject,
          roles: rolesByDid.get(m.subject) ?? [],
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

  // Post as the acting member by default; asCommunity=true posts on behalf of
  // the community (role-gated by the "post" capability).
  router.post("/:did/posts", async (req, res) => {
    const communityDid = decodeURIComponent(req.params.did);
    const { actorDid, text, asCommunity } = req.body ?? {};
    if (!actorDid || typeof text !== "string" || text.trim().length === 0) {
      return res.status(400).json({ error: "actorDid and text are required" });
    }
    try {
      const result = asCommunity
        ? await createCommunityPost(db, communityDid, actorDid, text.trim())
        : await createMemberPost(db, communityDid, actorDid, text.trim());
      res.status(201).json(result);
    } catch (err) {
      if (err instanceof NotAllowedError) {
        return res.status(403).json({ error: err.message });
      }
      logger.error({ err, communityDid }, "poc/posts create failed");
      res.status(500).json({ error: "Failed to create post" });
    }
  });

  // Contract: isCommunityMember (authenticated-user-scoped via ?actorDid).
  router.get("/:did/isMember", async (req, res) => {
    const communityDid = decodeURIComponent(req.params.did);
    const actorDid = String(req.query.actorDid ?? "");
    if (!actorDid) return res.status(400).json({ error: "actorDid required" });
    try {
      const member = await isMember(db, communityDid, actorDid);
      const assignments = await listRoleAssignments(db, communityDid);
      const role = assignments.find((a) => a.subject === actorDid)?.role;
      res.json({ isMember: member, ...(role ? { role } : {}) });
    } catch (err) {
      logger.error({ err, communityDid }, "poc/isMember failed");
      res.status(500).json({ error: "Failed" });
    }
  });

  // Contract: joinCommunity (open join for the PoC).
  router.post("/:did/join", async (req, res) => {
    const communityDid = decodeURIComponent(req.params.did);
    const { actorDid } = req.body ?? {};
    if (!actorDid) return res.status(400).json({ error: "actorDid required" });
    try {
      await recordMembership(db, communityDid, actorDid);
      res.status(201).json({ status: "active" });
    } catch (err) {
      logger.error({ err, communityDid }, "poc/join failed");
      res.status(500).json({ error: "Failed to join" });
    }
  });

  // Contract: listCommunitySpaces.
  router.get("/:did/spaces", async (req, res) => {
    const communityDid = decodeURIComponent(req.params.did);
    const rows = await db
      .selectFrom("community_spaces")
      .select(["kind", "space_uri"])
      .where("community_did", "=", communityDid)
      .execute();
    res.json({ spaces: rows });
  });

  return router;
}
