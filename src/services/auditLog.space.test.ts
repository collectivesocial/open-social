import { describe, it, expect, vi, beforeEach } from "vitest";

const { mocks } = vi.hoisted(() => ({
  mocks: {
    getCommunitySpace: vi.fn(),
    getSpaceClient: vi.fn(),
    client: { createRecord: vi.fn(async () => ({ uri: "u", cid: "c" })) },
  },
}));

vi.mock("./spaces", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getCommunitySpace: mocks.getCommunitySpace,
  getSpaceClient: mocks.getSpaceClient,
}));

import { createAuditLogService, AUDIT_LOG_ENTRY } from "./auditLog";

const MGMT = "ats://did:plc:comm/community.opensocial.management/m";

function stubDb(opts: { failInsert?: boolean } = {}) {
  const execute = opts.failInsert
    ? vi.fn(async () => {
        throw new Error("pg down");
      })
    : vi.fn(async () => []);
  const values = vi.fn(() => ({ execute }));
  const insertInto = vi.fn(() => ({ values }));
  return { db: { insertInto } as any, insertInto, values, execute };
}

describe("audit log dual-write", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getCommunitySpace.mockResolvedValue(MGMT);
    mocks.getSpaceClient.mockResolvedValue(mocks.client);
    mocks.client.createRecord.mockClear();
    mocks.client.createRecord.mockResolvedValue({ uri: "u", cid: "c" });
  });

  it("writes Postgres AND an auditLogEntry record into the management space", async () => {
    const { db, insertInto } = stubDb();
    await createAuditLogService(db).log({
      communityDid: "did:plc:comm",
      adminDid: "did:plc:admin",
      action: "member.approved",
      targetDid: "did:plc:new",
      reason: "welcome",
      metadata: { via: "test" },
    });
    expect(insertInto).toHaveBeenCalledWith("audit_log");
    expect(mocks.client.createRecord).toHaveBeenCalledTimes(1);
    const [space, collection, record] = mocks.client.createRecord.mock.calls[0];
    expect(space).toBe(MGMT);
    expect(collection).toBe(AUDIT_LOG_ENTRY);
    expect(record).toEqual({
      $type: AUDIT_LOG_ENTRY,
      actor: "did:plc:admin",
      action: "member.approved",
      target: "did:plc:new",
      reason: "welcome",
      metadata: { via: "test" },
      createdAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    });
  });

  it("omits optional fields when absent (no nulls)", async () => {
    const { db } = stubDb();
    await createAuditLogService(db).log({
      communityDid: "did:plc:comm",
      adminDid: "did:plc:admin",
      action: "community.updated",
    });
    const record = mocks.client.createRecord.mock.calls[0][2];
    expect(record).not.toHaveProperty("target");
    expect(record).not.toHaveProperty("reason");
    expect(record).not.toHaveProperty("metadata");
  });

  it("skips the space write when no management space is provisioned", async () => {
    mocks.getCommunitySpace.mockResolvedValue(null);
    const { db, insertInto } = stubDb();
    await createAuditLogService(db).log({
      communityDid: "did:plc:legacy",
      adminDid: "did:plc:admin",
      action: "member.joined",
    });
    expect(insertInto).toHaveBeenCalled();
    expect(mocks.getSpaceClient).not.toHaveBeenCalled();
    expect(mocks.client.createRecord).not.toHaveBeenCalled();
  });

  it("still writes the space record when the Postgres insert fails", async () => {
    const { db } = stubDb({ failInsert: true });
    await expect(
      createAuditLogService(db).log({
        communityDid: "did:plc:comm",
        adminDid: "did:plc:admin",
        action: "member.joined",
      }),
    ).resolves.toBeUndefined();
    expect(mocks.client.createRecord).toHaveBeenCalledTimes(1);
  });

  it("still writes Postgres and never throws when the space write fails", async () => {
    mocks.client.createRecord.mockRejectedValue(new Error("space down"));
    const { db, insertInto } = stubDb();
    await expect(
      createAuditLogService(db).log({
        communityDid: "did:plc:comm",
        adminDid: "did:plc:admin",
        action: "member.joined",
      }),
    ).resolves.toBeUndefined();
    expect(insertInto).toHaveBeenCalled();
  });

  it("never throws when the space lookup itself fails", async () => {
    mocks.getCommunitySpace.mockRejectedValue(new Error("db blip"));
    const { db } = stubDb();
    await expect(
      createAuditLogService(db).log({
        communityDid: "did:plc:comm",
        adminDid: "did:plc:admin",
        action: "member.joined",
      }),
    ).resolves.toBeUndefined();
  });
});
