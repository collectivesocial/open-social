import { describe, it, expect, vi, beforeEach } from "vitest";
import supertest from "supertest";
import express from "express";
import { createOgRouter, escapeHtml } from "./og";

vi.mock("../services/ogCard", () => ({ getCommunityCardData: vi.fn() }));
vi.mock("../services/ogImage", () => ({ renderCommunityCard: vi.fn() }));
vi.mock("../lib/ogAvatar", () => ({
  fetchAvatarAsDataUri: vi.fn(async () => undefined),
}));

import { getCommunityCardData } from "../services/ogCard";
import { renderCommunityCard } from "../services/ogImage";
import { fetchAvatarAsDataUri } from "../lib/ogAvatar";

const FAKE_PNG = Buffer.from("fake-png-bytes");

function buildApp() {
  const app = express();
  app.use(createOgRouter({} as any));
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(renderCommunityCard).mockResolvedValue(FAKE_PNG);
});

describe("escapeHtml", () => {
  it("escapes HTML metacharacters", () => {
    expect(escapeHtml(`Rock & <Roll> "Club" 'n stuff`)).toBe(
      "Rock &amp; &lt;Roll&gt; &quot;Club&quot; &#39;n stuff",
    );
  });
});

describe("GET /communities/:did/og-image", () => {
  it("returns the rendered PNG with cache headers", async () => {
    // Unique DID per test — the route keeps a module-level PNG cache.
    const did = "did:plc:png0000000000000000001";
    vi.mocked(getCommunityCardData).mockResolvedValue({ displayName: "Test" });

    const res = await supertest(buildApp()).get(
      `/communities/${encodeURIComponent(did)}/og-image`,
    );

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("image/png");
    expect(res.headers["cache-control"]).toBe("public, max-age=3600");
    expect(res.body).toEqual(FAKE_PNG);
  });

  it("passes the fetched avatar data URI to the renderer", async () => {
    const did = "did:plc:png0000000000000000002";
    vi.mocked(getCommunityCardData).mockResolvedValue({
      displayName: "Test",
      avatarUrl: "https://cdn.bsky.app/img/a",
    });
    vi.mocked(fetchAvatarAsDataUri).mockResolvedValue(
      "data:image/jpeg;base64,xyz",
    );

    await supertest(buildApp()).get(
      `/communities/${encodeURIComponent(did)}/og-image`,
    );

    expect(fetchAvatarAsDataUri).toHaveBeenCalledWith(
      "https://cdn.bsky.app/img/a",
    );
    expect(renderCommunityCard).toHaveBeenCalledWith({
      displayName: "Test",
      avatarDataUri: "data:image/jpeg;base64,xyz",
    });
  });

  it("serves repeat requests from the in-memory cache", async () => {
    const did = "did:plc:png0000000000000000003";
    vi.mocked(getCommunityCardData).mockResolvedValue({ displayName: "Test" });

    const app = buildApp();
    await supertest(app).get(
      `/communities/${encodeURIComponent(did)}/og-image`,
    );
    const second = await supertest(app).get(
      `/communities/${encodeURIComponent(did)}/og-image`,
    );

    expect(second.status).toBe(200);
    expect(renderCommunityCard).toHaveBeenCalledTimes(1);
  });

  it("404s for unknown communities", async () => {
    vi.mocked(getCommunityCardData).mockResolvedValue(null);
    const res = await supertest(buildApp()).get(
      "/communities/did%3Aplc%3Amissing0000000000001/og-image",
    );
    expect(res.status).toBe(404);
  });
});

describe("GET /communities/:did/share", () => {
  const DID = "did:plc:share00000000000000001";
  const ENCODED = encodeURIComponent(DID);

  it("serves OG meta tags with escaped values and a redirect", async () => {
    vi.mocked(getCommunityCardData).mockResolvedValue({
      displayName: 'Rock & <Roll> "Club"',
      description: "Loud & proud.",
    });

    const res = await supertest(buildApp()).get(
      `/communities/${ENCODED}/share`,
    );

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.headers["cache-control"]).toBe("public, max-age=300");
    expect(res.text).toContain(
      'og:title" content="Join Rock &amp; &lt;Roll&gt; &quot;Club&quot; on Open Social"',
    );
    expect(res.text).toContain('og:description" content="Loud &amp; proud."');
    expect(res.text).toContain(`/communities/${ENCODED}/og-image`);
    expect(res.text).toContain(
      'name="twitter:card" content="summary_large_image"',
    );
    // Redirect target preserves the join flow.
    expect(res.text).toContain(`/communities/${ENCODED}?action=join`);
    expect(res.text).toContain("http-equiv=");
    // Raw name must never appear unescaped.
    expect(res.text).not.toContain("<Roll>");
  });

  it("escapes host-derived og:image URLs against Host-header injection", async () => {
    vi.mocked(getCommunityCardData).mockResolvedValue({ displayName: "Test" });

    const res = await supertest(buildApp())
      .get(`/communities/${ENCODED}/share`)
      .set("Host", 'evil.example"><script>alert(1)</script>');

    expect(res.status).toBe(200);
    // The raw Host header must never break out of the attribute.
    expect(res.text).not.toContain('"><script>');
    expect(res.text).toContain("&quot;&gt;&lt;script&gt;");
  });

  it("uses the fallback description when the community has none", async () => {
    vi.mocked(getCommunityCardData).mockResolvedValue({
      displayName: "Quiet Club",
    });
    const res = await supertest(buildApp()).get(
      `/communities/${ENCODED}/share`,
    );
    expect(res.text).toContain(
      'og:description" content="Join this community on Open Social."',
    );
  });

  it("404s for unknown communities", async () => {
    vi.mocked(getCommunityCardData).mockResolvedValue(null);
    const res = await supertest(buildApp()).get(
      `/communities/${ENCODED}/share`,
    );
    expect(res.status).toBe(404);
  });
});

describe("optional rate limiter", () => {
  it("is invoked for both og-image and share requests when supplied", async () => {
    vi.mocked(getCommunityCardData).mockResolvedValue({ displayName: "Test" });
    const rateLimiter = vi.fn((req: any, res: any, next: any) => next());

    const app = express();
    app.use(createOgRouter({} as any, rateLimiter));

    const imageDid = "did:plc:ratelimit000000000000001";
    await supertest(app).get(
      `/communities/${encodeURIComponent(imageDid)}/og-image`,
    );
    expect(rateLimiter).toHaveBeenCalledTimes(1);

    const shareDid = "did:plc:ratelimit000000000000002";
    await supertest(app).get(
      `/communities/${encodeURIComponent(shareDid)}/share`,
    );
    expect(rateLimiter).toHaveBeenCalledTimes(2);
  });
});
