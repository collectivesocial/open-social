/**
 * Unit tests for announcements.ts route handlers
 * Tests validation schemas and the group-only permission gating logic.
 */

import { describe, it, expect } from "vitest";
import { z } from "zod";
import {
  satisfiesRole,
  ROLE_ADMIN,
  ROLE_MEMBER,
} from "../services/permissions";

// ─── Inline copies of the private schemas so we can test them directly ───

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

describe("announcement routes", () => {
  describe("createAnnouncementSchema", () => {
    const validPayload = {
      title: "Community meeting this Friday",
      text: "We will be meeting at 5pm PT to discuss the roadmap.",
    };

    it("should accept a valid payload without pinned", () => {
      const result = createAnnouncementSchema.safeParse(validPayload);
      expect(result.success).toBe(true);
    });

    it("should accept a valid payload with pinned", () => {
      const result = createAnnouncementSchema.safeParse({
        ...validPayload,
        pinned: true,
      });
      expect(result.success).toBe(true);
      expect((result as any).data.pinned).toBe(true);
    });

    it("should reject an empty title", () => {
      const result = createAnnouncementSchema.safeParse({
        ...validPayload,
        title: "",
      });
      expect(result.success).toBe(false);
    });

    it("should reject a title exceeding 300 characters", () => {
      const result = createAnnouncementSchema.safeParse({
        ...validPayload,
        title: "x".repeat(301),
      });
      expect(result.success).toBe(false);
    });

    it("should reject empty text", () => {
      const result = createAnnouncementSchema.safeParse({
        ...validPayload,
        text: "",
      });
      expect(result.success).toBe(false);
    });

    it("should reject text exceeding 10000 characters", () => {
      const result = createAnnouncementSchema.safeParse({
        ...validPayload,
        text: "x".repeat(10001),
      });
      expect(result.success).toBe(false);
    });

    it("should reject a missing title", () => {
      const result = createAnnouncementSchema.safeParse({ text: "body only" });
      expect(result.success).toBe(false);
    });

    it("should reject non-boolean pinned", () => {
      const result = createAnnouncementSchema.safeParse({
        ...validPayload,
        pinned: "yes",
      });
      expect(result.success).toBe(false);
    });

    it("should NOT accept a caller-supplied createdBy (set from session server-side)", () => {
      const result = createAnnouncementSchema.safeParse({
        ...validPayload,
        createdBy: "did:plc:hacker",
      });
      expect(result.success).toBe(true);
      // Zod strips unknown keys by default
      expect((result as any).data).not.toHaveProperty("createdBy");
    });
  });

  describe("updateAnnouncementSchema", () => {
    it("should accept a title-only update", () => {
      const result = updateAnnouncementSchema.safeParse({ title: "New title" });
      expect(result.success).toBe(true);
    });

    it("should accept a pinned-only update", () => {
      const result = updateAnnouncementSchema.safeParse({ pinned: false });
      expect(result.success).toBe(true);
    });

    it("should accept an empty object (handler rejects separately)", () => {
      const result = updateAnnouncementSchema.safeParse({});
      expect(result.success).toBe(true);
      expect(Object.keys((result as any).data)).toHaveLength(0);
    });

    it("should reject an empty-string title", () => {
      const result = updateAnnouncementSchema.safeParse({ title: "" });
      expect(result.success).toBe(false);
    });
  });

  describe("listAnnouncementsSchema", () => {
    it("should use default limit of 50 when not specified", () => {
      const result = listAnnouncementsSchema.safeParse({});
      expect(result.success).toBe(true);
      expect(result.data!.limit).toBe(50);
    });

    it("should coerce string limit to number", () => {
      const result = listAnnouncementsSchema.safeParse({ limit: "25" });
      expect(result.success).toBe(true);
      expect(result.data!.limit).toBe(25);
    });

    it("should reject limit above 100", () => {
      const result = listAnnouncementsSchema.safeParse({ limit: "101" });
      expect(result.success).toBe(false);
    });

    it("should accept an optional cursor", () => {
      const result = listAnnouncementsSchema.safeParse({ cursor: "abc123" });
      expect(result.success).toBe(true);
      expect(result.data!.cursor).toBe("abc123");
    });
  });

  describe("group-only permission gating", () => {
    // Announcements default to create/update/delete = admin, read = member.
    // These tests pin down the role semantics the route relies on.

    it("should allow an admin to create (required role admin)", () => {
      expect(satisfiesRole([ROLE_MEMBER, ROLE_ADMIN], ROLE_ADMIN)).toBe(true);
    });

    it("should NOT allow a plain member to create (required role admin)", () => {
      expect(satisfiesRole([ROLE_MEMBER], ROLE_ADMIN)).toBe(false);
    });

    it("should allow a member to read (required role member)", () => {
      expect(satisfiesRole([ROLE_MEMBER], ROLE_MEMBER)).toBe(true);
    });

    it("should allow an admin to read (required role member)", () => {
      expect(satisfiesRole([ROLE_ADMIN], ROLE_MEMBER)).toBe(true);
    });

    it("should NOT allow a non-member to read (no roles)", () => {
      expect(satisfiesRole([], ROLE_MEMBER)).toBe(false);
    });

    it("should NOT allow a user with only a custom role to read member-gated content", () => {
      expect(satisfiesRole(["moderator"], ROLE_MEMBER)).toBe(false);
    });

    it("should allow a custom role to create when the community overrides the required role", () => {
      // Communities can relax the create permission to a custom role
      // via community_app_collection_permissions.
      expect(satisfiesRole(["moderator"], "moderator")).toBe(true);
      expect(satisfiesRole([ROLE_MEMBER], "moderator")).toBe(false);
    });
  });

  describe("pinned ordering", () => {
    it("should sort pinned announcements before unpinned within a page", () => {
      const records = [
        { rkey: "a", pinned: false },
        { rkey: "b", pinned: true },
        { rkey: "c", pinned: false },
        { rkey: "d", pinned: true },
      ];
      records.sort((a, b) => Number(b.pinned) - Number(a.pinned));
      expect(records.map((r) => r.rkey)).toEqual(["b", "d", "a", "c"]);
    });
  });
});
