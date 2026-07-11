import { describe, it, expect, vi, beforeEach } from "vitest";
import { getCommunityCardData, isAllowedAvatarUrl } from "./ogCard";

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

  it("rejects a string avatar URL on a foreign host (SSRF guard)", async () => {
    getRecordMock.mockResolvedValue({
      data: { value: { avatar: "http://169.254.169.254/latest/meta-data" } },
    });
    vi.mocked(blobToUrl).mockReturnValue(
      "http://169.254.169.254/latest/meta-data",
    );
    // The Bluesky fallback is also consulted once the profile avatar is
    // rejected — make it explicit that it yields nothing here too.
    vi.mocked(fetchBlueskyAvatar).mockResolvedValue(undefined);

    const data = await getCommunityCardData(stubDb(ROW), DID);
    expect(data?.avatarUrl).toBeUndefined();
  });

  it("keeps a string avatar URL whose host matches the community's pds_host", async () => {
    getRecordMock.mockResolvedValue({
      data: { value: { avatar: "https://pds.example.com/avatar.jpg" } },
    });
    vi.mocked(blobToUrl).mockReturnValue("https://pds.example.com/avatar.jpg");

    const data = await getCommunityCardData(stubDb(ROW), DID);
    expect(data?.avatarUrl).toBe("https://pds.example.com/avatar.jpg");
  });

  it("keeps a cdn.bsky.app URL from the Bluesky avatar fallback", async () => {
    vi.mocked(fetchBlueskyAvatar).mockResolvedValue(
      "https://cdn.bsky.app/img/a@jpeg",
    );

    const data = await getCommunityCardData(stubDb(ROW), DID);
    expect(data?.avatarUrl).toBe("https://cdn.bsky.app/img/a@jpeg");
  });

  it("rejects a non-http(s) scheme avatar URL", async () => {
    getRecordMock.mockResolvedValue({
      data: { value: { avatar: "file:///etc/passwd" } },
    });
    vi.mocked(blobToUrl).mockReturnValue("file:///etc/passwd");
    vi.mocked(fetchBlueskyAvatar).mockResolvedValue(undefined);

    const data = await getCommunityCardData(stubDb(ROW), DID);
    expect(data?.avatarUrl).toBeUndefined();
  });
});

describe("isAllowedAvatarUrl", () => {
  const PDS_HOST = "https://pds.example.com";

  it("returns false when the URL does not parse", () => {
    expect(isAllowedAvatarUrl("not a url", PDS_HOST)).toBe(false);
  });

  it("returns false for non-http(s) schemes", () => {
    expect(isAllowedAvatarUrl("file:///etc/passwd", PDS_HOST)).toBe(false);
  });

  it("allows cdn.bsky.app regardless of pdsHost", () => {
    expect(isAllowedAvatarUrl("https://cdn.bsky.app/img/a", PDS_HOST)).toBe(
      true,
    );
  });

  it("allows an exact pdsHost hostname match", () => {
    expect(isAllowedAvatarUrl("https://pds.example.com/blob/x", PDS_HOST)).toBe(
      true,
    );
  });

  it("rejects a mismatched hostname", () => {
    expect(isAllowedAvatarUrl("https://evil.example.com/x", PDS_HOST)).toBe(
      false,
    );
  });

  it("only allows cdn.bsky.app when pdsHost itself does not parse", () => {
    expect(
      isAllowedAvatarUrl("https://cdn.bsky.app/img/a", "not-a-valid-host"),
    ).toBe(true);
    expect(
      isAllowedAvatarUrl("https://not-a-valid-host/img/a", "not-a-valid-host"),
    ).toBe(false);
  });
});
