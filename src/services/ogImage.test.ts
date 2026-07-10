import { describe, it, expect } from "vitest";
import { renderCommunityCard, renderDefaultCard } from "./ogImage";

// A minimal valid 1x1 white JPEG for the avatar-embedding path.
const TINY_JPEG_DATA_URI =
  "data:image/jpeg;base64," +
  "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD3+iiigD//2Q==";

function pngDimensions(buf: Buffer): { width: number; height: number } {
  // PNG signature is 8 bytes; IHDR width/height are big-endian at 16/20.
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

function expectValidCardPng(buf: Buffer) {
  expect(buf.subarray(0, 8)).toEqual(
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  );
  expect(pngDimensions(buf)).toEqual({ width: 1200, height: 630 });
}

describe("renderCommunityCard", () => {
  it("renders a 1200x630 PNG with an avatar", async () => {
    const buf = await renderCommunityCard({
      displayName: "ATProtocol Developers",
      avatarDataUri: TINY_JPEG_DATA_URI,
    });
    expectValidCardPng(buf);
  });

  it("renders a 1200x630 PNG without an avatar (monogram fallback)", async () => {
    const buf = await renderCommunityCard({
      displayName: "ATProtocol Developers",
    });
    expectValidCardPng(buf);
  });

  it("handles very long community names without throwing", async () => {
    const buf = await renderCommunityCard({
      displayName:
        "The Extremely Long-Winded Society of People Who Never Abbreviate Anything At All Ever",
    });
    expectValidCardPng(buf);
  });

  it("handles names with characters satori must escape", async () => {
    const buf = await renderCommunityCard({
      displayName: 'Rock & <Roll> "Club"',
    });
    expectValidCardPng(buf);
  });
});

describe("renderDefaultCard", () => {
  it("renders the generic 1200x630 fallback card", async () => {
    const buf = await renderDefaultCard();
    expectValidCardPng(buf);
  });
});
