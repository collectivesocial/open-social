import { describe, it, expect, vi, beforeEach } from "vitest";

const { mocks } = vi.hoisted(() => ({
  mocks: {
    getSpaceClient: vi.fn(),
    getCommunitySpace: vi.fn(),
    logSpy: vi.fn(),
    client: {
      putRecord: vi.fn(async () => ({ uri: "u", cid: "c" })),
      createRecord: vi.fn(async () => ({ uri: "u", cid: "c" })),
      listRecordValues: vi.fn(async () => []),
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

import { writeRoleDefinition, assignRole } from "./roles";

describe("role governance audit points", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getCommunitySpace.mockResolvedValue(
      "ats://c/community.opensocial.management/m",
    );
    mocks.getSpaceClient.mockResolvedValue(mocks.client);
    mocks.client.listRecordValues.mockResolvedValue([]);
  });

  it("writeRoleDefinition logs role.created with name and capabilities", async () => {
    await writeRoleDefinition(
      {} as any,
      "did:plc:comm",
      "moderator",
      "Moderator",
      ["post"],
    );
    expect(mocks.logSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        communityDid: "did:plc:comm",
        adminDid: "did:plc:comm",
        action: "role.created",
        metadata: { name: "moderator", capabilities: ["post"] },
      }),
    );
  });

  it("assignRole logs role.assigned with actor fallback to community DID", async () => {
    await assignRole({} as any, "did:plc:comm", "did:plc:bob", "moderator");
    expect(mocks.logSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        adminDid: "did:plc:comm",
        action: "role.assigned",
        targetDid: "did:plc:bob",
        metadata: { role: "moderator" },
      }),
    );
  });

  it("assignRole logs the assigner as actor when provided", async () => {
    await assignRole(
      {} as any,
      "did:plc:comm",
      "did:plc:bob",
      "moderator",
      "did:plc:admin",
    );
    expect(mocks.logSpy).toHaveBeenCalledWith(
      expect.objectContaining({ adminDid: "did:plc:admin" }),
    );
  });

  it("assignRole does not log on the idempotent path (assignment already exists)", async () => {
    mocks.client.listRecordValues.mockResolvedValue([
      {
        rkey: "1",
        cid: "c",
        value: { subject: "did:plc:bob", role: "moderator" },
      },
    ]);
    await assignRole({} as any, "did:plc:comm", "did:plc:bob", "moderator");
    expect(mocks.logSpy).not.toHaveBeenCalled();
  });
});
