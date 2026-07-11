import { describe, it, expect, vi, beforeEach } from "vitest";
import { getCommunityCardData } from "./ogCard";

const DID = "did:plc:testcommunity000000001";

const { getRecordMock } = vi.hoisted(() => ({ getRecordMock: vi.fn() }));

vi.mock("@atproto/api", () => ({
  BskyAgent: class {
    api = { com: { atproto: { repo: { getRecord: getRecordMock } } } };
  },
}));

vi.mock("./atproto", () => ({
  resolvePdsEndpoint: vi.fn(async () => "https://pds.example.com"),
}));

vi.mock("../lib/avatar", () => ({
  blobToUrl: vi.fn(() => undefined),
  fetchBlueskyAvatar: vi.fn(async () => undefined),
}));

import { blobToUrl, fetchBlueskyAvatar } from "../lib/avatar";

// Minimal chainable stand-in for the Kysely communities lookup.
function stubDb(row: Record<string, unknown> | undefined) {
  return {
    selectFrom: () => ({
      select: () => ({
        where: () => ({ executeTakeFirst: async () => row }),
      }),
    }),
  } as any;
}

const ROW = {
  did: DID,
  handle: "test-community.bsky.social",
  display_name: "Test Community",
  pds_host: "https://pds.example.com",
};

beforeEach(() => {
  vi.clearAllMocks();
  getRecordMock.mockRejectedValue(new Error("RecordNotFound"));
});

describe("getCommunityCardData", () => {
  it("returns null when the community does not exist", async () => {
    expect(await getCommunityCardData(stubDb(undefined), DID)).toBeNull();
  });

  it("falls back to the DB display_name when there is no profile record", async () => {
    const data = await getCommunityCardData(stubDb(ROW), DID);
    expect(data).toEqual({
      displayName: "Test Community",
      description: undefined,
      avatarUrl: undefined,
    });
  });

  it("prefers the profile record displayName, description, and avatar", async () => {
    getRecordMock.mockResolvedValue({
      data: {
        value: {
          displayName: "Profile Name",
          description: "A great community.",
          avatar: {
            $type: "blob",
            ref: { $link: "bafyavatar" },
            mimeType: "image/jpeg",
          },
        },
      },
    });
    vi.mocked(blobToUrl).mockReturnValue(
      "https://pds.example.com/blob/bafyavatar",
    );

    const data = await getCommunityCardData(stubDb(ROW), DID);
    expect(data).toEqual({
      displayName: "Profile Name",
      description: "A great community.",
      avatarUrl: "https://pds.example.com/blob/bafyavatar",
    });
  });

  it("falls back to the Bluesky avatar when the profile has none", async () => {
    vi.mocked(fetchBlueskyAvatar).mockResolvedValue(
      "https://cdn.bsky.app/img/a@jpeg",
    );
    const data = await getCommunityCardData(stubDb(ROW), DID);
    expect(data?.avatarUrl).toBe("https://cdn.bsky.app/img/a@jpeg");
  });

  it("uses the handle when display_name is empty", async () => {
    const data = await getCommunityCardData(
      stubDb({ ...ROW, display_name: "" }),
      DID,
    );
    expect(data?.displayName).toBe("test-community.bsky.social");
  });
});
