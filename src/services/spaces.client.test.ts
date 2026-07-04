import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SpaceClient } from "./spaces";

const fetchMock = vi.fn();
const agent = {
  session: { accessJwt: "jwt-abc", did: "did:plc:community" },
} as any;

function jsonResponse(body: unknown) {
  return {
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

describe("SpaceClient (simplespace split)", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("createSpace calls com.atproto.simplespace.createSpace with did/type/config", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        uri: "ats://did:plc:community/community.opensocial.posts/abc",
      }),
    );
    const client = new SpaceClient(agent, "http://pds.local");
    const config = {
      policy: "managing-app" as const,
      appAccess: { $type: "com.atproto.simplespace.defs#open" as const },
      managingApp: "did:web:localhost%3A3001#opensocial",
    };
    const res = await client.createSpace(
      "did:plc:community",
      "community.opensocial.posts",
      undefined,
      config,
    );
    expect(res.uri).toContain("community.opensocial.posts");
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe(
      "http://pds.local/xrpc/com.atproto.simplespace.createSpace",
    );
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({
      did: "did:plc:community",
      type: "community.opensocial.posts",
      config,
    });
    expect(init.headers.authorization).toBe("Bearer jwt-abc");
  });

  it("addMember calls com.atproto.simplespace.addMember", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({}));
    const client = new SpaceClient(agent, "http://pds.local");
    await client.addMember(
      "ats://x/community.opensocial.posts/a",
      "did:plc:bob",
    );
    const [url] = fetchMock.mock.calls[0];
    expect(String(url)).toBe(
      "http://pds.local/xrpc/com.atproto.simplespace.addMember",
    );
  });

  it("listMembers calls com.atproto.simplespace.listMembers", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ members: [{ did: "did:plc:bob" }] }),
    );
    const client = new SpaceClient(agent, "http://pds.local");
    const res = await client.listMembers(
      "ats://x/community.opensocial.posts/a",
      {},
    );
    expect(res.members).toEqual([{ did: "did:plc:bob" }]);
    const [url] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("/xrpc/com.atproto.simplespace.listMembers");
  });

  it("withToken authenticates with the provided token instead of an agent session", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ records: [] }));
    const client = SpaceClient.withToken(
      async () => "space-credential-jwt",
      "http://member-pds.local",
    );
    await client.listRecords(
      "ats://x/community.opensocial.posts/a",
      "community.opensocial.post",
      {},
      "did:plc:bob",
    );
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain(
      "http://member-pds.local/xrpc/com.atproto.space.listRecords",
    );
    expect(init.headers.authorization).toBe("Bearer space-credential-jwt");
  });

  it("record CRUD still uses com.atproto.space.*", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ uri: "u", cid: "c" }));
    const client = new SpaceClient(agent, "http://pds.local");
    await client.createRecord("ats://x/t/a", "community.opensocial.post", {
      $type: "community.opensocial.post",
    });
    const [url] = fetchMock.mock.calls[0];
    expect(String(url)).toBe(
      "http://pds.local/xrpc/com.atproto.space.createRecord",
    );
  });
});
