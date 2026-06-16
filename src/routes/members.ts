import { Router } from "express";
import type { Kysely } from "kysely";
import type { Database } from "../db";
import {
  createVerifyApiKey,
  type AuthenticatedRequest,
} from "../middleware/auth";
import {
  joinCommunitySchema,
  listMembersSchema,
  promoteMemberSchema,
  demoteMemberSchema,
  removeMemberSchema,
  leaveCommunitySchema,
  approveMemberSchema,
  rejectMemberSchema,
  transferAdminSchema,
  auditLogQuerySchema,
} from "../validation/schemas";
import { parsePagination, encodeCursor, decodeCursor } from "../lib/pagination";
import {
  isAdminInList,
  getOriginalAdminDid,
  normalizeAdmins,
} from "../lib/adminUtils";
import { createCommunityAgent } from "../services/atproto";
import {
  writeMembershipProof,
  removeMembershipProof,
  listMembershipProofs,
  hasMembershipProof,
} from "../services/membership";
import { createAuditLogService } from "../services/auditLog";
import { createWebhookService } from "../services/webhook";
import { config } from "../config";
import { logger } from "../lib/logger";
import {
  memberListRateLimiter,
  auditLogRateLimiter,
} from "../middleware/rateLimit";
import { logWarning } from "../lib/errors";

/**
 * Resolve a Bluesky profile to get handle, display name, and avatar.
 * Falls back gracefully if the user's PDS is unreachable.
 */
async function resolveProfile(did: string): Promise<{
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

/**
 * Check community type from its profile record.
 */
async function getCommunityType(
  agent: any,
  communityDid: string,
): Promise<string> {
  try {
    const profileRes = await agent.api.com.atproto.repo.getRecord({
      repo: communityDid,
      collection: "community.opensocial.profile",
      rkey: "self",
    });
    return (profileRes.data.value as any)?.type || "open";
  } catch {
    return "open";
  }
}

export function createMemberRouter(db: Kysely<Database>): Router {
  const router = Router();
  const verifyApiKey = createVerifyApiKey(db);
  const auditLog = createAuditLogService(db);
  const webhooks = createWebhookService(db);

  // ─── JOIN COMMUNITY ────────────────────────────────────────────────
  // For open communities: creates membershipProof immediately
  // For admin-approved communities: adds to pending_members table
  router.post(
    "/:did/members/join",
    verifyApiKey,
    async (req: AuthenticatedRequest, res) => {
      const communityDid = decodeURIComponent(req.params.did);
      let userDid: string | undefined;
      try {
        const parsed = joinCommunitySchema.safeParse(req.body);
        if (!parsed.success) {
          return res
            .status(400)
            .json({ error: "Invalid input", details: parsed.error.flatten() });
        }

        userDid = parsed.data.userDid;
        const { membershipCid } = parsed.data;

        const community = await db
          .selectFrom("communities")
          .selectAll()
          .where("did", "=", communityDid)
          .executeTakeFirst();

        if (!community) {
          return res.status(404).json({ error: "Community not found" });
        }

        const communityAgent = await createCommunityAgent(db, communityDid);

        // Check if already a member
        const alreadyMember = await hasMembershipProof(
          db,
          communityDid,
          userDid,
          communityAgent,
        );

        if (alreadyMember) {
          return res
            .status(409)
            .json({ error: "Already a member of this community" });
        }

        const communityType = await getCommunityType(
          communityAgent,
          communityDid,
        );

        if (communityType === "admin-approved") {
          // Check if already pending
          const existing = await db
            .selectFrom("pending_members")
            .selectAll()
            .where("community_did", "=", communityDid)
            .where("user_did", "=", userDid)
            .where("status", "=", "pending")
            .executeTakeFirst();

          if (existing) {
            return res
              .status(409)
              .json({ error: "Join request already pending" });
          }

          await db
            .insertInto("pending_members")
            .values({
              community_did: communityDid,
              user_did: userDid,
              status: "pending",
            })
            .execute();

          return res.status(202).json({
            status: "pending",
            message:
              "Join request submitted. An admin must approve your request.",
          });
        }

        // Open community — create membershipProof immediately
        await writeMembershipProof(
          db,
          communityDid,
          userDid,
          membershipCid || "",
        );

        await auditLog.log({
          communityDid,
          adminDid: userDid,
          action: "member.joined",
          targetDid: userDid,
        });

        await webhooks.dispatch("member.joined", communityDid, {
          communityDid,
          memberDid: userDid,
        });

        res.status(201).json({
          status: "joined",
          message: "Successfully joined the community",
          membership: {
            communityDid,
            memberDid: userDid,
            joinedAt: new Date().toISOString(),
          },
        });
      } catch (error) {
        logger.error({ error, communityDid, userDid }, "Join community error");
        res.status(500).json({ error: "Failed to join community" });
      }
    },
  );

  // ─── LEAVE COMMUNITY ──────────────────────────────────────────────
  router.post(
    "/:did/members/leave",
    verifyApiKey,
    async (req: AuthenticatedRequest, res) => {
      const communityDid = decodeURIComponent(req.params.did);
      let userDid: string | undefined;
      try {
        const parsed = leaveCommunitySchema.safeParse(req.body);
        if (!parsed.success) {
          return res
            .status(400)
            .json({ error: "Invalid input", details: parsed.error.flatten() });
        }

        userDid = parsed.data.userDid;

        const community = await db
          .selectFrom("communities")
          .selectAll()
          .where("did", "=", communityDid)
          .executeTakeFirst();

        if (!community) {
          return res.status(404).json({ error: "Community not found" });
        }

        const communityAgent = await createCommunityAgent(db, communityDid);

        // Check if user is the original admin
        try {
          const adminsRes = await communityAgent.api.com.atproto.repo.getRecord(
            {
              repo: communityDid,
              collection: "community.opensocial.admins",
              rkey: "self",
            },
          );
          const admins = (adminsRes.data.value as any)?.admins || [];
          const originalAdmin = getOriginalAdminDid(admins);
          if (userDid === originalAdmin) {
            return res.status(403).json({
              error:
                "The primary admin cannot leave. Transfer admin role first.",
            });
          }

          // If leaving user is a non-primary admin, remove from admin list too
          if (isAdminInList(userDid, admins)) {
            const updatedAdmins = normalizeAdmins(admins).filter(
              (a) => a.did !== userDid,
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
        } catch (e) {
          logWarning("Failed to remove admin from admin list when leaving", {
            error: e,
            communityDid,
            userDid,
          });
        }

        // Find and delete the membershipProof
        const removed = await removeMembershipProof(db, communityDid, userDid);
        if (!removed) {
          return res
            .status(404)
            .json({ error: "Not a member of this community" });
        }

        await webhooks.dispatch("member.left", communityDid, {
          communityDid,
          memberDid: userDid,
        });

        res.json({
          success: true,
          message:
            "Left the community. Your membership record in your PDS is no longer verified.",
        });
      } catch (error) {
        logger.error({ error, communityDid, userDid }, "Leave community error");
        res.status(500).json({ error: "Failed to leave community" });
      }
    },
  );

  // ─── LIST MEMBERS (paginated, with profiles) ──────────────────────
  router.get(
    "/:did/members",
    verifyApiKey,
    memberListRateLimiter,
    async (req: AuthenticatedRequest, res) => {
      const communityDid = decodeURIComponent(req.params.did);
      try {
        const parsed = listMembersSchema.safeParse(req.query);
        if (!parsed.success) {
          return res
            .status(400)
            .json({ error: "Invalid query", details: parsed.error.flatten() });
        }

        const { adminDid, search, cursor, limit } = parsed.data;
        const isPublic = parsed.data.public === "true";

        const community = await db
          .selectFrom("communities")
          .selectAll()
          .where("did", "=", communityDid)
          .executeTakeFirst();

        if (!community) {
          return res.status(404).json({ error: "Community not found" });
        }

        const communityAgent = await createCommunityAgent(db, communityDid);

        // For non-public requests, verify admin status
        if (!isPublic && adminDid) {
          try {
            const adminsRes =
              await communityAgent.api.com.atproto.repo.getRecord({
                repo: communityDid,
                collection: "community.opensocial.admins",
                rkey: "self",
              });
            const admins = (adminsRes.data.value as any)?.admins || [];
            if (!isAdminInList(adminDid, admins)) {
              return res
                .status(403)
                .json({ error: "Not authorized. Must be an admin." });
            }
          } catch (e) {
            logger.error(
              { error: e, communityDid, adminDid },
              "Failed to verify admin status",
            );
            return res
              .status(500)
              .json({ error: "Failed to verify admin status" });
          }
        }

        // Fetch membershipProof records with reasonable limit
        // Don't load all members into memory - fetch enough to satisfy pagination + buffer
        const offset = cursor ? decodeCursor(cursor) : 0;
        const maxFetch = Math.min(offset + limit * 3, 1000); // Cap at 1000 members
        const allProofs = await listMembershipProofs(
          db,
          communityDid,
          maxFetch,
        );

        // Get admins list
        let admins: any[] = [];
        try {
          const adminsRes = await communityAgent.api.com.atproto.repo.getRecord(
            {
              repo: communityDid,
              collection: "community.opensocial.admins",
              rkey: "self",
            },
          );
          admins = (adminsRes.data.value as any)?.admins || [];
        } catch (e) {
          logWarning("Failed to fetch admins list", { error: e, communityDid });
        }

        // Build member list
        let members = allProofs.map((record: any) => {
          const memberDid = record.value.memberDid || null;
          return {
            uri: record.uri,
            did: memberDid,
            confirmedAt: record.value.confirmedAt || null,
            isAdmin: memberDid ? isAdminInList(memberDid, admins) : false,
          };
        });

        // Backfill: admins whose DID is in the admins record but missing from
        // proof memberDid (legacy proofs created without memberDid).
        const proofDids = new Set(members.map((m) => m.did).filter(Boolean));
        const missingAdmins = admins.filter((a: any) => {
          const did = typeof a === "string" ? a : a.did;
          return did && !proofDids.has(did);
        });

        for (const admin of missingAdmins) {
          const adminDid = typeof admin === "string" ? admin : admin.did;
          const orphanProof = allProofs.find((p: any) => !p.value.memberDid);
          if (orphanProof) {
            const idx = members.findIndex((m) => m.uri === orphanProof.uri);
            if (idx !== -1) {
              members[idx] = { ...members[idx], did: adminDid, isAdmin: true };
            }
          } else {
            members.push({
              uri: "",
              did: adminDid,
              confirmedAt: null,
              isAdmin: true,
            });
          }
        }

        // Filter by DID search
        if (search) {
          members = members.filter(
            (m) => m.did && m.did.toLowerCase().includes(search.toLowerCase()),
          );
        }

        // Apply pagination (offset already calculated above)
        const page = members.slice(offset, offset + limit);
        // We might not have fetched all members, so indicate there may be more
        const hasMore =
          allProofs.length >= maxFetch || offset + limit < members.length;
        const total = members.length; // This is partial count when limited

        // Resolve Bluesky profiles for this page, and include visible roles
        const enriched = await Promise.all(
          page.map(async (member) => {
            if (!member.did)
              return {
                ...member,
                handle: null,
                displayName: null,
                avatar: null,
                roles: [],
              };
            const profile = await resolveProfile(member.did);

            // Fetch visible custom roles from the database
            const visibleRoleRows = await db
              .selectFrom("community_member_roles")
              .innerJoin("community_roles", (join) =>
                join
                  .onRef(
                    "community_member_roles.community_did",
                    "=",
                    "community_roles.community_did",
                  )
                  .onRef(
                    "community_member_roles.role_name",
                    "=",
                    "community_roles.name",
                  ),
              )
              .select([
                "community_member_roles.role_name",
                "community_roles.display_name",
              ])
              .where("community_member_roles.community_did", "=", communityDid)
              .where("community_member_roles.member_did", "=", member.did)
              .where("community_roles.visible", "=", true)
              .execute();

            const roles = visibleRoleRows.map((r) => ({
              name: r.role_name,
              displayName: r.display_name,
            }));

            return { ...member, ...profile, roles };
          }),
        );

        res.json({
          members: enriched,
          total,
          cursor: hasMore ? encodeCursor(offset + limit) : undefined,
        });
      } catch (error) {
        logger.error({ error, communityDid }, "List members error");
        res.status(500).json({ error: "Failed to list members" });
      }
    },
  );

  // ─── LIST PENDING MEMBERS (admin only) ─────────────────────────────
  router.get(
    "/:did/members/pending",
    verifyApiKey,
    memberListRateLimiter,
    async (req: AuthenticatedRequest, res) => {
      const communityDid = decodeURIComponent(req.params.did);
      try {
        const adminDid = req.query.adminDid as string;

        if (!adminDid) {
          return res
            .status(400)
            .json({ error: "adminDid query parameter is required" });
        }

        const community = await db
          .selectFrom("communities")
          .selectAll()
          .where("did", "=", communityDid)
          .executeTakeFirst();

        if (!community) {
          return res.status(404).json({ error: "Community not found" });
        }

        // Verify admin
        const communityAgent = await createCommunityAgent(db, communityDid);
        const adminsRes = await communityAgent.api.com.atproto.repo.getRecord({
          repo: communityDid,
          collection: "community.opensocial.admins",
          rkey: "self",
        });
        const admins = (adminsRes.data.value as any)?.admins || [];
        if (!isAdminInList(adminDid, admins)) {
          return res
            .status(403)
            .json({ error: "Not authorized. Must be an admin." });
        }

        const pending = await db
          .selectFrom("pending_members")
          .selectAll()
          .where("community_did", "=", communityDid)
          .where("status", "=", "pending")
          .orderBy("created_at", "asc")
          .execute();

        // Resolve profiles
        const enriched = await Promise.all(
          pending.map(async (p) => {
            const profile = await resolveProfile(p.user_did);
            return {
              userDid: p.user_did,
              handle: profile.handle,
              avatar: profile.avatar,
              requestedAt: p.created_at,
            };
          }),
        );

        res.json({ pendingMembers: enriched, total: enriched.length });
      } catch (error) {
        logger.error({ error, communityDid }, "List pending members error");
        res.status(500).json({ error: "Failed to list pending members" });
      }
    },
  );

  // ─── APPROVE PENDING MEMBER ────────────────────────────────────────
  router.post(
    "/:did/members/approve",
    verifyApiKey,
    async (req: AuthenticatedRequest, res) => {
      const communityDid = decodeURIComponent(req.params.did);
      let memberDid: string | undefined;
      try {
        const parsed = approveMemberSchema.safeParse(req.body);
        if (!parsed.success) {
          return res
            .status(400)
            .json({ error: "Invalid input", details: parsed.error.flatten() });
        }

        const { adminDid, reason } = parsed.data;
        memberDid = parsed.data.memberDid;

        const community = await db
          .selectFrom("communities")
          .selectAll()
          .where("did", "=", communityDid)
          .executeTakeFirst();

        if (!community) {
          return res.status(404).json({ error: "Community not found" });
        }

        // Verify admin
        const communityAgent = await createCommunityAgent(db, communityDid);
        const adminsRes = await communityAgent.api.com.atproto.repo.getRecord({
          repo: communityDid,
          collection: "community.opensocial.admins",
          rkey: "self",
        });
        const admins = (adminsRes.data.value as any)?.admins || [];
        if (!isAdminInList(adminDid, admins)) {
          return res
            .status(403)
            .json({ error: "Not authorized. Must be an admin." });
        }

        // Find pending request
        const pending = await db
          .selectFrom("pending_members")
          .selectAll()
          .where("community_did", "=", communityDid)
          .where("user_did", "=", memberDid)
          .where("status", "=", "pending")
          .executeTakeFirst();

        if (!pending) {
          return res
            .status(404)
            .json({ error: "No pending join request found for this user" });
        }

        // Create membershipProof
        await writeMembershipProof(db, communityDid, memberDid);

        // Update pending status
        await db
          .updateTable("pending_members")
          .set({
            status: "approved",
            reviewed_by: adminDid,
            updated_at: new Date(),
          })
          .where("id", "=", pending.id)
          .execute();

        await auditLog.log({
          communityDid,
          adminDid,
          action: "member.approved",
          targetDid: memberDid,
          reason,
        });

        await webhooks.dispatch("member.approved", communityDid, {
          communityDid,
          memberDid,
          approvedBy: adminDid,
        });

        res.json({ success: true, message: `Member ${memberDid} approved` });
      } catch (error) {
        logger.error(
          { error, communityDid, memberDid },
          "Approve member error",
        );
        res.status(500).json({ error: "Failed to approve member" });
      }
    },
  );

  // ─── REJECT PENDING MEMBER ────────────────────────────────────────
  router.post(
    "/:did/members/reject",
    verifyApiKey,
    async (req: AuthenticatedRequest, res) => {
      const communityDid = decodeURIComponent(req.params.did);
      let memberDid: string | undefined;
      try {
        const parsed = rejectMemberSchema.safeParse(req.body);
        if (!parsed.success) {
          return res
            .status(400)
            .json({ error: "Invalid input", details: parsed.error.flatten() });
        }

        const { adminDid, reason } = parsed.data;
        memberDid = parsed.data.memberDid;

        const community = await db
          .selectFrom("communities")
          .selectAll()
          .where("did", "=", communityDid)
          .executeTakeFirst();

        if (!community) {
          return res.status(404).json({ error: "Community not found" });
        }

        // Verify admin
        const communityAgent = await createCommunityAgent(db, communityDid);
        const adminsRes = await communityAgent.api.com.atproto.repo.getRecord({
          repo: communityDid,
          collection: "community.opensocial.admins",
          rkey: "self",
        });
        const admins = (adminsRes.data.value as any)?.admins || [];
        if (!isAdminInList(adminDid, admins)) {
          return res
            .status(403)
            .json({ error: "Not authorized. Must be an admin." });
        }

        // Find and reject pending request
        const pending = await db
          .selectFrom("pending_members")
          .selectAll()
          .where("community_did", "=", communityDid)
          .where("user_did", "=", memberDid)
          .where("status", "=", "pending")
          .executeTakeFirst();

        if (!pending) {
          return res
            .status(404)
            .json({ error: "No pending join request found for this user" });
        }

        await db
          .updateTable("pending_members")
          .set({
            status: "rejected",
            reviewed_by: adminDid,
            reason: reason || null,
            updated_at: new Date(),
          })
          .where("id", "=", pending.id)
          .execute();

        await auditLog.log({
          communityDid,
          adminDid,
          action: "member.rejected",
          targetDid: memberDid,
          reason,
        });

        await webhooks.dispatch("member.rejected", communityDid, {
          communityDid,
          memberDid,
          rejectedBy: adminDid,
          reason,
        });

        res.json({
          success: true,
          message: `Join request from ${memberDid} rejected`,
        });
      } catch (error) {
        logger.error({ error, communityDid, memberDid }, "Reject member error");
        res.status(500).json({ error: "Failed to reject member" });
      }
    },
  );

  // ─── REMOVE MEMBER (admin only) ───────────────────────────────────
  router.delete(
    "/:did/members/:memberDid",
    verifyApiKey,
    async (req: AuthenticatedRequest, res) => {
      const communityDid = decodeURIComponent(req.params.did);
      const memberDid = decodeURIComponent(req.params.memberDid);
      try {
        const parsed = removeMemberSchema.safeParse(req.body);
        if (!parsed.success) {
          return res
            .status(400)
            .json({ error: "Invalid input", details: parsed.error.flatten() });
        }

        const { adminDid, reason } = parsed.data;

        const community = await db
          .selectFrom("communities")
          .selectAll()
          .where("did", "=", communityDid)
          .executeTakeFirst();

        if (!community) {
          return res.status(404).json({ error: "Community not found" });
        }

        const communityAgent = await createCommunityAgent(db, communityDid);

        // Verify admin
        const adminsRes = await communityAgent.api.com.atproto.repo.getRecord({
          repo: communityDid,
          collection: "community.opensocial.admins",
          rkey: "self",
        });
        const admins = (adminsRes.data.value as any)?.admins || [];
        if (!isAdminInList(adminDid, admins)) {
          return res
            .status(403)
            .json({ error: "Not authorized. Must be an admin." });
        }

        // Cannot remove original admin
        const originalAdmin = getOriginalAdminDid(admins);
        if (memberDid === originalAdmin) {
          return res
            .status(403)
            .json({ error: "Cannot remove the primary admin." });
        }

        // Find and delete membershipProof
        const removed = await removeMembershipProof(
          db,
          communityDid,
          memberDid,
        );
        if (!removed) {
          return res
            .status(404)
            .json({ error: "Member not found in this community" });
        }

        // Remove from admin list if they were an admin
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
          adminDid,
          action: "member.removed",
          targetDid: memberDid,
          reason,
        });

        await webhooks.dispatch("member.removed", communityDid, {
          communityDid,
          memberDid,
          removedBy: adminDid,
          reason,
        });

        res.json({
          success: true,
          message: `Member ${memberDid} removed from community.`,
        });
      } catch (error) {
        logger.error({ error, communityDid, memberDid }, "Remove member error");
        res.status(500).json({ error: "Failed to remove member" });
      }
    },
  );

  // ─── PROMOTE TO ADMIN ─────────────────────────────────────────────
  router.post(
    "/:did/admins/promote",
    verifyApiKey,
    async (req: AuthenticatedRequest, res) => {
      const communityDid = decodeURIComponent(req.params.did);
      let memberDid: string | undefined;
      try {
        const parsed = promoteMemberSchema.safeParse(req.body);
        if (!parsed.success) {
          return res
            .status(400)
            .json({ error: "Invalid input", details: parsed.error.flatten() });
        }

        const { adminDid } = parsed.data;
        memberDid = parsed.data.memberDid;

        const community = await db
          .selectFrom("communities")
          .selectAll()
          .where("did", "=", communityDid)
          .executeTakeFirst();

        if (!community) {
          return res.status(404).json({ error: "Community not found" });
        }

        const communityAgent = await createCommunityAgent(db, communityDid);

        const adminsRes = await communityAgent.api.com.atproto.repo.getRecord({
          repo: communityDid,
          collection: "community.opensocial.admins",
          rkey: "self",
        });
        const admins = (adminsRes.data.value as any)?.admins || [];

        if (!isAdminInList(adminDid, admins)) {
          return res
            .status(403)
            .json({ error: "Not authorized. Must be an admin." });
        }

        if (isAdminInList(memberDid, admins)) {
          return res.status(409).json({ error: "Member is already an admin" });
        }

        // Verify the member exists
        let memberCursor: string | undefined;
        let found = false;
        do {
          const response =
            await communityAgent.api.com.atproto.repo.listRecords({
              repo: communityDid,
              collection: "community.opensocial.membershipProof",
              limit: 100,
              cursor: memberCursor,
            });
          found = response.data.records.some(
            (r: any) => r.value.memberDid === memberDid,
          );
          memberCursor = response.data.cursor;
        } while (memberCursor && !found);

        if (!found) {
          return res
            .status(404)
            .json({ error: "Member not found in this community" });
        }

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
          adminDid,
          action: "admin.promoted",
          targetDid: memberDid,
        });

        res.json({ success: true, admins: updatedAdmins });
      } catch (error) {
        logger.error({ error, communityDid, memberDid }, "Promote admin error");
        res.status(500).json({ error: "Failed to promote member to admin" });
      }
    },
  );

  // ─── DEMOTE ADMIN ─────────────────────────────────────────────────
  router.post(
    "/:did/admins/demote",
    verifyApiKey,
    async (req: AuthenticatedRequest, res) => {
      const communityDid = decodeURIComponent(req.params.did);
      let memberDid: string | undefined;
      try {
        const parsed = demoteMemberSchema.safeParse(req.body);
        if (!parsed.success) {
          return res
            .status(400)
            .json({ error: "Invalid input", details: parsed.error.flatten() });
        }

        const { adminDid } = parsed.data;
        memberDid = parsed.data.memberDid;

        const community = await db
          .selectFrom("communities")
          .selectAll()
          .where("did", "=", communityDid)
          .executeTakeFirst();

        if (!community) {
          return res.status(404).json({ error: "Community not found" });
        }

        const communityAgent = await createCommunityAgent(db, communityDid);

        const adminsRes = await communityAgent.api.com.atproto.repo.getRecord({
          repo: communityDid,
          collection: "community.opensocial.admins",
          rkey: "self",
        });
        const admins = (adminsRes.data.value as any)?.admins || [];

        if (!isAdminInList(adminDid, admins)) {
          return res
            .status(403)
            .json({ error: "Not authorized. Must be an admin." });
        }

        const originalAdmin = getOriginalAdminDid(admins);
        if (memberDid === originalAdmin) {
          return res.status(403).json({
            error: "Cannot demote the primary admin. Use transfer instead.",
          });
        }

        if (!isAdminInList(memberDid, admins)) {
          return res.status(404).json({ error: "Member is not an admin" });
        }

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
          adminDid,
          action: "admin.demoted",
          targetDid: memberDid,
        });

        res.json({ success: true, admins: updatedAdmins });
      } catch (error) {
        logger.error({ error, communityDid, memberDid }, "Demote admin error");
        res.status(500).json({ error: "Failed to demote admin" });
      }
    },
  );

  // ─── TRANSFER PRIMARY ADMIN ────────────────────────────────────────
  router.post(
    "/:did/admins/transfer",
    verifyApiKey,
    async (req: AuthenticatedRequest, res) => {
      const communityDid = decodeURIComponent(req.params.did);
      let newOwnerDid: string | undefined;
      try {
        const parsed = transferAdminSchema.safeParse(req.body);
        if (!parsed.success) {
          return res
            .status(400)
            .json({ error: "Invalid input", details: parsed.error.flatten() });
        }

        newOwnerDid = parsed.data.newOwnerDid;
        const { currentOwnerDid } = parsed.data;

        const community = await db
          .selectFrom("communities")
          .selectAll()
          .where("did", "=", communityDid)
          .executeTakeFirst();

        if (!community) {
          return res.status(404).json({ error: "Community not found" });
        }

        const communityAgent = await createCommunityAgent(db, communityDid);

        const adminsRes = await communityAgent.api.com.atproto.repo.getRecord({
          repo: communityDid,
          collection: "community.opensocial.admins",
          rkey: "self",
        });
        const admins = (adminsRes.data.value as any)?.admins || [];

        // Verify the caller is the original/primary admin
        const originalAdmin = getOriginalAdminDid(admins);
        if (currentOwnerDid !== originalAdmin) {
          return res
            .status(403)
            .json({ error: "Only the primary admin can transfer ownership" });
        }

        // Verify the new owner is already an admin
        if (!isAdminInList(newOwnerDid, admins)) {
          return res.status(400).json({
            error: "New owner must already be an admin. Promote them first.",
          });
        }

        // Reorder: new owner goes first (becomes primary), current owner stays as regular admin
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
          adminDid: currentOwnerDid,
          action: "admin.transferred",
          targetDid: newOwnerDid,
        });

        res.json({
          success: true,
          message: `Primary admin transferred to ${newOwnerDid}`,
          admins: updatedAdmins,
        });
      } catch (error) {
        logger.error(
          { error, communityDid, newOwnerDid },
          "Transfer admin error",
        );
        res.status(500).json({ error: "Failed to transfer admin role" });
      }
    },
  );

  // ─── MEMBERSHIP CHECK ─────────────────────────────────────────────
  router.post(
    "/:did/membership/check",
    verifyApiKey,
    async (req: AuthenticatedRequest, res) => {
      const communityDid = decodeURIComponent(req.params.did);
      let userDid: string | undefined;
      try {
        const parsed = joinCommunitySchema.safeParse(req.body);
        if (!parsed.success) {
          // Fallback: accept { userDid } directly
          userDid = req.body.userDid;
          if (!userDid) {
            return res.status(400).json({ error: "userDid is required" });
          }
        } else {
          userDid = parsed.data.userDid;
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

        // Check membership
        let memberCursor: string | undefined;
        let isMember = false;
        do {
          const response =
            await communityAgent.api.com.atproto.repo.listRecords({
              repo: communityDid,
              collection: "community.opensocial.membershipProof",
              limit: 100,
              cursor: memberCursor,
            });
          isMember = response.data.records.some(
            (r: any) => r.value.memberDid === userDid,
          );
          memberCursor = response.data.cursor;
        } while (memberCursor && !isMember);

        // Check admin status
        let isAdmin = false;
        try {
          const adminsRes = await communityAgent.api.com.atproto.repo.getRecord(
            {
              repo: communityDid,
              collection: "community.opensocial.admins",
              rkey: "self",
            },
          );
          const admins = (adminsRes.data.value as any)?.admins || [];
          isAdmin = isAdminInList(userDid, admins);
        } catch (e) {
          logWarning("Failed to check admin status", {
            error: e,
            communityDid,
            userDid,
          });
        }

        // Check pending status
        let isPending = false;
        const pendingCheck = await db
          .selectFrom("pending_members")
          .selectAll()
          .where("community_did", "=", communityDid)
          .where("user_did", "=", userDid)
          .where("status", "=", "pending")
          .executeTakeFirst();
        isPending = !!pendingCheck;

        res.json({
          isMember: isMember || isAdmin,
          isAdmin,
          isPending,
        });
      } catch (error) {
        logger.error(
          { error, communityDid, userDid },
          "Membership check error",
        );
        res.status(500).json({ error: "Failed to check membership" });
      }
    },
  );

  // ─── AUDIT LOG ─────────────────────────────────────────────────────
  router.get(
    "/:did/audit-log",
    verifyApiKey,
    auditLogRateLimiter,
    async (req: AuthenticatedRequest, res) => {
      const communityDid = decodeURIComponent(req.params.did);
      try {
        const parsed = auditLogQuerySchema.safeParse(req.query);
        if (!parsed.success) {
          return res
            .status(400)
            .json({ error: "Invalid query", details: parsed.error.flatten() });
        }

        const { adminDid, cursor, limit } = parsed.data;

        const community = await db
          .selectFrom("communities")
          .selectAll()
          .where("did", "=", communityDid)
          .executeTakeFirst();

        if (!community) {
          return res.status(404).json({ error: "Community not found" });
        }

        // Verify admin
        const communityAgent = await createCommunityAgent(db, communityDid);
        const adminsRes = await communityAgent.api.com.atproto.repo.getRecord({
          repo: communityDid,
          collection: "community.opensocial.admins",
          rkey: "self",
        });
        const admins = (adminsRes.data.value as any)?.admins || [];
        if (!isAdminInList(adminDid, admins)) {
          return res
            .status(403)
            .json({ error: "Not authorized. Must be an admin." });
        }

        const result = await auditLog.query({ communityDid, cursor, limit });

        res.json(result);
      } catch (error) {
        logger.error({ error, communityDid }, "Audit log error");
        res.status(500).json({ error: "Failed to fetch audit log" });
      }
    },
  );

  return router;
}
