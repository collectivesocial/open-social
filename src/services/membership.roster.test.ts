import { describe, it, expect, vi, beforeEach } from "vitest";

const { mocks } = vi.hoisted(() => ({
  mocks: {
    getSpaceClient: vi.fn(),
    getCommunitySpace: vi.fn(),
    logSpy: vi.fn(),
    client: {
      createRecord: vi.fn(),
      addMember: vi.fn(),
      listRecords: vi.fn(),
      getRecord: vi.fn(),
      listRecordValues: vi.fn(),
    },
  },
}));

vi.mock("./spaces", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getSpaceClient: mocks.getSpaceClient,
  getCommunitySpace: mocks.getCommunitySpace,
}));
vi.mock("./auditLog", () => ({
  createAuditLogService: () => ({ log: mocks.logSpy }),
}));
import { recordMembership } from "./membership";

describe("recordMembership (post-shim)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getCommunitySpace.mockImplementation(
      async (_db: any, _did: string, kind: string) =>
        kind === "management"
          ? "ats://c/community.opensocial.management/m"
          : "ats://c/community.opensocial.posts/p",
    );
    mocks.getSpaceClient.mockResolvedValue(mocks.client);
    mocks.client.listRecordValues.mockResolvedValue([]); // empty roster
  });

  it("writes a membership record", async () => {
    await recordMembership({} as any, "did:plc:comm", "did:plc:new");
    expect(mocks.client.createRecord).toHaveBeenCalledWith(
      "ats://c/community.opensocial.management/m",
      "community.opensocial.membership",
      expect.objectContaining({ subject: "did:plc:new", status: "active" }),
    );
  });

  it("does NOT pre-materialize PDS member lists (no addMember)", async () => {
    await recordMembership({} as any, "did:plc:comm", "did:plc:new");
    expect(mocks.client.addMember).not.toHaveBeenCalled();
  });

  it("is idempotent for an existing subject", async () => {
    mocks.client.listRecordValues.mockResolvedValue([
      {
        rkey: "1",
        cid: "c",
        value: { subject: "did:plc:new", status: "active", joinedAt: "x" },
      },
    ]);
    await recordMembership({} as any, "did:plc:comm", "did:plc:new");
    expect(mocks.client.createRecord).not.toHaveBeenCalled();
  });

  it("logs member.joined for a new member", async () => {
    await recordMembership({} as any, "did:plc:comm", "did:plc:new", {
      approvedBy: "did:plc:admin",
    });
    expect(mocks.logSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        communityDid: "did:plc:comm",
        adminDid: "did:plc:admin",
        action: "member.joined",
        targetDid: "did:plc:new",
      }),
    );
  });

  it("falls back adminDid to the subject when no approvedBy is given", async () => {
    await recordMembership({} as any, "did:plc:comm", "did:plc:new");
    expect(mocks.logSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        adminDid: "did:plc:new",
      }),
    );
  });

  it("does not log member.joined on the idempotent path", async () => {
    mocks.client.listRecordValues.mockResolvedValue([
      {
        rkey: "1",
        cid: "c",
        value: { subject: "did:plc:new", status: "active", joinedAt: "x" },
      },
    ]);
    await recordMembership({} as any, "did:plc:comm", "did:plc:new");
    expect(mocks.logSpy).not.toHaveBeenCalled();
  });
});
