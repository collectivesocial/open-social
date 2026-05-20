/**
 * Tests for community membership status and join behavior.
 *
 * Covers:
 *   - GET /communities/:did returns membershipStatus (null, pending, active)
 *   - POST /communities/:did/join returns already_member for pending users
 *
 * Uses supertest against the real Express app with mocked OAuth, PDS agents,
 * and database calls where needed.
 */

import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  vi,
  beforeEach,
} from "vitest";
import supertest from "supertest";
import express from "express";
import cookieParser from "cookie-parser";
import { getIronSession } from "iron-session";
import { Kysely, PostgresDialect } from "kysely";
import { Pool } from "pg";
import type { Database } from "../db";
import { createAuthRouter } from "./auth";

// ── Fake identities ──────────────────────────────────────────────────────────

const COMMUNITY_DID = "did:plc:testcommunity000000001";
const USER_DID = "did:plc:testuser0000000000001";
const ADMIN_DID = "did:plc:testadmin000000000001";
const MEMBERSHIP_CID = "bafyreimembership00000001";

// ── Mock OAuth + agents ──────────────────────────────────────────────────────

// Use vi.hoisted so the fake agent is available when vi.mock runs (mocks are hoisted)
const { fakeUserAgent, mockCommunityAgent } = vi.hoisted(() => {
  const fakeUserAgent = {
    assertDid: "did:plc:testuser0000000000001",
    did: "did:plc:testuser0000000000001",
    signOut: vi.fn(async () => {}),
    getProfile: vi.fn(async () => ({
      data: {
        did: "did:plc:testuser0000000000001",
        handle: "testuser.bsky.social",
        displayName: "Test User",
        avatar: undefined,
      },
    })),
    api: {
      com: {
        atproto: {
          repo: {
            listRecords: vi.fn(),
            getRecord: vi.fn(),
            createRecord: vi.fn(),
          },
        },
      },
    },
  };

  const mockCommunityAgent = {
    api: {
      com: {
        atproto: {
          repo: {
            listRecords: vi.fn(),
            getRecord: vi.fn(),
            createRecord: vi.fn(),
          },
        },
      },
    },
  };

  return { fakeUserAgent, mockCommunityAgent };
});

// Mock Agent constructor so getSessionAgent returns our fake agent
vi.mock("@atproto/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@atproto/api")>();
  function MockAgent() {
    return fakeUserAgent;
  }
  return {
    ...actual,
    Agent: MockAgent,
    BskyAgent: actual.BskyAgent,
  };
});

const mockOAuthClient = {
  authorize: vi.fn(),
  restore: vi.fn(async () => ({
    getTokenInfo: vi.fn(async () => ({ scope: "atproto transition:generic" })),
  })),
  revoke: vi.fn(),
  clientMetadata: { client_id: "https://test.opensocial.local" },
} as any;

// ── Session constants ────────────────────────────────────────────────────────

const SESSION_OPTIONS = {
  cookieName: "sid",
  password:
    process.env.COOKIE_SECRET || "test-cookie-secret-for-testing-purposes",
  cookieOptions: { secure: false, sameSite: "lax" as const },
};

interface Session {
  did?: string;
}

// ── Mock external services ───────────────────────────────────────────────────

// mockCommunityAgent is defined in vi.hoisted() above

vi.mock("../services/atproto", () => ({
  createCommunityAgent: vi.fn(async () => mockCommunityAgent),
  resolvePdsEndpoint: vi.fn(async () => "https://pds.example.com"),
  resolveAuthServer: vi.fn(async () => "https://auth.example.com"),
  resolveHandleToDid: vi.fn(),
  ensureServiceUrl: vi.fn(),
  invalidateCommunityAgent: vi.fn(),
}));

// ── Build test app ───────────────────────────────────────────────────────────

function buildTestApp(db: Database) {
  const app = express();
  app.use(cookieParser());
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  app.use("/", createAuthRouter(mockOAuthClient, db));

  // Seed a session for authenticated requests
  app.post("/__test__/seed-session", async (req, res) => {
    const session = await getIronSession<Session>(req, res, SESSION_OPTIONS);
    session.did = req.body.did ?? USER_DID;
    await session.save();
    res.json({ ok: true });
  });

  return app;
}

// ── DB setup ─────────────────────────────────────────────────────────────────

async function createTestDb(): Promise<Database> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL required");
  return new Kysely<any>({
    dialect: new PostgresDialect({
      pool: new Pool({ connectionString, max: 3 }),
    }),
  }) as Database;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function setupCommunityInDb(db: Database, communityDid: string) {
  return db
    .insertInto("communities" as any)
    .values({
      did: communityDid,
      handle: "test-community.bsky.social",
      display_name: "Test Community",
      pds_host: "https://pds.example.com",
      app_password: "encrypted:test",
    })
    .onConflict((oc) => oc.column("did").doNothing())
    .execute();
}

function cleanupCommunity(db: Database, communityDid: string) {
  return Promise.all([
    db
      .deleteFrom("pending_members" as any)
      .where("community_did", "=", communityDid)
      .execute(),
    db
      .deleteFrom("communities" as any)
      .where("did", "=", communityDid)
      .execute(),
  ]);
}

function insertPendingMember(
  db: Database,
  communityDid: string,
  userDid: string,
) {
  return db
    .insertInto("pending_members" as any)
    .values({
      community_did: communityDid,
      user_did: userDid,
      status: "pending",
    })
    .execute();
}

/**
 * Configure mock PDS responses for community details.
 * - profile: basic community profile
 * - admins: admin list
 * - membershipProofs: list of proofs in the community repo
 * - userMemberships: list of membership records in the user's repo
 */
function configurePdsMocks(opts: {
  admins?: string[];
  membershipProofs?: Array<{ memberDid: string; cid: string }>;
  userMemberships?: Array<{ community: string; role: string; cid: string }>;
}) {
  const admins = opts.admins ?? [ADMIN_DID];
  const proofs = opts.membershipProofs ?? [];
  const userMemberships = opts.userMemberships ?? [];

  // Community agent mocks (reads from community repo)
  mockCommunityAgent.api.com.atproto.repo.getRecord.mockImplementation(
    async (params: any) => {
      if (params.collection === "community.opensocial.profile") {
        return {
          data: {
            value: {
              displayName: "Test Community",
              description: "A test community",
              type: "admin-approved",
            },
          },
        };
      }
      if (params.collection === "community.opensocial.admins") {
        return { data: { value: { admins } } };
      }
      throw new Error(`Unknown collection: ${params.collection}`);
    },
  );

  mockCommunityAgent.api.com.atproto.repo.listRecords.mockImplementation(
    async (params: any) => {
      if (params.collection === "community.opensocial.membershipProof") {
        return {
          data: {
            records: proofs.map((p) => ({
              value: { memberDid: p.memberDid, cid: p.cid },
            })),
            cursor: undefined,
          },
        };
      }
      return { data: { records: [], cursor: undefined } };
    },
  );

  // User agent mocks (reads from user's own repo)
  fakeUserAgent.api.com.atproto.repo.listRecords.mockImplementation(
    async (params: any) => {
      if (params.collection === "community.opensocial.membership") {
        return {
          data: {
            records: userMemberships.map((m) => ({
              value: { community: m.community, role: m.role },
              cid: m.cid,
            })),
            cursor: undefined,
          },
        };
      }
      if (params.collection === "community.opensocial.membershipProof") {
        return {
          data: {
            records: (opts.membershipProofs ?? []).map((p) => ({
              value: { memberDid: p.memberDid, cid: p.cid },
            })),
            cursor: undefined,
          },
        };
      }
      return { data: { records: [], cursor: undefined } };
    },
  );
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("Community membership status", () => {
  let db: Database;
  let app: express.Express;
  let agent: ReturnType<typeof supertest>;

  beforeAll(async () => {
    db = await createTestDb();
    app = buildTestApp(db);
    agent = supertest.agent(app);

    await setupCommunityInDb(db, COMMUNITY_DID);

    // Seed authenticated session
    await agent
      .post("/__test__/seed-session")
      .send({ did: USER_DID })
      .expect(200);
  });

  afterAll(async () => {
    await cleanupCommunity(db, COMMUNITY_DID);
    await db.destroy();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    // Re-wire restore to return a fake OAuth session for each test
    mockOAuthClient.restore.mockResolvedValue({
      getTokenInfo: vi.fn(async () => ({
        scope: "atproto transition:generic",
      })),
    });
  });

  describe("GET /communities/:did - membershipStatus", () => {
    it("returns membershipStatus: null for a non-member", async () => {
      configurePdsMocks({
        admins: [ADMIN_DID],
        membershipProofs: [],
        userMemberships: [],
      });

      const res = await agent
        .get(`/communities/${encodeURIComponent(COMMUNITY_DID)}`)
        .expect(200);

      expect(res.body.isMember).toBe(false);
      expect(res.body.isAuthenticated).toBe(true);
      expect(res.body.membershipStatus).toBeNull();
    });

    it("returns membershipStatus: 'pending' for a pending member", async () => {
      // User has a membership record but no matching proof
      configurePdsMocks({
        admins: [ADMIN_DID],
        membershipProofs: [],
        userMemberships: [
          {
            community: COMMUNITY_DID,
            role: "member",
            cid: MEMBERSHIP_CID,
          },
        ],
      });

      const res = await agent
        .get(`/communities/${encodeURIComponent(COMMUNITY_DID)}`)
        .expect(200);

      expect(res.body.isMember).toBe(false);
      expect(res.body.isAuthenticated).toBe(true);
      expect(res.body.membershipStatus).toBe("pending");
    });

    it("returns membershipStatus: 'active' for a confirmed member", async () => {
      // User has both a membership record and a matching proof
      configurePdsMocks({
        admins: [ADMIN_DID],
        membershipProofs: [{ memberDid: USER_DID, cid: MEMBERSHIP_CID }],
        userMemberships: [
          {
            community: COMMUNITY_DID,
            role: "member",
            cid: MEMBERSHIP_CID,
          },
        ],
      });

      const res = await agent
        .get(`/communities/${encodeURIComponent(COMMUNITY_DID)}`)
        .expect(200);

      expect(res.body.isMember).toBe(true);
      expect(res.body.isAuthenticated).toBe(true);
      expect(res.body.membershipStatus).toBe("active");
    });

    it("returns isMember: false and isAuthenticated: false for unauthenticated users", async () => {
      configurePdsMocks({
        admins: [ADMIN_DID],
        membershipProofs: [],
        userMemberships: [],
      });

      // Use a fresh supertest instance (no session cookie)
      const res = await supertest(app)
        .get(`/communities/${encodeURIComponent(COMMUNITY_DID)}`)
        .expect(200);

      expect(res.body.isMember).toBe(false);
      expect(res.body.isAuthenticated).toBe(false);
      expect(res.body).not.toHaveProperty("membershipStatus");
    });
  });

  describe("POST /communities/:did/join - pending member check", () => {
    it("returns already_member when user has a pending request", async () => {
      // No membership proof (not a confirmed member)
      configurePdsMocks({
        admins: [ADMIN_DID],
        membershipProofs: [],
        userMemberships: [],
      });

      // Insert a pending_members row
      await insertPendingMember(db, COMMUNITY_DID, USER_DID);

      try {
        const res = await agent
          .post(`/communities/${encodeURIComponent(COMMUNITY_DID)}/join`)
          .expect(200);

        expect(res.body.status).toBe("already_member");
        expect(res.body.message).toMatch(/pending/i);
      } finally {
        // Clean up the pending member row
        await db
          .deleteFrom("pending_members" as any)
          .where("community_did", "=", COMMUNITY_DID)
          .where("user_did", "=", USER_DID)
          .execute();
      }
    });

    it("returns already_member when user is already a confirmed member", async () => {
      // User has a membership proof
      configurePdsMocks({
        admins: [ADMIN_DID],
        membershipProofs: [{ memberDid: USER_DID, cid: MEMBERSHIP_CID }],
        userMemberships: [
          {
            community: COMMUNITY_DID,
            role: "member",
            cid: MEMBERSHIP_CID,
          },
        ],
      });

      const res = await agent
        .post(`/communities/${encodeURIComponent(COMMUNITY_DID)}/join`)
        .expect(200);

      expect(res.body.status).toBe("already_member");
    });
  });
});
