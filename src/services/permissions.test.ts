/**
 * Unit tests for permissions.ts
 * Tests permission checking, role resolution, and visibility logic
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  checkAppVisibility,
  getRequiredRole,
  getUserRoles,
  satisfiesRole,
  checkMembership,
  findMembershipProof,
  checkAdmin,
  seedCollectionPermissions,
  ROLE_ADMIN,
  ROLE_MEMBER,
} from "../services/permissions";
import { createMockDb, createMockAgent, createFakeDid } from "../test/helpers";
import { adminCache, memberCache, memberRolesCache } from "../lib/cache";
import type { Kysely } from "kysely";
import type { Database } from "../db";

describe("permissions.ts", () => {
  let db: Kysely<Database>;
  const communityDid = createFakeDid();
  const appId = "test-app-123";
  const userDid = createFakeDid();

  beforeEach(() => {
    db = createMockDb();
    vi.clearAllMocks();
    // Clear caches before each test
    adminCache.clear();
    memberCache.clear();
    memberRolesCache.clear();
  });

  describe("checkAppVisibility", () => {
    it("should allow app when explicit override is enabled", async () => {
      const selectFrom = vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              executeTakeFirst: vi
                .fn()
                .mockResolvedValue({ status: "enabled" }),
            }),
          }),
        }),
      });

      db.selectFrom = selectFrom;

      const result = await checkAppVisibility(db, communityDid, appId);

      expect(result).toEqual({ allowed: true });
    });

    it("should block app when explicit override is disabled", async () => {
      const selectFrom = vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              executeTakeFirst: vi
                .fn()
                .mockResolvedValue({ status: "disabled" }),
            }),
          }),
        }),
      });

      db.selectFrom = selectFrom;

      const result = await checkAppVisibility(db, communityDid, appId);

      expect(result).toEqual({
        allowed: false,
        reason: "App is disabled for this community",
      });
    });

    it("should block app when in community blocked list", async () => {
      let callCount = 0;
      const selectFrom = vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              executeTakeFirst: vi.fn().mockImplementation(async () => {
                callCount++;
                return callCount === 1
                  ? undefined
                  : { blocked_app_ids: JSON.stringify([appId]) };
              }),
            }),
          }),
        }),
        selectAll: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            executeTakeFirst: vi.fn().mockResolvedValue({
              blocked_app_ids: JSON.stringify([appId]),
              app_visibility_default: "open",
            }),
          }),
        }),
      });

      db.selectFrom = selectFrom;

      const result = await checkAppVisibility(db, communityDid, appId);

      expect(result).toEqual({
        allowed: false,
        reason: "App is blocked by this community",
      });
    });

    it("should block app when community requires approval", async () => {
      let callCount = 0;
      const selectFrom = vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              executeTakeFirst: vi.fn().mockImplementation(async () => {
                callCount++;
                return callCount === 1 ? undefined : null;
              }),
            }),
          }),
        }),
        selectAll: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            executeTakeFirst: vi.fn().mockResolvedValue({
              blocked_app_ids: "[]",
              app_visibility_default: "approval_required",
            }),
          }),
        }),
      });

      db.selectFrom = selectFrom;

      const result = await checkAppVisibility(db, communityDid, appId);

      expect(result).toEqual({
        allowed: false,
        reason: "Community requires admin approval for apps",
      });
    });

    it("should allow app when settings default is open", async () => {
      let callCount = 0;
      const selectFrom = vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              executeTakeFirst: vi.fn().mockImplementation(async () => {
                callCount++;
                return callCount === 1 ? undefined : null;
              }),
            }),
          }),
        }),
        selectAll: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            executeTakeFirst: vi.fn().mockResolvedValue({
              blocked_app_ids: "[]",
              app_visibility_default: "open",
            }),
          }),
        }),
      });

      db.selectFrom = selectFrom;

      const result = await checkAppVisibility(db, communityDid, appId);

      expect(result).toEqual({ allowed: true });
    });

    it("should default to open when no settings exist", async () => {
      let callCount = 0;
      const selectFrom = vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              executeTakeFirst: vi.fn().mockImplementation(async () => {
                callCount++;
                return callCount === 1 ? undefined : null;
              }),
            }),
          }),
        }),
        selectAll: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            executeTakeFirst: vi.fn().mockResolvedValue(undefined),
          }),
        }),
      });

      db.selectFrom = selectFrom;

      const result = await checkAppVisibility(db, communityDid, appId);

      expect(result).toEqual({ allowed: true });
    });

    it("should handle malformed JSON in blocked_app_ids", async () => {
      let callCount = 0;
      const selectFrom = vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              executeTakeFirst: vi.fn().mockImplementation(async () => {
                callCount++;
                return callCount === 1 ? undefined : null;
              }),
            }),
          }),
        }),
        selectAll: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            executeTakeFirst: vi.fn().mockResolvedValue({
              blocked_app_ids: "invalid-json",
              app_visibility_default: "open",
            }),
          }),
        }),
      });

      db.selectFrom = selectFrom;

      const result = await checkAppVisibility(db, communityDid, appId);

      expect(result).toEqual({ allowed: true });
    });
  });

  describe("getRequiredRole", () => {
    it("should return required role for operation", async () => {
      const selectFrom = vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              where: vi.fn().mockReturnValue({
                executeTakeFirst: vi
                  .fn()
                  .mockResolvedValue({ can_create: "member" }),
              }),
            }),
          }),
        }),
      });

      db.selectFrom = selectFrom;

      const result = await getRequiredRole(
        db,
        communityDid,
        appId,
        "test.collection",
        "create",
      );

      expect(result).toBe("member");
    });

    it("should return null when no permission row exists", async () => {
      const selectFrom = vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              where: vi.fn().mockReturnValue({
                executeTakeFirst: vi.fn().mockResolvedValue(undefined),
              }),
            }),
          }),
        }),
      });

      db.selectFrom = selectFrom;

      const result = await getRequiredRole(
        db,
        communityDid,
        appId,
        "test.collection",
        "create",
      );

      expect(result).toBeNull();
    });

    it("should work with all CRUD operations", async () => {
      const operations = ["create", "read", "update", "delete"] as const;

      for (const op of operations) {
        const selectFrom = vi.fn().mockReturnValue({
          select: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              where: vi.fn().mockReturnValue({
                where: vi.fn().mockReturnValue({
                  executeTakeFirst: vi
                    .fn()
                    .mockResolvedValue({ [`can_${op}`]: "admin" }),
                }),
              }),
            }),
          }),
        });

        db.selectFrom = selectFrom;

        const result = await getRequiredRole(
          db,
          communityDid,
          appId,
          "test.collection",
          op,
        );

        expect(result).toBe("admin");
      }
    });
  });

  describe("getUserRoles", () => {
    it("should return member role when user is a member", async () => {
      const agent = createMockAgent();
      agent.api.com.atproto.repo.listRecords.mockResolvedValue({
        data: {
          records: [{ value: { memberDid: userDid } }],
          cursor: undefined,
        },
      });

      const selectFrom = vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              execute: vi.fn().mockResolvedValue([]),
            }),
          }),
        }),
      });

      db.selectFrom = selectFrom;

      const roles = await getUserRoles(db, communityDid, userDid, agent);

      expect(roles).toContain(ROLE_MEMBER);
      expect(roles).not.toContain(ROLE_ADMIN);
    });

    it("should return admin role when user is an admin", async () => {
      const agent = createMockAgent();
      agent.api.com.atproto.repo.listRecords.mockResolvedValue({
        data: {
          records: [{ value: { memberDid: userDid } }],
          cursor: undefined,
        },
      });
      agent.api.com.atproto.repo.getRecord.mockResolvedValue({
        data: { value: { admins: [userDid] } },
      });

      const selectFrom = vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              execute: vi.fn().mockResolvedValue([]),
            }),
          }),
        }),
      });

      db.selectFrom = selectFrom;

      const roles = await getUserRoles(db, communityDid, userDid, agent);

      expect(roles).toContain(ROLE_MEMBER);
      expect(roles).toContain(ROLE_ADMIN);
    });

    it("should include custom roles from database", async () => {
      const agent = createMockAgent();
      agent.api.com.atproto.repo.listRecords.mockResolvedValue({
        data: {
          records: [{ value: { memberDid: userDid } }],
          cursor: undefined,
        },
      });

      const selectFrom = vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              execute: vi
                .fn()
                .mockResolvedValue([
                  { role_name: "moderator" },
                  { role_name: "contributor" },
                ]),
            }),
          }),
        }),
      });

      db.selectFrom = selectFrom;

      const roles = await getUserRoles(db, communityDid, userDid, agent);

      expect(roles).toContain(ROLE_MEMBER);
      expect(roles).toContain("moderator");
      expect(roles).toContain("contributor");
    });

    it("should use cache on subsequent calls", async () => {
      const agent = createMockAgent();
      agent.api.com.atproto.repo.listRecords.mockResolvedValue({
        data: {
          records: [{ value: { memberDid: userDid } }],
          cursor: undefined,
        },
      });

      const selectFrom = vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              execute: vi.fn().mockResolvedValue([]),
            }),
          }),
        }),
      });

      db.selectFrom = selectFrom;

      // First call
      const roles1 = await getUserRoles(db, communityDid, userDid, agent);

      // Second call should use cache
      const roles2 = await getUserRoles(db, communityDid, userDid, agent);

      expect(roles1).toEqual(roles2);
      expect(agent.api.com.atproto.repo.listRecords).toHaveBeenCalledTimes(1);
    });

    it("should return empty array when user is not a member", async () => {
      const agent = createMockAgent();
      agent.api.com.atproto.repo.listRecords.mockResolvedValue({
        data: {
          records: [],
          cursor: undefined,
        },
      });

      const selectFrom = vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              execute: vi.fn().mockResolvedValue([]),
            }),
          }),
        }),
      });

      db.selectFrom = selectFrom;

      const roles = await getUserRoles(db, communityDid, userDid, agent);

      expect(roles).toEqual([]);
    });
  });

  describe("satisfiesRole", () => {
    it("should allow admin to satisfy any role", () => {
      expect(satisfiesRole([ROLE_ADMIN], ROLE_MEMBER)).toBe(true);
      expect(satisfiesRole([ROLE_ADMIN], ROLE_ADMIN)).toBe(true);
      expect(satisfiesRole([ROLE_ADMIN], "custom-role")).toBe(true);
    });

    it("should allow member to satisfy member role", () => {
      expect(satisfiesRole([ROLE_MEMBER], ROLE_MEMBER)).toBe(true);
    });

    it("should not allow member to satisfy admin role", () => {
      expect(satisfiesRole([ROLE_MEMBER], ROLE_ADMIN)).toBe(false);
    });

    it("should require exact match for custom roles", () => {
      expect(satisfiesRole(["moderator"], "moderator")).toBe(true);
      expect(satisfiesRole(["moderator"], "contributor")).toBe(false);
    });

    it("should allow admin to satisfy custom roles", () => {
      expect(satisfiesRole([ROLE_ADMIN, ROLE_MEMBER], "moderator")).toBe(true);
    });

    it("should handle multiple user roles", () => {
      const userRoles = [ROLE_MEMBER, "moderator", "contributor"];

      expect(satisfiesRole(userRoles, ROLE_MEMBER)).toBe(true);
      expect(satisfiesRole(userRoles, "moderator")).toBe(true);
      expect(satisfiesRole(userRoles, "contributor")).toBe(true);
      expect(satisfiesRole(userRoles, "editor")).toBe(false);
    });
  });

  describe("checkMembership", () => {
    it("should return true when user is found in membership records", async () => {
      const agent = createMockAgent();
      agent.api.com.atproto.repo.listRecords.mockResolvedValue({
        data: {
          records: [{ value: { memberDid: userDid } }],
          cursor: undefined,
        },
      });

      const result = await checkMembership(agent, communityDid, userDid);

      expect(result).toBe(true);
    });

    it("should return false when user is not found in membership records", async () => {
      const agent = createMockAgent();
      agent.api.com.atproto.repo.listRecords.mockResolvedValue({
        data: {
          records: [],
          cursor: undefined,
        },
      });

      const result = await checkMembership(agent, communityDid, userDid);

      expect(result).toBe(false);
    });

    it("should use cache on subsequent calls", async () => {
      const agent = createMockAgent();
      agent.api.com.atproto.repo.listRecords.mockResolvedValue({
        data: {
          records: [{ value: { memberDid: userDid } }],
          cursor: undefined,
        },
      });

      // First call
      const result1 = await checkMembership(agent, communityDid, userDid);

      // Second call should use cache
      const result2 = await checkMembership(agent, communityDid, userDid);

      expect(result1).toBe(true);
      expect(result2).toBe(true);
      expect(agent.api.com.atproto.repo.listRecords).toHaveBeenCalledTimes(1);
    });

    it("should handle pagination when searching for member", async () => {
      const agent = createMockAgent();
      agent.api.com.atproto.repo.listRecords
        .mockResolvedValueOnce({
          data: {
            records: [{ value: { memberDid: "did:plc:other1" } }],
            cursor: "cursor1",
          },
        })
        .mockResolvedValueOnce({
          data: {
            records: [{ value: { memberDid: userDid } }],
            cursor: undefined,
          },
        });

      const result = await checkMembership(agent, communityDid, userDid);

      expect(result).toBe(true);
      expect(agent.api.com.atproto.repo.listRecords).toHaveBeenCalledTimes(2);
    });
  });

  describe("findMembershipProof", () => {
    it("should return the record uri and rkey when found (across pages)", async () => {
      const agent = createMockAgent();
      agent.api.com.atproto.repo.listRecords
        .mockResolvedValueOnce({
          data: {
            records: [
              {
                uri: `at://${communityDid}/community.opensocial.membershipProof/aaa`,
                value: { memberDid: "did:plc:other" },
              },
            ],
            cursor: "cursor1",
          },
        })
        .mockResolvedValueOnce({
          data: {
            records: [
              {
                uri: `at://${communityDid}/community.opensocial.membershipProof/bbb`,
                value: { memberDid: userDid },
              },
            ],
            cursor: undefined,
          },
        });

      const result = await findMembershipProof(agent, communityDid, userDid);

      expect(result).toEqual({
        uri: `at://${communityDid}/community.opensocial.membershipProof/bbb`,
        rkey: "bbb",
      });
    });

    it("should return null and cache the negative when not found", async () => {
      const agent = createMockAgent();
      agent.api.com.atproto.repo.listRecords.mockResolvedValue({
        data: { records: [], cursor: undefined },
      });

      const result = await findMembershipProof(agent, communityDid, userDid);

      expect(result).toBeNull();
      expect(memberCache.get(`${communityDid}:${userDid}`)).toBe(false);
    });

    it("should warm the membership cache on a hit", async () => {
      const agent = createMockAgent();
      agent.api.com.atproto.repo.listRecords.mockResolvedValue({
        data: {
          records: [
            {
              uri: `at://${communityDid}/community.opensocial.membershipProof/ccc`,
              value: { memberDid: userDid },
            },
          ],
          cursor: undefined,
        },
      });

      await findMembershipProof(agent, communityDid, userDid);

      // A subsequent checkMembership should be answered from cache
      const isMember = await checkMembership(agent, communityDid, userDid);
      expect(isMember).toBe(true);
      expect(agent.api.com.atproto.repo.listRecords).toHaveBeenCalledTimes(1);
    });

    it("should always scan live data even when the cache says non-member", async () => {
      memberCache.set(`${communityDid}:${userDid}`, false);
      const agent = createMockAgent();
      agent.api.com.atproto.repo.listRecords.mockResolvedValue({
        data: {
          records: [
            {
              uri: `at://${communityDid}/community.opensocial.membershipProof/ddd`,
              value: { memberDid: userDid },
            },
          ],
          cursor: undefined,
        },
      });

      const result = await findMembershipProof(agent, communityDid, userDid);

      expect(result?.rkey).toBe("ddd");
    });
  });

  describe("checkAdmin", () => {
    it("should return true when user is in admins list", async () => {
      const agent = createMockAgent();
      agent.api.com.atproto.repo.getRecord.mockResolvedValue({
        data: { value: { admins: [userDid] } },
      });

      const result = await checkAdmin(agent, communityDid, userDid);

      expect(result).toBe(true);
    });

    it("should return false when user is not in admins list", async () => {
      const agent = createMockAgent();
      agent.api.com.atproto.repo.getRecord.mockResolvedValue({
        data: { value: { admins: ["did:plc:other1", "did:plc:other2"] } },
      });

      const result = await checkAdmin(agent, communityDid, userDid);

      expect(result).toBe(false);
    });

    it("should return false when getRecord fails", async () => {
      const agent = createMockAgent();
      agent.api.com.atproto.repo.getRecord.mockRejectedValue(
        new Error("Not found"),
      );

      const result = await checkAdmin(agent, communityDid, userDid);

      expect(result).toBe(false);
    });

    it("should use cache on subsequent calls", async () => {
      const agent = createMockAgent();
      agent.api.com.atproto.repo.getRecord.mockResolvedValue({
        data: { value: { admins: [userDid] } },
      });

      // First call
      const result1 = await checkAdmin(agent, communityDid, userDid);

      // Second call should use cache
      const result2 = await checkAdmin(agent, communityDid, userDid);

      expect(result1).toBe(true);
      expect(result2).toBe(true);
      expect(agent.api.com.atproto.repo.getRecord).toHaveBeenCalledTimes(1);
    });
  });

  describe("seedCollectionPermissions", () => {
    it("should copy app default permissions to community", async () => {
      const defaults = [
        {
          app_id: appId,
          collection: "test.post",
          default_can_create: "member",
          default_can_read: "member",
          default_can_update: "admin",
          default_can_delete: "admin",
        },
      ];

      let callIndex = 0;
      const selectFrom = vi.fn().mockReturnValue({
        selectAll: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            execute: vi.fn().mockResolvedValue(defaults),
          }),
        }),
        select: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              where: vi.fn().mockReturnValue({
                executeTakeFirst: vi.fn().mockImplementation(() => {
                  return Promise.resolve(undefined); // No existing override
                }),
              }),
            }),
          }),
        }),
      });

      const insertInto = vi.fn().mockReturnValue({
        values: vi.fn().mockReturnValue({
          execute: vi.fn().mockResolvedValue(undefined),
        }),
      });

      db.selectFrom = selectFrom;
      db.insertInto = insertInto;

      await seedCollectionPermissions(db, communityDid, appId);

      expect(insertInto).toHaveBeenCalledWith(
        "community_app_collection_permissions",
      );
    });

    it("should not overwrite existing permission overrides", async () => {
      const defaults = [
        {
          app_id: appId,
          collection: "test.post",
          default_can_create: "member",
          default_can_read: "member",
          default_can_update: "admin",
          default_can_delete: "admin",
        },
      ];

      const selectFrom = vi.fn().mockReturnValue({
        selectAll: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            execute: vi.fn().mockResolvedValue(defaults),
          }),
        }),
        select: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              where: vi.fn().mockReturnValue({
                executeTakeFirst: vi.fn().mockResolvedValue({ id: 1 }), // Existing override
              }),
            }),
          }),
        }),
      });

      const insertInto = vi.fn().mockReturnValue({
        values: vi.fn().mockReturnValue({
          execute: vi.fn().mockResolvedValue(undefined),
        }),
      });

      db.selectFrom = selectFrom;
      db.insertInto = insertInto;

      await seedCollectionPermissions(db, communityDid, appId);

      // Should not insert if override exists
      expect(insertInto).not.toHaveBeenCalled();
    });
  });
});
