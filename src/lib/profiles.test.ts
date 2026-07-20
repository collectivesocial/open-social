import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { resolveProfile, resolveProfiles, profileCache } from "./profiles";

function profileResponse(profiles: Array<Record<string, unknown>>) {
  return {
    ok: true,
    json: async () => ({ profiles }),
  };
}

describe("profiles", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    profileCache.clear();
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("resolveProfile", () => {
    it("fetches and caches a profile", async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        json: async () => ({
          handle: "alice.test",
          displayName: "Alice",
          avatar: "http://a/img",
        }),
      });

      const first = await resolveProfile("did:plc:alice");
      const second = await resolveProfile("did:plc:alice");

      expect(first).toEqual({
        handle: "alice.test",
        displayName: "Alice",
        avatar: "http://a/img",
      });
      expect(second).toEqual(first);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("returns null fields and caches the miss when the fetch fails", async () => {
      fetchMock.mockRejectedValue(new Error("timeout"));

      const result = await resolveProfile("did:plc:gone");
      await resolveProfile("did:plc:gone");

      expect(result).toEqual({ handle: null, displayName: null, avatar: null });
      expect(fetchMock).toHaveBeenCalledTimes(1); // negative result cached
    });

    it("returns null fields on a non-ok response", async () => {
      fetchMock.mockResolvedValue({ ok: false, status: 400 });

      const result = await resolveProfile("did:plc:bad");

      expect(result).toEqual({ handle: null, displayName: null, avatar: null });
    });
  });

  describe("resolveProfiles", () => {
    it("chunks requests at 25 actors per getProfiles call", async () => {
      const dids = Array.from({ length: 60 }, (_, i) => `did:plc:user${i}`);
      fetchMock.mockImplementation(async (url: string) => {
        const actors = new URL(url).searchParams.getAll("actors");
        expect(actors.length).toBeLessThanOrEqual(25);
        return profileResponse(
          actors.map((did) => ({ did, handle: `${did}.test` })),
        );
      });

      const result = await resolveProfiles(dids);

      expect(fetchMock).toHaveBeenCalledTimes(3); // 25 + 25 + 10
      expect(result.size).toBe(60);
      expect(result.get("did:plc:user0")?.handle).toBe("did:plc:user0.test");
    });

    it("serves cache hits without fetching", async () => {
      profileCache.set("did:plc:cached", {
        handle: "c.test",
        displayName: null,
        avatar: null,
      });

      const result = await resolveProfiles(["did:plc:cached"]);

      expect(result.get("did:plc:cached")?.handle).toBe("c.test");
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("deduplicates requested DIDs", async () => {
      fetchMock.mockImplementation(async (url: string) => {
        const actors = new URL(url).searchParams.getAll("actors");
        expect(actors).toEqual(["did:plc:dup"]);
        return profileResponse([{ did: "did:plc:dup", handle: "dup.test" }]);
      });

      const result = await resolveProfiles(["did:plc:dup", "did:plc:dup"]);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(result.get("did:plc:dup")?.handle).toBe("dup.test");
    });

    it("maps DIDs missing from the batch response to empty profiles", async () => {
      fetchMock.mockResolvedValue(
        profileResponse([{ did: "did:plc:found", handle: "found.test" }]),
      );

      const result = await resolveProfiles([
        "did:plc:found",
        "did:plc:deleted",
      ]);

      expect(result.get("did:plc:found")?.handle).toBe("found.test");
      expect(result.get("did:plc:deleted")).toEqual({
        handle: null,
        displayName: null,
        avatar: null,
      });
    });

    it("falls back to per-DID lookups when the batch call fails", async () => {
      fetchMock.mockImplementation(async (url: string) => {
        if (url.includes("getProfiles")) {
          return { ok: false, status: 500 };
        }
        const actor = new URL(url).searchParams.get("actor");
        return {
          ok: true,
          json: async () => ({ did: actor, handle: `${actor}.solo` }),
        };
      });

      const result = await resolveProfiles(["did:plc:a", "did:plc:b"]);

      expect(result.get("did:plc:a")?.handle).toBe("did:plc:a.solo");
      expect(result.get("did:plc:b")?.handle).toBe("did:plc:b.solo");
    });
  });
});
