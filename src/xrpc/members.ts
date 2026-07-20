import type { Kysely } from "kysely";
import type { Request } from "express";
import type { Database } from "../db";
import type { XrpcHandler } from "./server";
import { XrpcError } from "./server";
import { createCommunityAgent } from "../services/atproto";
import { createAuditLogService } from "../services/auditLog";
import { createWebhookService } from "../services/webhook";
import {
  isAdminInList,
  getOriginalAdminDid,
  normalizeAdmins,
} from "../lib/adminUtils";
import { encodeCursor, decodeCursor } from "../lib/pagination";
import { logger } from "../lib/logger";
import { logWarning } from "../lib/errors";
import { memberCache } from "../lib/cache";
import { checkMembership, findMembershipProof } from "../services/permissions";

/**
 * Resolve a Bluesky profile to get handle, display name, and avatar.
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

export function registerMemberHandlers(
  handlers: Map<string, XrpcHandler>,
  db: Kysely<Database>,
) {
  const auditLog = createAuditLogService(db);
  const webhooks = createWebhookService(db);

  handlers.set("community.opensocial.joinCommunity", {
    type: "procedure",
    handler: async (input) => {
      const { communityDid, userDid, membershipCid } = input;
      if (!communityDid || !userDid) {
        throw new XrpcError(
          400,
          "InvalidInput",
          "communityDid and userDid are required",
        );
      }

      const community = await db
        .selectFrom("communities")
        .selectAll()
        .where("did", "=", communityDid)
        .executeTakeFirst();
      if (!community) {
        throw new XrpcError(404, "CommunityNotFound", "Community not found");
      }

      const communityAgent = await createCommunityAgent(db, communityDid);

      // Check if already a member (cached, 5-min TTL)
      const alreadyMember = await checkMembership(
        communityAgent,
        communityDid,
        userDid,
      );

      if (alreadyMember) {
        throw new XrpcError(
          409,
          "AlreadyMember",
          "Already a member of this community",
        );
      }

      const communityType = await getCommunityType(
        communityAgent,
        communityDid,
      );

      if (communityType === "admin-approved") {
        const existing = await db
          .selectFrom("pending_members")
          .selectAll()
          .where("community_did", "=", communityDid)
          .where("user_did", "=", userDid)
          .where("status", "=", "pending")
          .executeTakeFirst();

        if (existing) {
          throw new XrpcError(
            409,
            "AlreadyPending",
            "Join request already pending",
          );
        }

        await db
          .insertInto("pending_members")
          .values({
            community_did: communityDid,
            user_did: userDid,
            status: "pending",
          })
          .execute();

        return {
          status: "pending",
          message:
            "Join request submitted. An admin must approve your request.",
        };
      }

      // Open community — create membershipProof immediately
      await communityAgent.api.com.atproto.repo.createRecord({
        repo: communityDid,
        collection: "community.opensocial.membershipProof",
        record: {
          $type: "community.opensocial.membershipProof",
          memberDid: userDid,
          cid: membershipCid || "",
          confirmedAt: new Date().toISOString(),
        },
      });
      memberCache.set(`${communityDid}:${userDid}`, true);

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

      return {
        status: "joined",
        message: "Successfully joined the community",
        membership: {
          communityDid,
          memberDid: userDid,
          joinedAt: new Date().toISOString(),
        },
      };
    },
  });

  handlers.set("community.opensocial.leaveCommunity", {
    type: "procedure",
    handler: async (input) => {
      const { communityDid, userDid } = input;
      if (!communityDid || !userDid) {
        throw new XrpcError(
          400,
          "InvalidInput",
          "communityDid and userDid are required",
        );
      }

      const community = await db
        .selectFrom("communities")
        .selectAll()
        .where("did", "=", communityDid)
        .executeTakeFirst();
      if (!community) {
        throw new XrpcError(404, "CommunityNotFound", "Community not found");
      }

      const communityAgent = await createCommunityAgent(db, communityDid);

      // Check if user is the original admin
      try {
        const adminsRes = await communityAgent.api.com.atproto.repo.getRecord({
          repo: communityDid,
          collection: "community.opensocial.admins",
          rkey: "self",
        });
        const admins = (adminsRes.data.value as any)?.admins || [];
        const originalAdmin = getOriginalAdminDid(admins);
        if (userDid === originalAdmin) {
          throw new XrpcError(
            403,
            "CannotLeaveAsAdmin",
            "The primary admin cannot leave. Transfer admin role first.",
          );
        }

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
        if (e instanceof XrpcError) throw e;
        logWarning("Failed to check admin status when leaving", {
          error: e,
          communityDid,
          userDid,
        });
      }

      // Find and delete the membershipProof
      const proof = await findMembershipProof(
        communityAgent,
        communityDid,
        userDid,
      );

      if (!proof) {
        throw new XrpcError(404, "NotMember", "Not a member of this community");
      }

      await communityAgent.api.com.atproto.repo.deleteRecord({
        repo: communityDid,
        collection: "community.opensocial.membershipProof",
        rkey: proof.rkey,
      });
      memberCache.set(`${communityDid}:${userDid}`, false);

      await webhooks.dispatch("member.left", communityDid, {
        communityDid,
        memberDid: userDid,
      });

      return {};
    },
  });

  handlers.set("community.opensocial.getMembers", {
    type: "query",
    handler: async (params) => {
      const communityDid = params.communityDid as string;
      const userDid = params.userDid as string | undefined;
      const limit = params.limit ? parseInt(params.limit as string, 10) : 50;
      const cursor = params.cursor as string | undefined;
      const offset = cursor ? decodeCursor(cursor) : 0;

      if (!communityDid) {
        throw new XrpcError(400, "InvalidInput", "communityDid is required");
      }

      const community = await db
        .selectFrom("communities")
        .selectAll()
        .where("did", "=", communityDid)
        .executeTakeFirst();
      if (!community) {
        throw new XrpcError(404, "CommunityNotFound", "Community not found");
      }

      const communityAgent = await createCommunityAgent(db, communityDid);

      const maxFetch = Math.min(offset + limit * 3, 1000);
      let atCursor: string | undefined;
      const allProofs: any[] = [];
      do {
        const response = await communityAgent.api.com.atproto.repo.listRecords({
          repo: communityDid,
          collection: "community.opensocial.membershipProof",
          limit: 100,
          cursor: atCursor,
        });
        allProofs.push(...response.data.records);
        atCursor = response.data.cursor;
        if (allProofs.length >= maxFetch) break;
      } while (atCursor);

      // Get admins list
      let admins: any[] = [];
      try {
        const adminsRes = await communityAgent.api.com.atproto.repo.getRecord({
          repo: communityDid,
          collection: "community.opensocial.admins",
          rkey: "self",
        });
        admins = (adminsRes.data.value as any)?.admins || [];
      } catch (e) {
        logWarning("Failed to fetch admins list", { error: e, communityDid });
      }

      let members = allProofs.map((record: any) => {
        const memberDid = record.value.memberDid || null;
        return {
          did: memberDid,
          confirmedAt: record.value.confirmedAt || null,
          isAdmin: memberDid ? isAdminInList(memberDid, admins) : false,
        };
      });

      const page = members.slice(offset, offset + limit);
      const hasMore =
        allProofs.length >= maxFetch || offset + limit < members.length;
      const total = members.length;

      // Resolve profiles
      const enriched = await Promise.all(
        page.map(async (member) => {
          if (!member.did)
            return { ...member, handle: null, displayName: null, avatar: null };
          const profile = await resolveProfile(member.did);
          return { ...member, ...profile };
        }),
      );

      return {
        members: enriched,
        total,
        cursor: hasMore ? encodeCursor(offset + limit) : undefined,
      };
    },
  });

  handlers.set("community.opensocial.approveMember", {
    type: "procedure",
    handler: async (input) => {
      const { communityDid, adminDid, userDid } = input;
      if (!communityDid || !adminDid || !userDid) {
        throw new XrpcError(
          400,
          "InvalidInput",
          "communityDid, adminDid, and userDid are required",
        );
      }

      const community = await db
        .selectFrom("communities")
        .selectAll()
        .where("did", "=", communityDid)
        .executeTakeFirst();
      if (!community) {
        throw new XrpcError(404, "CommunityNotFound", "Community not found");
      }

      const communityAgent = await createCommunityAgent(db, communityDid);
      const adminsRes = await communityAgent.api.com.atproto.repo.getRecord({
        repo: communityDid,
        collection: "community.opensocial.admins",
        rkey: "self",
      });
      const admins = (adminsRes.data.value as any)?.admins || [];
      if (!isAdminInList(adminDid, admins)) {
        throw new XrpcError(
          403,
          "PermissionDenied",
          "Not authorized. Must be an admin.",
        );
      }

      const pending = await db
        .selectFrom("pending_members")
        .selectAll()
        .where("community_did", "=", communityDid)
        .where("user_did", "=", userDid)
        .where("status", "=", "pending")
        .executeTakeFirst();
      if (!pending) {
        throw new XrpcError(
          404,
          "NoPendingRequest",
          "No pending join request found for this user",
        );
      }

      await communityAgent.api.com.atproto.repo.createRecord({
        repo: communityDid,
        collection: "community.opensocial.membershipProof",
        record: {
          $type: "community.opensocial.membershipProof",
          memberDid: userDid,
          cid: "",
          confirmedAt: new Date().toISOString(),
        },
      });
      memberCache.set(`${communityDid}:${userDid}`, true);

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
        targetDid: userDid,
      });

      await webhooks.dispatch("member.approved", communityDid, {
        communityDid,
        memberDid: userDid,
        approvedBy: adminDid,
      });

      return {};
    },
  });

  handlers.set("community.opensocial.rejectMember", {
    type: "procedure",
    handler: async (input) => {
      const { communityDid, adminDid, userDid } = input;
      if (!communityDid || !adminDid || !userDid) {
        throw new XrpcError(
          400,
          "InvalidInput",
          "communityDid, adminDid, and userDid are required",
        );
      }

      const community = await db
        .selectFrom("communities")
        .selectAll()
        .where("did", "=", communityDid)
        .executeTakeFirst();
      if (!community) {
        throw new XrpcError(404, "CommunityNotFound", "Community not found");
      }

      const communityAgent = await createCommunityAgent(db, communityDid);
      const adminsRes = await communityAgent.api.com.atproto.repo.getRecord({
        repo: communityDid,
        collection: "community.opensocial.admins",
        rkey: "self",
      });
      const admins = (adminsRes.data.value as any)?.admins || [];
      if (!isAdminInList(adminDid, admins)) {
        throw new XrpcError(
          403,
          "PermissionDenied",
          "Not authorized. Must be an admin.",
        );
      }

      const pending = await db
        .selectFrom("pending_members")
        .selectAll()
        .where("community_did", "=", communityDid)
        .where("user_did", "=", userDid)
        .where("status", "=", "pending")
        .executeTakeFirst();
      if (!pending) {
        throw new XrpcError(
          404,
          "NoPendingRequest",
          "No pending join request found for this user",
        );
      }

      await db
        .updateTable("pending_members")
        .set({
          status: "rejected",
          reviewed_by: adminDid,
          updated_at: new Date(),
        })
        .where("id", "=", pending.id)
        .execute();

      await auditLog.log({
        communityDid,
        adminDid,
        action: "member.rejected",
        targetDid: userDid,
      });

      await webhooks.dispatch("member.rejected", communityDid, {
        communityDid,
        memberDid: userDid,
        rejectedBy: adminDid,
      });

      return {};
    },
  });

  handlers.set("community.opensocial.removeMember", {
    type: "procedure",
    handler: async (input) => {
      const { communityDid, adminDid, memberDid } = input;
      if (!communityDid || !adminDid || !memberDid) {
        throw new XrpcError(
          400,
          "InvalidInput",
          "communityDid, adminDid, and memberDid are required",
        );
      }

      const community = await db
        .selectFrom("communities")
        .selectAll()
        .where("did", "=", communityDid)
        .executeTakeFirst();
      if (!community) {
        throw new XrpcError(404, "CommunityNotFound", "Community not found");
      }

      const communityAgent = await createCommunityAgent(db, communityDid);

      const adminsRes = await communityAgent.api.com.atproto.repo.getRecord({
        repo: communityDid,
        collection: "community.opensocial.admins",
        rkey: "self",
      });
      const admins = (adminsRes.data.value as any)?.admins || [];
      if (!isAdminInList(adminDid, admins)) {
        throw new XrpcError(
          403,
          "PermissionDenied",
          "Not authorized. Must be an admin.",
        );
      }

      const originalAdmin = getOriginalAdminDid(admins);
      if (memberDid === originalAdmin) {
        throw new XrpcError(
          403,
          "CannotRemoveAdmin",
          "Cannot remove the primary admin.",
        );
      }

      // Find membershipProof
      const proof = await findMembershipProof(
        communityAgent,
        communityDid,
        memberDid,
      );

      if (!proof) {
        throw new XrpcError(
          404,
          "MemberNotFound",
          "Member not found in this community",
        );
      }

      await communityAgent.api.com.atproto.repo.deleteRecord({
        repo: communityDid,
        collection: "community.opensocial.membershipProof",
        rkey: proof.rkey,
      });
      memberCache.set(`${communityDid}:${memberDid}`, false);

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
      });

      await webhooks.dispatch("member.removed", communityDid, {
        communityDid,
        memberDid,
        removedBy: adminDid,
      });

      return {};
    },
  });

  handlers.set("community.opensocial.getPendingMembers", {
    type: "query",
    handler: async (params) => {
      const communityDid = params.communityDid as string;
      const adminDid = params.adminDid as string;

      if (!communityDid || !adminDid) {
        throw new XrpcError(
          400,
          "InvalidInput",
          "communityDid and adminDid are required",
        );
      }

      const community = await db
        .selectFrom("communities")
        .selectAll()
        .where("did", "=", communityDid)
        .executeTakeFirst();
      if (!community) {
        throw new XrpcError(404, "CommunityNotFound", "Community not found");
      }

      const communityAgent = await createCommunityAgent(db, communityDid);
      const adminsRes = await communityAgent.api.com.atproto.repo.getRecord({
        repo: communityDid,
        collection: "community.opensocial.admins",
        rkey: "self",
      });
      const admins = (adminsRes.data.value as any)?.admins || [];
      if (!isAdminInList(adminDid, admins)) {
        throw new XrpcError(
          403,
          "PermissionDenied",
          "Not authorized. Must be an admin.",
        );
      }

      const pending = await db
        .selectFrom("pending_members")
        .selectAll()
        .where("community_did", "=", communityDid)
        .where("status", "=", "pending")
        .orderBy("created_at", "asc")
        .execute();

      const members = await Promise.all(
        pending.map(async (p) => {
          const profile = await resolveProfile(p.user_did);
          return {
            userDid: p.user_did,
            requestedAt: p.created_at,
            handle: profile.handle,
            displayName: profile.displayName,
            avatar: profile.avatar,
          };
        }),
      );

      return { members };
    },
  });
}
