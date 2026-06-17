import { describe, it, expect } from "vitest";
import { aggregateAndSortPosts, type CommunityPost } from "./posts";

const p = (rkey: string, author: string, createdAt: string): CommunityPost => ({
  rkey,
  author,
  text: rkey,
  createdAt,
});

describe("aggregateAndSortPosts", () => {
  it("flattens per-author lists and sorts newest first", () => {
    const out = aggregateAndSortPosts([
      [p("a", "did:plc:1", "2026-01-02T00:00:00Z")],
      [
        p("b", "did:plc:2", "2026-01-01T00:00:00Z"),
        p("c", "did:plc:2", "2026-01-03T00:00:00Z"),
      ],
    ]);
    expect(out.map((x) => x.rkey)).toEqual(["c", "a", "b"]);
  });

  it("handles empty input", () => {
    expect(aggregateAndSortPosts([])).toEqual([]);
  });
});
