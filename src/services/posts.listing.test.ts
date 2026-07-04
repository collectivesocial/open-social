import { describe, it, expect, vi, beforeEach } from "vitest";

const { mocks } = vi.hoisted(() => ({
  mocks: {
    getSpaceClient: vi.fn(),
    getCommunitySpace: vi.fn(),
    withToken: vi.fn(),
    getCommunitySpaceCredential: vi.fn(),
    resolvePdsEndpoint: vi.fn(),
    listMemberships: vi.fn(),
  },
}));

vi.mock("./spaces", async (importOriginal) => {
  const actual = await importOriginal<any>();
  return {
    ...actual,
    getSpaceClient: mocks.getSpaceClient,
    getCommunitySpace: mocks.getCommunitySpace,
    SpaceClient: { ...actual.SpaceClient, withToken: mocks.withToken },
  };
});
vi.mock("./spaceCredentials", () => ({
  getCommunitySpaceCredential: mocks.getCommunitySpaceCredential,
}));
vi.mock("./atproto", () => ({
  resolvePdsEndpoint: mocks.resolvePdsEndpoint,
  createCommunityAgent: vi.fn(),
  getMemberAgent: vi.fn(),
}));
vi.mock("./membership", () => ({
  listMemberships: mocks.listMemberships,
  isMember: vi.fn(),
}));

import { listCommunityPosts } from "./posts";

const SPACE = "ats://did:plc:comm/community.opensocial.posts/abc";

describe("listCommunityPosts cross-repo reads", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getCommunitySpace.mockResolvedValue(SPACE);
    mocks.listMemberships.mockResolvedValue([
      { subject: "did:plc:member", status: "active", joinedAt: "x" },
    ]);
    mocks.getCommunitySpaceCredential.mockResolvedValue("credential-jwt");
    mocks.resolvePdsEndpoint.mockResolvedValue("http://member-pds.local");
    const communityClient = {
      listRecordValues: vi.fn(async () => [
        {
          rkey: "1",
          cid: "c1",
          value: {
            text: "own post",
            author: "did:plc:comm",
            createdAt: "2026-01-02T00:00:00Z",
          },
        },
      ]),
    };
    const memberClient = {
      listRecordValues: vi.fn(async () => [
        {
          rkey: "2",
          cid: "c2",
          value: {
            text: "member post",
            author: "did:plc:member",
            createdAt: "2026-01-03T00:00:00Z",
          },
        },
      ]),
    };
    mocks.getSpaceClient.mockResolvedValue(communityClient);
    mocks.withToken.mockReturnValue(memberClient);
  });

  it("reads member repos from the member's PDS with a space credential", async () => {
    const posts = await listCommunityPosts({} as any, "did:plc:comm");
    expect(posts.map((p) => p.text)).toEqual(["member post", "own post"]); // newest first
    expect(mocks.getCommunitySpaceCredential).toHaveBeenCalledWith(
      expect.anything(),
      "did:plc:comm",
      SPACE,
    );
    expect(mocks.resolvePdsEndpoint).toHaveBeenCalledWith("did:plc:member");
    expect(mocks.withToken).toHaveBeenCalledWith(
      expect.any(Function),
      "http://member-pds.local",
    );
  });

  it("skips a member repo that fails and keeps the rest", async () => {
    mocks.withToken.mockReturnValue({
      listRecordValues: vi.fn(async () => {
        throw new Error("boom");
      }),
    });
    const posts = await listCommunityPosts({} as any, "did:plc:comm");
    expect(posts.map((p) => p.text)).toEqual(["own post"]);
  });
});
