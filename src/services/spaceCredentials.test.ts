import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("./atproto", () => ({
  createCommunityAgent: vi.fn(async () => ({
    session: { accessJwt: "community-jwt", did: "did:plc:comm" },
  })),
  resolvePdsEndpoint: vi.fn(async () => "http://pds.local"),
}));

import {
  getCommunitySpaceCredential,
  parseJwtExp,
  clearCredentialCache,
} from "./spaceCredentials";

function fakeJwt(expSecondsFromNow: number): string {
  const payload = Buffer.from(
    JSON.stringify({ exp: Math.floor(Date.now() / 1000) + expSecondsFromNow }),
  ).toString("base64url");
  return `h.${payload}.s`;
}

const fetchMock = vi.fn();
const SPACE = "ats://did:plc:comm/community.opensocial.posts/abc";

describe("spaceCredentials", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockReset();
    clearCredentialCache();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("parseJwtExp reads exp in ms", () => {
    const jwt = fakeJwt(3600);
    expect(parseJwtExp(jwt)).toBeGreaterThan(Date.now() + 3000 * 1000);
  });

  it("exchanges delegation token for a credential", async () => {
    const credential = fakeJwt(7200);
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ token: "delegation-jwt" }),
      })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ credential }) });
    const result = await getCommunitySpaceCredential(
      {} as any,
      "did:plc:comm",
      SPACE,
    );
    expect(result).toBe(credential);

    const [url1, init1] = fetchMock.mock.calls[0];
    expect(String(url1)).toContain(
      "/xrpc/com.atproto.space.getDelegationToken",
    );
    expect(String(url1)).toContain(encodeURIComponent(SPACE));
    expect(init1.headers.authorization).toBe("Bearer community-jwt");

    const [url2, init2] = fetchMock.mock.calls[1];
    expect(String(url2)).toContain(
      "/xrpc/com.atproto.space.getSpaceCredential",
    );
    expect(init2.method).toBe("POST");
    expect(init2.headers.authorization).toBe("Bearer delegation-jwt");
    expect(JSON.parse(init2.body)).toEqual({ space: SPACE });
  });

  it("caches until near expiry", async () => {
    const credential = fakeJwt(7200);
    fetchMock
      .mockResolvedValueOnce({ ok: true, json: async () => ({ token: "t" }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ credential }) });
    await getCommunitySpaceCredential({} as any, "did:plc:comm", SPACE);
    await getCommunitySpaceCredential({} as any, "did:plc:comm", SPACE);
    expect(fetchMock).toHaveBeenCalledTimes(2); // not 4
  });

  it("re-fetches when the cached credential is near expiry", async () => {
    const nearExpiry = fakeJwt(60); // < 5 min buffer
    const fresh = fakeJwt(7200);
    fetchMock
      .mockResolvedValueOnce({ ok: true, json: async () => ({ token: "t1" }) })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ credential: nearExpiry }),
      })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ token: "t2" }) })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ credential: fresh }),
      });
    await getCommunitySpaceCredential({} as any, "did:plc:comm", SPACE);
    const second = await getCommunitySpaceCredential(
      {} as any,
      "did:plc:comm",
      SPACE,
    );
    expect(second).toBe(fresh);
  });

  it("throws on a failed exchange", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 401,
      text: async () => "denied",
    });
    await expect(
      getCommunitySpaceCredential({} as any, "did:plc:comm", SPACE),
    ).rejects.toThrow(/getDelegationToken/);
  });

  it("labels network-level failures with the failing call name", async () => {
    fetchMock.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    await expect(
      getCommunitySpaceCredential({} as any, "did:plc:comm", SPACE),
    ).rejects.toThrow(/getDelegationToken.*ECONNREFUSED/);
  });

  it("labels a failed getSpaceCredential call", async () => {
    fetchMock
      .mockResolvedValueOnce({ ok: true, json: async () => ({ token: "t" }) })
      .mockResolvedValueOnce({
        ok: false,
        status: 403,
        text: async () => "nope",
      });
    await expect(
      getCommunitySpaceCredential({} as any, "did:plc:comm", SPACE),
    ).rejects.toThrow(/getSpaceCredential.*403/);
  });
});
