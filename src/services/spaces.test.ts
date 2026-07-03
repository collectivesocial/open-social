/**
 * Unit tests for the spaces service (permissioned data Phase 1):
 * policy evaluation (canReadSpace / canWriteSpace / enforceSpaceBoundary)
 * and the space validation schemas.
 */

import { describe, it, expect, vi } from "vitest";
import {
  canReadSpace,
  canWriteSpace,
  enforceSpaceBoundary,
  parseSpaceCollections,
  type SpaceRow,
} from "./spaces";
import {
  createSpaceSchema,
  updateSpaceSchema,
  spaceKeySchema,
} from "../validation/schemas";

// ─── Test helpers ─────────────────────────────────────────────────────

function makeSpace(overrides: Partial<SpaceRow> = {}): SpaceRow {
  return {
    id: 1,
    community_did: "did:plc:community",
    space_key: "announcements",
    name: "Announcements",
    description: null,
    space_type: "community.opensocial.space",
    read_access: "member",
    write_access: "admin",
    collections: JSON.stringify(["community.opensocial.announcement"]),
    created_by: "did:plc:admin",
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  } as SpaceRow;
}

/**
 * Minimal chainable Kysely mock. `spaces` backs listSpaces (execute),
 * `invite` backs isInvited (executeTakeFirst).
 */
function makeDb({ spaces = [] as SpaceRow[], invited = false } = {}): any {
  const chain: any = {
    selectFrom: vi.fn(() => chain),
    select: vi.fn(() => chain),
    selectAll: vi.fn(() => chain),
    where: vi.fn(() => chain),
    orderBy: vi.fn(() => chain),
    execute: vi.fn(async () => spaces),
    executeTakeFirst: vi.fn(async () => (invited ? { id: 1 } : undefined)),
  };
  return chain;
}

const USER = "did:plc:user";

describe("spaces service", () => {
  describe("parseSpaceCollections", () => {
    it("parses a JSON array of collections", () => {
      const space = makeSpace({ collections: '["a.b.c","d.e.f"]' });
      expect(parseSpaceCollections(space)).toEqual(["a.b.c", "d.e.f"]);
    });

    it("returns [] for malformed JSON", () => {
      const space = makeSpace({ collections: "not json" });
      expect(parseSpaceCollections(space)).toEqual([]);
    });

    it("returns [] for non-array JSON", () => {
      const space = makeSpace({ collections: '{"a":1}' });
      expect(parseSpaceCollections(space)).toEqual([]);
    });
  });

  describe("canReadSpace", () => {
    it("always allows admins", async () => {
      const space = makeSpace({ read_access: "invite" });
      expect(await canReadSpace(makeDb(), space, USER, ["admin"])).toBe(true);
    });

    it("allows anyone when read_access is public", async () => {
      const space = makeSpace({ read_access: "public" });
      expect(await canReadSpace(makeDb(), space, USER, [])).toBe(true);
    });

    it("allows members when read_access is member", async () => {
      const space = makeSpace({ read_access: "member" });
      expect(await canReadSpace(makeDb(), space, USER, ["member"])).toBe(true);
    });

    it("denies non-members when read_access is member", async () => {
      const space = makeSpace({ read_access: "member" });
      expect(await canReadSpace(makeDb(), space, USER, [])).toBe(false);
    });

    it("denies members when read_access is admin", async () => {
      const space = makeSpace({ read_access: "admin" });
      expect(await canReadSpace(makeDb(), space, USER, ["member"])).toBe(false);
    });

    it("allows invited users when read_access is invite", async () => {
      const space = makeSpace({ read_access: "invite" });
      expect(
        await canReadSpace(makeDb({ invited: true }), space, USER, ["member"]),
      ).toBe(true);
    });

    it("denies uninvited members when read_access is invite", async () => {
      const space = makeSpace({ read_access: "invite" });
      expect(
        await canReadSpace(makeDb({ invited: false }), space, USER, ["member"]),
      ).toBe(false);
    });

    it("allows users holding the custom role when read_access is a custom role", async () => {
      const space = makeSpace({ read_access: "moderator" });
      expect(
        await canReadSpace(makeDb(), space, USER, ["member", "moderator"]),
      ).toBe(true);
    });

    it("denies plain members when read_access is a custom role", async () => {
      const space = makeSpace({ read_access: "moderator" });
      expect(await canReadSpace(makeDb(), space, USER, ["member"])).toBe(false);
    });
  });

  describe("canWriteSpace", () => {
    it("allows admins when write_access is admin", () => {
      expect(
        canWriteSpace(makeSpace({ write_access: "admin" }), ["admin"]),
      ).toBe(true);
    });

    it("denies members when write_access is admin", () => {
      expect(
        canWriteSpace(makeSpace({ write_access: "admin" }), ["member"]),
      ).toBe(false);
    });

    it("allows members when write_access is member", () => {
      expect(
        canWriteSpace(makeSpace({ write_access: "member" }), ["member"]),
      ).toBe(true);
    });

    it("allows custom role holders when write_access is that role", () => {
      expect(
        canWriteSpace(makeSpace({ write_access: "moderator" }), [
          "member",
          "moderator",
        ]),
      ).toBe(true);
    });
  });

  describe("enforceSpaceBoundary", () => {
    const COLLECTION = "community.opensocial.announcement";

    it("allows any operation on collections outside all spaces", async () => {
      const db = makeDb({ spaces: [] });
      const result = await enforceSpaceBoundary(
        db,
        "did:plc:community",
        "some.other.collection",
        "create",
        USER,
        [],
      );
      expect(result.allowed).toBe(true);
    });

    it("denies member reads when the owning space is invite-only", async () => {
      const db = makeDb({
        spaces: [makeSpace({ read_access: "invite" })],
        invited: false,
      });
      const result = await enforceSpaceBoundary(
        db,
        "did:plc:community",
        COLLECTION,
        "read",
        USER,
        ["member"],
      );
      expect(result.allowed).toBe(false);
      expect((result as any).reason).toContain("announcements");
    });

    it("allows member reads of a member-readable space", async () => {
      const db = makeDb({ spaces: [makeSpace({ read_access: "member" })] });
      const result = await enforceSpaceBoundary(
        db,
        "did:plc:community",
        COLLECTION,
        "read",
        USER,
        ["member"],
      );
      expect(result.allowed).toBe(true);
    });

    it("denies member writes to an admin-writable space", async () => {
      const db = makeDb({ spaces: [makeSpace({ write_access: "admin" })] });
      for (const op of ["create", "update", "delete"] as const) {
        const result = await enforceSpaceBoundary(
          db,
          "did:plc:community",
          COLLECTION,
          op,
          USER,
          ["member"],
        );
        expect(result.allowed).toBe(false);
      }
    });

    it("allows admin writes to an admin-writable space", async () => {
      const db = makeDb({ spaces: [makeSpace({ write_access: "admin" })] });
      const result = await enforceSpaceBoundary(
        db,
        "did:plc:community",
        COLLECTION,
        "create",
        USER,
        ["admin"],
      );
      expect(result.allowed).toBe(true);
    });
  });
});

describe("space validation schemas", () => {
  describe("spaceKeySchema", () => {
    it("accepts lowercase slugs", () => {
      expect(spaceKeySchema.safeParse("announcements").success).toBe(true);
      expect(spaceKeySchema.safeParse("book-club-2026").success).toBe(true);
    });

    it("rejects uppercase, spaces, and leading hyphens", () => {
      expect(spaceKeySchema.safeParse("Announcements").success).toBe(false);
      expect(spaceKeySchema.safeParse("book club").success).toBe(false);
      expect(spaceKeySchema.safeParse("-club").success).toBe(false);
    });
  });

  describe("createSpaceSchema", () => {
    const valid = {
      adminDid: "did:plc:admin",
      spaceKey: "reading-list",
      name: "Reading List",
      collections: ["community.opensocial.readingItem"],
    };

    it("accepts a valid payload with defaults", () => {
      const result = createSpaceSchema.safeParse(valid);
      expect(result.success).toBe(true);
      expect(result.data!.readAccess).toBe("member");
      expect(result.data!.writeAccess).toBe("admin");
    });

    it("accepts invite read access and custom role write access", () => {
      const result = createSpaceSchema.safeParse({
        ...valid,
        readAccess: "invite",
        writeAccess: "moderator",
      });
      expect(result.success).toBe(true);
    });

    it("rejects public write access", () => {
      const result = createSpaceSchema.safeParse({
        ...valid,
        writeAccess: "public",
      });
      expect(result.success).toBe(false);
    });

    it("rejects invalid collection NSIDs", () => {
      const result = createSpaceSchema.safeParse({
        ...valid,
        collections: ["not a collection"],
      });
      expect(result.success).toBe(false);
    });

    it("requires at least one collection", () => {
      const result = createSpaceSchema.safeParse({ ...valid, collections: [] });
      expect(result.success).toBe(false);
    });

    it("rejects a missing adminDid", () => {
      const { adminDid: _drop, ...rest } = valid;
      expect(createSpaceSchema.safeParse(rest).success).toBe(false);
    });
  });

  describe("updateSpaceSchema", () => {
    it("requires at least one updatable field", () => {
      const result = updateSpaceSchema.safeParse({ adminDid: "did:plc:admin" });
      expect(result.success).toBe(false);
    });

    it("accepts a readAccess-only update", () => {
      const result = updateSpaceSchema.safeParse({
        adminDid: "did:plc:admin",
        readAccess: "invite",
      });
      expect(result.success).toBe(true);
    });
  });
});
