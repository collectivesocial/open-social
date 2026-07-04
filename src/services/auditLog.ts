import type { Kysely } from "kysely";
import type { Database } from "../db";
import { decodeCursor, encodeCursor } from "../lib/pagination";
import { logger } from "../lib/logger";
import { getCommunitySpace, getSpaceClient } from "./spaces";

export const AUDIT_LOG_ENTRY = "community.opensocial.auditLogEntry";

export type AuditAction =
  | "member.joined"
  | "member.approved"
  | "member.rejected"
  | "member.removed"
  | "member.left"
  | "admin.promoted"
  | "admin.demoted"
  | "admin.transferred"
  | "community.created"
  | "community.deleted"
  | "community.updated"
  | "banner.uploaded"
  | "avatar.uploaded"
  | "settings.updated"
  | "app.visibility.enabled"
  | "app.visibility.disabled"
  | "app.visibility.pending"
  | "collection.permission.updated"
  | "collection.permission.deleted"
  | "role.created"
  | "role.updated"
  | "role.deleted"
  | "role.assigned"
  | "role.revoked"
  | "hierarchy.requested"
  | "hierarchy.invited"
  | "hierarchy.approved"
  | "hierarchy.accepted"
  | "hierarchy.rejected"
  | "hierarchy.revoked";

export function createAuditLogService(db: Kysely<Database>) {
  async function log(params: {
    communityDid: string;
    adminDid: string;
    action: AuditAction;
    targetDid?: string;
    reason?: string;
    metadata?: Record<string, any>;
  }) {
    try {
      await db
        .insertInto("audit_log")
        .values({
          community_did: params.communityDid,
          admin_did: params.adminDid,
          action: params.action,
          target_did: params.targetDid || null,
          reason: params.reason || null,
          metadata: params.metadata ? JSON.stringify(params.metadata) : null,
        })
        .execute();
    } catch (err) {
      logger.error(
        {
          error: err,
          communityDid: params.communityDid,
          action: params.action,
        },
        "Failed to write audit log",
      );
    }

    await writeSpaceEntry(params);
  }

  async function writeSpaceEntry(params: {
    communityDid: string;
    adminDid: string;
    action: AuditAction;
    targetDid?: string;
    reason?: string;
    metadata?: Record<string, any>;
  }) {
    try {
      const mgmt = await getCommunitySpace(
        db,
        params.communityDid,
        "management",
      );
      if (!mgmt) {
        logger.debug(
          { communityDid: params.communityDid, action: params.action },
          "no management space; skipping space audit entry",
        );
        return;
      }
      const client = await getSpaceClient(db, params.communityDid);
      await client.createRecord(mgmt, AUDIT_LOG_ENTRY, {
        $type: AUDIT_LOG_ENTRY,
        actor: params.adminDid,
        action: params.action,
        ...(params.targetDid ? { target: params.targetDid } : {}),
        ...(params.reason ? { reason: params.reason } : {}),
        ...(params.metadata ? { metadata: params.metadata } : {}),
        createdAt: new Date().toISOString(),
      });
    } catch (err) {
      logger.warn(
        {
          error: err,
          communityDid: params.communityDid,
          action: params.action,
        },
        "Failed to write audit log entry to management space",
      );
    }
  }

  async function query(params: {
    communityDid: string;
    cursor?: string;
    limit: number;
  }) {
    const offset = params.cursor ? decodeCursor(params.cursor) : 0;

    const entries = await db
      .selectFrom("audit_log")
      .selectAll()
      .where("community_did", "=", params.communityDid)
      .orderBy("created_at", "desc")
      .offset(offset)
      .limit(params.limit + 1)
      .execute();

    const hasMore = entries.length > params.limit;
    const page = hasMore ? entries.slice(0, params.limit) : entries;

    return {
      entries: page.map((e) => ({
        id: e.id,
        action: e.action,
        adminDid: e.admin_did,
        targetDid: e.target_did,
        reason: e.reason,
        metadata: e.metadata
          ? typeof e.metadata === "string"
            ? JSON.parse(e.metadata)
            : e.metadata
          : null,
        createdAt: e.created_at,
      })),
      cursor: hasMore ? encodeCursor(offset + params.limit) : undefined,
    };
  }

  return { log, query };
}
