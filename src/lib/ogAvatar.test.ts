import { describe, it, expect, vi, afterEach } from "vitest";
import { preferJpegCdnUrl, fetchAvatarAsDataUri } from "./ogAvatar";

const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const PNG_BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);
const WEBP_BYTES = new Uint8Array([
  0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
]);

function mockFetchOk(bytes: Uint8Array) {
  return vi.fn(async () => ({
    ok: true,
    arrayBuffer: async () => bytes.buffer,
  })) as unknown as typeof fetch;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("preferJpegCdnUrl", () => {
  it("appends @jpeg to bare cdn.bsky.app image URLs", () => {
    expect(
      preferJpegCdnUrl(
        "https://cdn.bsky.app/img/avatar/plain/did:plc:x/bafyabc",
      ),
    ).toBe("https://cdn.bsky.app/img/avatar/plain/did:plc:x/bafyabc@jpeg");
  });

  it("leaves cdn URLs that already have a format suffix alone", () => {
    const url = "https://cdn.bsky.app/img/avatar/plain/did:plc:x/bafyabc@jpeg";
    expect(preferJpegCdnUrl(url)).toBe(url);
  });

  it("leaves cdn URLs with an @webp suffix alone (no @webp@jpeg)", () => {
    const url = "https://cdn.bsky.app/img/avatar/plain/did:plc:x/bafyabc@webp";
    expect(preferJpegCdnUrl(url)).toBe(url);
  });

  it("leaves non-CDN URLs alone", () => {
    const url =
      "https://pds.example.com/xrpc/com.atproto.sync.getBlob?did=x&cid=y";
    expect(preferJpegCdnUrl(url)).toBe(url);
  });

  it("returns invalid URLs unchanged", () => {
    expect(preferJpegCdnUrl("not a url")).toBe("not a url");
  });
});

describe("fetchAvatarAsDataUri", () => {
  it("returns a jpeg data URI for jpeg bytes", async () => {
    vi.stubGlobal("fetch", mockFetchOk(JPEG_BYTES));
    const uri = await fetchAvatarAsDataUri("https://example.com/a.jpg");
    expect(uri).toMatch(/^data:image\/jpeg;base64,/);
    expect(uri).toContain(Buffer.from(JPEG_BYTES).toString("base64"));
  });

  it("returns a png data URI for png bytes", async () => {
    vi.stubGlobal("fetch", mockFetchOk(PNG_BYTES));
    const uri = await fetchAvatarAsDataUri("https://example.com/a.png");
    expect(uri).toMatch(/^data:image\/png;base64,/);
  });

  it("returns undefined for webp bytes (satori cannot decode them)", async () => {
    vi.stubGlobal("fetch", mockFetchOk(WEBP_BYTES));
    expect(
      await fetchAvatarAsDataUri("https://example.com/a.webp"),
    ).toBeUndefined();
  });

  it("returns undefined on non-ok responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        arrayBuffer: async () => new ArrayBuffer(0),
      })),
    );
    expect(
      await fetchAvatarAsDataUri("https://example.com/404.jpg"),
    ).toBeUndefined();
  });

  it("returns undefined when fetch throws (network error / abort)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("aborted");
      }),
    );
    expect(
      await fetchAvatarAsDataUri("https://example.com/slow.jpg"),
    ).toBeUndefined();
  });

  it("requests the @jpeg variant of bare cdn.bsky.app URLs", async () => {
    const fetchMock = mockFetchOk(JPEG_BYTES);
    vi.stubGlobal("fetch", fetchMock);
    await fetchAvatarAsDataUri(
      "https://cdn.bsky.app/img/avatar/plain/did:plc:x/bafyabc",
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "https://cdn.bsky.app/img/avatar/plain/did:plc:x/bafyabc@jpeg",
      expect.anything(),
    );
  });

  it("fetches with redirect: 'error' so an allowlisted host can't redirect elsewhere", async () => {
    const fetchMock = mockFetchOk(JPEG_BYTES);
    vi.stubGlobal("fetch", fetchMock);
    await fetchAvatarAsDataUri("https://example.com/a.jpg");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://example.com/a.jpg",
      expect.objectContaining({ redirect: "error" }),
    );
  });
});
