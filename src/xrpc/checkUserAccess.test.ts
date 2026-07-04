import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

const { mocks } = vi.hoisted(() => ({
  mocks: {
    verifyServiceAuth: vi.fn(),
    getCommunitySpaceByUri: vi.fn(),
    listMemberships: vi.fn(),
    actorCan: vi.fn(),
  },
}));

vi.mock("./serviceAuth", () => ({
  verifyServiceAuth: mocks.verifyServiceAuth,
  ServiceAuthError: class ServiceAuthError extends Error {
    constructor(
      public status: number,
      message: string,
    ) {
      super(message);
    }
  },
}));
vi.mock("../services/spaces", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getCommunitySpaceByUri: mocks.getCommunitySpaceByUri,
}));
vi.mock("../services/membership", () => ({
  listMemberships: mocks.listMemberships,
}));
vi.mock("../services/roles", () => ({ actorCan: mocks.actorCan }));

import {
  decideUserAccess,
  createCheckUserAccessHandler,
} from "./checkUserAccess";

const SPACE = "ats://did:plc:comm/community.opensocial.posts/abc";

function appWith(handler: any) {
  const app = express();
  app.get("/xrpc/com.atproto.simplespace.checkUserAccess", handler);
  return app;
}

describe("decideUserAccess", () => {
  const roster = [
    {
      subject: "did:plc:member",
      status: "active" as const,
      joinedAt: "2026-01-01T00:00:00Z",
    },
    {
      subject: "did:plc:pending",
      status: "pending" as const,
      joinedAt: "2026-01-01T00:00:00Z",
    },
  ];

  it("authorizes the community itself for any space", () => {
    expect(
      decideUserAccess({
        kind: "management",
        communityDid: "did:plc:comm",
        user: "did:plc:comm",
        roster: [],
        userCanManage: false,
      }),
    ).toBe(true);
  });
  it("authorizes active members for the posts space", () => {
    expect(
      decideUserAccess({
        kind: "posts",
        communityDid: "did:plc:comm",
        user: "did:plc:member",
        roster,
        userCanManage: false,
      }),
    ).toBe(true);
  });
  it("rejects pending members for the posts space", () => {
    expect(
      decideUserAccess({
        kind: "posts",
        communityDid: "did:plc:comm",
        user: "did:plc:pending",
        roster,
        userCanManage: false,
      }),
    ).toBe(false);
  });
  it("authorizes only managers for the management space", () => {
    expect(
      decideUserAccess({
        kind: "management",
        communityDid: "did:plc:comm",
        user: "did:plc:member",
        roster,
        userCanManage: false,
      }),
    ).toBe(false);
    expect(
      decideUserAccess({
        kind: "management",
        communityDid: "did:plc:comm",
        user: "did:plc:member",
        roster,
        userCanManage: true,
      }),
    ).toBe(true);
  });
});

describe("checkUserAccess handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.verifyServiceAuth.mockResolvedValue({
      iss: "did:plc:comm",
      aud: "did:web:localhost%3A3001#opensocial",
    });
    mocks.getCommunitySpaceByUri.mockResolvedValue({
      community_did: "did:plc:comm",
      kind: "posts",
      space_uri: SPACE,
    });
    mocks.listMemberships.mockResolvedValue([
      { subject: "did:plc:member", status: "active", joinedAt: "x" },
    ]);
    mocks.actorCan.mockResolvedValue(false);
  });

  it("authorizes an active member", async () => {
    const app = appWith(createCheckUserAccessHandler({} as any));
    const res = await request(app)
      .get("/xrpc/com.atproto.simplespace.checkUserAccess")
      .query({ space: SPACE, user: "did:plc:member" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ authorized: true });
  });

  it("rejects when the issuer is not the space's community", async () => {
    mocks.verifyServiceAuth.mockResolvedValue({
      iss: "did:plc:someone-else",
      aud: "x",
    });
    const app = appWith(createCheckUserAccessHandler({} as any));
    const res = await request(app)
      .get("/xrpc/com.atproto.simplespace.checkUserAccess")
      .query({ space: SPACE, user: "did:plc:member" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ authorized: false });
  });

  it("answers authorized:false for unknown spaces", async () => {
    mocks.getCommunitySpaceByUri.mockResolvedValue(null);
    const app = appWith(createCheckUserAccessHandler({} as any));
    const res = await request(app)
      .get("/xrpc/com.atproto.simplespace.checkUserAccess")
      .query({ space: "ats://did:plc:x/t/unknown", user: "did:plc:member" });
    expect(res.body).toEqual({ authorized: false });
  });

  it("401s when service auth fails", async () => {
    const { ServiceAuthError } = await import("./serviceAuth");
    mocks.verifyServiceAuth.mockRejectedValue(
      new ServiceAuthError(401, "nope"),
    );
    const app = appWith(createCheckUserAccessHandler({} as any));
    const res = await request(app)
      .get("/xrpc/com.atproto.simplespace.checkUserAccess")
      .query({ space: SPACE, user: "did:plc:member" });
    expect(res.status).toBe(401);
  });

  it("400s on missing params", async () => {
    const app = appWith(createCheckUserAccessHandler({} as any));
    const res = await request(app).get(
      "/xrpc/com.atproto.simplespace.checkUserAccess",
    );
    expect(res.status).toBe(400);
  });
});
