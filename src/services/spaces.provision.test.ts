import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockClient, mockDb } = vi.hoisted(() => {
  const mockClient = { createSpace: vi.fn() };
  // Minimal kysely stub: no existing rows, capture inserts.
  const inserts: any[] = [];
  const mockDb = {
    inserts,
    selectFrom: () => ({
      select: () => ({
        where: () => ({
          execute: async () => [],
          executeTakeFirst: async () => undefined,
        }),
      }),
    }),
    insertInto: () => ({
      values: (v: any) => ({
        onConflict: () => ({
          execute: async () => {
            inserts.push(v);
          },
        }),
      }),
    }),
  } as any;
  return { mockClient, mockDb };
});

vi.mock("./atproto", () => ({
  createCommunityAgent: vi.fn(async () => ({})),
  resolvePdsEndpoint: vi.fn(async () => "http://pds.local"),
  getMemberAgent: vi.fn(),
}));

import {
  provisionCommunitySpaces,
  buildManagedSpaceConfig,
  SpaceClient,
} from "./spaces";

vi.spyOn(SpaceClient.prototype as any, "createSpace").mockImplementation(
  mockClient.createSpace,
);

describe("provisionCommunitySpaces with managing-app", () => {
  beforeEach(() => {
    process.env.OPENSOCIAL_SERVICE_DID = "did:web:localhost%3A3001";
    mockClient.createSpace.mockReset();
    mockClient.createSpace.mockImplementation(
      async (_did: string, type: string) => ({
        uri: `ats://did:plc:comm/${type}/self`,
      }),
    );
    mockDb.inserts.length = 0;
  });

  it("buildManagedSpaceConfig sets policy, open appAccess, and managingApp", () => {
    expect(
      buildManagedSpaceConfig("did:web:localhost%3A3001#opensocial"),
    ).toEqual({
      policy: "managing-app",
      appAccess: { $type: "com.atproto.simplespace.defs#open" },
      managingApp: "did:web:localhost%3A3001#opensocial",
    });
  });

  it("passes the managed config to createSpace for both kinds", async () => {
    await provisionCommunitySpaces(mockDb, "did:plc:comm");
    expect(mockClient.createSpace).toHaveBeenCalledTimes(2);
    for (const call of mockClient.createSpace.mock.calls) {
      expect(call[3]).toEqual(
        buildManagedSpaceConfig("did:web:localhost%3A3001#opensocial"),
      );
    }
  });
});
