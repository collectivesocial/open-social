/**
 * Unit tests for the API key auth middleware.
 *
 * Regression coverage for an issue where keys returned by app registration
 * and key rotation were rejected on production: the middleware was selecting
 * the first active app from the database without filtering by which app the
 * supplied key belonged to, so it could only ever validate one app's keys.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Response, NextFunction } from "express";
import type { Kysely } from "kysely";
import type { Database } from "../db";
import { createMockDb } from "../test/helpers";
import { computeApiKeyLookup, hashApiKey } from "../lib/crypto";
import {
  apiKeyAuthCache,
  createVerifyApiKey,
  parseScopeString,
  hasScope,
  OPENSOCIAL_SCOPES,
  MEMBERSHIP_WRITE_SCOPE,
  type AuthenticatedRequest,
} from "./auth";

function makeApp(overrides: Partial<Record<string, unknown>>) {
  return {
    id: 1,
    app_id: "app-1",
    name: "Test App",
    domain: "test.example",
    creator_did: "did:plc:test",
    api_key: "SYSTEM_APP_NO_KEY",
    api_key_lookup: null,
    auth_method: "api_key",
    status: "active",
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

/**
 * Mock the two query shapes authenticateApiKey issues:
 * - fast path: ...where().where().executeTakeFirst() → `fastPathRow`
 * - legacy fallback: ...where().where().execute() → `legacyRows`
 * Passing an array mocks legacy rows only (pre-migration-016 behavior).
 */
function mockAppsQuery(
  db: Kysely<Database>,
  appsOrOpts:
    | ReturnType<typeof makeApp>[]
    | {
        fastPathRow?: ReturnType<typeof makeApp>;
        legacyRows?: ReturnType<typeof makeApp>[];
      },
) {
  const opts = Array.isArray(appsOrOpts)
    ? { legacyRows: appsOrOpts }
    : appsOrOpts;
  const terminal = {
    execute: vi.fn().mockResolvedValue(opts.legacyRows ?? []),
    executeTakeFirst: vi.fn().mockResolvedValue(opts.fastPathRow),
  };
  db.selectFrom = vi.fn().mockReturnValue({
    selectAll: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue(terminal),
      }),
    }),
  });
  return terminal;
}

beforeEach(() => {
  apiKeyAuthCache.clear();
});

// Shared sample raw keys for tests. Format mirrors the real format
// (`osc_` + 64 hex chars) produced by `crypto.randomBytes(32).toString('hex')`.
const SAMPLE_KEY_A = "osc_" + "a1b2c3d4e5f6071829304a5b6c7d8e9f".repeat(2);
const SAMPLE_KEY_B =
  "osc_" +
  "fedcba9876543210112233445566778899aabbccddeeff00112233445566778".slice(
    0,
    64,
  );

function makeReqRes(apiKey?: string) {
  const req = {
    headers: apiKey ? { "x-api-key": apiKey } : {},
  } as unknown as AuthenticatedRequest;
  const json = vi.fn();
  const res = {
    status: vi.fn().mockReturnValue({ json }),
  } as unknown as Response;
  const next: NextFunction = vi.fn();
  return { req, res, next, json };
}

describe("createVerifyApiKey middleware", () => {
  it("rejects requests without an X-Api-Key header", async () => {
    const db = createMockDb();
    const middleware = createVerifyApiKey(db);
    const { req, res, next, json } = makeReqRes();

    await middleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(json).toHaveBeenCalledWith({
      error: "API key or HTTP signature required",
    });
    expect(next).not.toHaveBeenCalled();
  });

  it("authenticates the correct app when multiple active apps exist", async () => {
    // Regression: previously the middleware grabbed the first active app
    // (executeTakeFirst) and rejected all keys that did not belong to it.
    const db = createMockDb();
    const keyA = SAMPLE_KEY_A;
    const keyB = SAMPLE_KEY_B;
    const appA = makeApp({ app_id: "app-a", api_key: hashApiKey(keyA) });
    const appB = makeApp({ app_id: "app-b", api_key: hashApiKey(keyB) });

    mockAppsQuery(db, [appA, appB]);

    const middleware = createVerifyApiKey(db);
    const { req, res, next } = makeReqRes(keyB);

    await middleware(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
    expect(req.app_data?.app_id).toBe("app-b");
  });

  it("rejects an unknown key even when active apps exist", async () => {
    const db = createMockDb();
    const realKey = SAMPLE_KEY_A;
    const app = makeApp({ api_key: hashApiKey(realKey) });
    mockAppsQuery(db, [app]);

    const middleware = createVerifyApiKey(db);
    const { req, res, next, json } = makeReqRes("osc_wrong");

    await middleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(json).toHaveBeenCalledWith({ error: "Invalid API key" });
    expect(next).not.toHaveBeenCalled();
  });

  it("sets auth_method to api_key on successful API key auth", async () => {
    const db = createMockDb();
    const realKey = SAMPLE_KEY_A;
    const app = makeApp({ api_key: hashApiKey(realKey) });
    mockAppsQuery(db, [app]);

    const middleware = createVerifyApiKey(db);
    const { req, res, next } = makeReqRes(realKey);

    await middleware(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(req.auth_method).toBe("api_key");
  });

  it("routes to HTTP signature verification when Signature-Input header is present", async () => {
    const db = createMockDb();
    // Mock the DB query for signature path (uses or() clause)
    db.selectFrom = vi.fn().mockReturnValue({
      selectAll: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            executeTakeFirst: vi.fn().mockResolvedValue(null),
          }),
        }),
      }),
    });

    const middleware = createVerifyApiKey(db);
    const req = {
      headers: {
        "signature-input": 'sig1=("@method");keyid="unknown-app"',
        signature: "sig1=:abc:",
      },
    } as unknown as AuthenticatedRequest;
    const json = vi.fn();
    const res = {
      status: vi.fn().mockReturnValue({ json }),
    } as unknown as Response;
    const next: NextFunction = vi.fn();

    await middleware(req, res, next);

    // Should attempt HTTP signature auth and fail because app not found
    expect(res.status).toHaveBeenCalledWith(401);
    expect(json).toHaveBeenCalledWith({ error: "Unknown app" });
  });

  it("safely skips apps with sentinel/non-hash api_key values", async () => {
    // The system app row stores 'SYSTEM_APP_NO_KEY' as a sentinel — it must
    // never authenticate any request, but its presence must not prevent
    // legitimate apps that come after it from authenticating.
    const db = createMockDb();
    const realKey = SAMPLE_KEY_A;
    const systemApp = makeApp({
      app_id: "system",
      api_key: "SYSTEM_APP_NO_KEY",
    });
    const realApp = makeApp({ app_id: "real", api_key: hashApiKey(realKey) });

    mockAppsQuery(db, [systemApp, realApp]);

    const middleware = createVerifyApiKey(db);
    const { req, res, next } = makeReqRes(realKey);

    await middleware(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(req.app_data?.app_id).toBe("real");
  });

  it("returns clear error when Signature-Input is present but Signature is missing", async () => {
    const db = createMockDb();
    const middleware = createVerifyApiKey(db);
    const req = {
      headers: {
        "signature-input": 'sig1=("@method");keyid="app-1"',
        // no 'signature' header
      },
    } as unknown as AuthenticatedRequest;
    const json = vi.fn();
    const res = {
      status: vi.fn().mockReturnValue({ json }),
    } as unknown as Response;
    const next: NextFunction = vi.fn();

    await middleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(json).toHaveBeenCalledWith({
      error:
        "Signature-Input header present but Signature header is missing. Both are required.",
    });
    expect(next).not.toHaveBeenCalled();
  });

  it("authenticates via the indexed fast path without scanning legacy rows", async () => {
    const db = createMockDb();
    const key = SAMPLE_KEY_A;
    const app = makeApp({
      app_id: "fast-app",
      api_key: hashApiKey(key),
      api_key_lookup: computeApiKeyLookup(key),
    });
    const terminal = mockAppsQuery(db, { fastPathRow: app });

    const middleware = createVerifyApiKey(db);
    const { req, res, next } = makeReqRes(key);

    await middleware(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(req.app_data?.app_id).toBe("fast-app");
    expect(terminal.executeTakeFirst).toHaveBeenCalledTimes(1);
    expect(terminal.execute).not.toHaveBeenCalled(); // legacy scan skipped
  });

  it("rejects a key whose fast-path row is http_signature-only", async () => {
    const db = createMockDb();
    const key = SAMPLE_KEY_A;
    const app = makeApp({
      api_key: hashApiKey(key),
      api_key_lookup: computeApiKeyLookup(key),
      auth_method: "http_signature",
    });
    mockAppsQuery(db, { fastPathRow: app });

    const middleware = createVerifyApiKey(db);
    const { req, res, next, json } = makeReqRes(key);

    await middleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(json).toHaveBeenCalledWith({ error: "Invalid API key" });
    expect(next).not.toHaveBeenCalled();
  });

  it("backfills api_key_lookup after a successful legacy-path match", async () => {
    const db = createMockDb();
    const key = SAMPLE_KEY_A;
    const legacyApp = makeApp({
      app_id: "legacy-app",
      api_key: hashApiKey(key),
    });
    mockAppsQuery(db, { legacyRows: [legacyApp] });

    const middleware = createVerifyApiKey(db);
    const { req, res, next } = makeReqRes(key);

    await middleware(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(req.app_data?.app_id).toBe("legacy-app");
    expect(db.updateTable).toHaveBeenCalledWith("apps");
    expect(db.set).toHaveBeenCalledWith({
      api_key_lookup: computeApiKeyLookup(key),
    });
  });

  it("serves repeat requests from the auth cache without hitting the database", async () => {
    const db = createMockDb();
    const key = SAMPLE_KEY_A;
    const app = makeApp({
      app_id: "cached-app",
      api_key: hashApiKey(key),
      api_key_lookup: computeApiKeyLookup(key),
    });
    mockAppsQuery(db, { fastPathRow: app });

    const middleware = createVerifyApiKey(db);

    const first = makeReqRes(key);
    await middleware(first.req, first.res, first.next);
    const callsAfterFirst = (db.selectFrom as ReturnType<typeof vi.fn>).mock
      .calls.length;

    const second = makeReqRes(key);
    await middleware(second.req, second.res, second.next);

    expect(second.next).toHaveBeenCalledTimes(1);
    expect(second.req.app_data?.app_id).toBe("cached-app");
    expect((db.selectFrom as ReturnType<typeof vi.fn>).mock.calls.length).toBe(
      callsAfterFirst,
    );
  });
});

// ── parseScopeString ──────────────────────────────────────────────
// Regression coverage for PR #73: scope parsing must handle real OAuth
// scope strings without crashing or silently skipping scopes.

describe("parseScopeString", () => {
  it("splits a standard OAuth scope string into individual scopes", () => {
    const result = parseScopeString(
      "atproto repo:community.opensocial.membership",
    );
    expect(result).toEqual(["atproto", "repo:community.opensocial.membership"]);
  });

  it("handles leading, trailing, and repeated whitespace between scopes", () => {
    const result = parseScopeString(
      "  atproto   repo:community.opensocial.membership  ",
    );
    expect(result).toEqual(["atproto", "repo:community.opensocial.membership"]);
  });

  it("returns an empty array for an empty string without throwing", () => {
    expect(() => parseScopeString("")).not.toThrow();
    expect(parseScopeString("")).toEqual([]);
  });

  it("returns a single-element array for a single scope with no spaces", () => {
    expect(parseScopeString("atproto")).toEqual(["atproto"]);
  });
});

// ── hasScope (satisfiesScope) ─────────────────────────────────────
// Security regression for PR #73: incorrect wildcard matching or
// cross-resource-type grants must not slip through.

describe("hasScope (satisfiesScope)", () => {
  it("returns true for an exact scope match", () => {
    expect(
      hasScope(
        "atproto repo:community.opensocial.membership",
        "repo:community.opensocial.membership",
      ),
    ).toBe(true);
  });

  it("returns true when a repo:* wildcard is granted", () => {
    // A granted `repo:*` scope covers any `repo:` collection.
    expect(hasScope("repo:*", "repo:community.opensocial.membership")).toBe(
      true,
    );
    expect(hasScope("atproto repo:*", "repo:foo.bar.baz")).toBe(true);
  });

  it("returns false when the required scope is absent and no wildcard covers it", () => {
    expect(hasScope("atproto", "repo:community.opensocial.membership")).toBe(
      false,
    );
  });

  it("the bare atproto scope does NOT grant repo: access (security invariant)", () => {
    // Critical: `atproto` is a base scope — it must never implicitly grant
    // write access to repo collections (PR #73 gap).
    expect(hasScope("atproto", "repo:foo")).toBe(false);
  });

  it("does not grant access when an unrelated resource type wildcard is present", () => {
    // `weird:*` covers the `weird:` namespace only — must not bleed into `repo:`.
    expect(hasScope("weird:*", "repo:community.opensocial.membership")).toBe(
      false,
    );
  });

  it("returns false when granted scopes list is empty", () => {
    expect(hasScope("", "repo:community.opensocial.membership")).toBe(false);
  });
});

// ── Scope constants ───────────────────────────────────────────────
// Snapshot-style assertions: if these values change we want a test failure
// that forces a deliberate decision rather than a silent drift.

describe("OPENSOCIAL_SCOPES and MEMBERSHIP_WRITE_SCOPE constants", () => {
  it("OPENSOCIAL_SCOPES contains both the atproto base scope and the membership write scope", () => {
    expect(OPENSOCIAL_SCOPES).toBe(
      "atproto repo:community.opensocial.membership",
    );
  });

  it("MEMBERSHIP_WRITE_SCOPE identifies the membership collection exactly", () => {
    expect(MEMBERSHIP_WRITE_SCOPE).toBe("repo:community.opensocial.membership");
  });

  it("MEMBERSHIP_WRITE_SCOPE is included in OPENSOCIAL_SCOPES", () => {
    // Ensures the full scope string actually grants what it advertises.
    expect(hasScope(OPENSOCIAL_SCOPES, MEMBERSHIP_WRITE_SCOPE)).toBe(true);
  });
});
