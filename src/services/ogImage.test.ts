import { describe, it, expect } from "vitest";
import {
  buildCommunityCardTree,
  renderCommunityCard,
  renderDefaultCard,
} from "./ogImage";

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

describe("buildCommunityCardTree (headline overflow regression guard)", () => {
  // This test intentionally pins the layout mechanism that prevents the
  // headline from overflowing the canvas: the text column must have the
  // exact derived width (canvas minus padding, avatar, and gap), and the
  // headline must combine display: "block" with lineClamp — satori only
  // applies lineClamp to block elements, so dropping either silently
  // reintroduces the overflow. Indexing into the known tree shape is
  // deliberate; if the layout structure changes, update this test alongside.
  it("pins the fixed-width text column and block/lineClamp headline", () => {
    const tree = buildCommunityCardTree({
      displayName:
        "The Extremely Long-Winded Society of People Who Never Abbreviate Anything At All Ever",
    });

    // Root children: [avatar, text column, bottom accent bar]
    const children = tree.props.children as Array<{
      props: { style: Record<string, unknown>; children?: unknown };
    }>;
    const textColumn = children[1];
    expect(textColumn.props.style.width).toBe(1200 - 2 * 96 - 300 - 72);

    // Text column children: [eyebrow, headline, subline]
    const columnChildren = textColumn.props.children as Array<{
      props: { style: Record<string, unknown>; children?: unknown };
    }>;
    const headline = columnChildren[1];
    expect(headline.props.children).toContain("Extremely Long-Winded");
    expect(headline.props.style.display).toBe("block");
    expect(headline.props.style.lineClamp).toBe(2);
  });
});

describe("renderDefaultCard", () => {
  it("renders the generic 1200x630 fallback card", async () => {
    const buf = await renderDefaultCard();
    expectValidCardPng(buf);
  });
});
