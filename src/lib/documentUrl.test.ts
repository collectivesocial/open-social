import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock PDS resolution so the resolver doesn't hit the network for DID docs.
vi.mock("../services/atproto", () => ({
  resolvePdsEndpoint: vi.fn(async () => "https://pds.example"),
}));

import { resolveDocumentWebUrl, clearDocumentUrlCache } from "./documentUrl";
import { resolvePdsEndpoint } from "../services/atproto";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

const DID = "did:plc:author";
const DOC_URI = `at://${DID}/site.standard.document/doc1`;
const SITE_URI = `at://${DID}/site.standard.publication/pub1`;

// Helper: respond to getRecord calls based on the collection in the query.
function mockGetRecord(byCollection: Record<string, unknown>) {
  mockFetch.mockImplementation(async (input: string) => {
    const url = new URL(input);
    const collection = url.searchParams.get("collection") ?? "";
    const value = byCollection[collection];
    if (value === undefined) return { ok: false };
    return { ok: true, json: async () => ({ value }) };
  });
}

beforeEach(() => {
  clearDocumentUrlCache();
  mockFetch.mockReset();
  (resolvePdsEndpoint as ReturnType<typeof vi.fn>).mockClear();
});

describe("resolveDocumentWebUrl", () => {
  it("joins the publication url with the document path", async () => {
    mockGetRecord({
      "site.standard.document": { path: "/3mmusgssr522y", site: SITE_URI },
      "site.standard.publication": {
        url: "https://atprotocolorado.leaflet.pub",
      },
    });

    const url = await resolveDocumentWebUrl(DOC_URI);
    expect(url).toBe("https://atprotocolorado.leaflet.pub/3mmusgssr522y");
  });

  it("normalizes a trailing slash on the publication url", async () => {
    mockGetRecord({
      "site.standard.document": { path: "/3mmusgssr522y", site: SITE_URI },
      "site.standard.publication": {
        url: "https://atprotocolorado.leaflet.pub/",
      },
    });

    const url = await resolveDocumentWebUrl(DOC_URI);
    expect(url).toBe("https://atprotocolorado.leaflet.pub/3mmusgssr522y");
  });

  it("caches the result so repeated calls do not refetch", async () => {
    mockGetRecord({
      "site.standard.document": { path: "/x", site: SITE_URI },
      "site.standard.publication": { url: "https://pub.leaflet.pub" },
    });

    await resolveDocumentWebUrl(DOC_URI);
    const callsAfterFirst = mockFetch.mock.calls.length;
    await resolveDocumentWebUrl(DOC_URI);
    expect(mockFetch.mock.calls.length).toBe(callsAfterFirst);
  });

  it("returns null when the document has no site reference", async () => {
    mockGetRecord({
      "site.standard.document": { path: "/x" },
    });
    expect(await resolveDocumentWebUrl(DOC_URI)).toBeNull();
  });

  it("returns null when the publication has no url", async () => {
    mockGetRecord({
      "site.standard.document": { path: "/x", site: SITE_URI },
      "site.standard.publication": { name: "No URL here" },
    });
    expect(await resolveDocumentWebUrl(DOC_URI)).toBeNull();
  });

  it("returns null for non-document collections without fetching", async () => {
    expect(
      await resolveDocumentWebUrl(
        `at://${DID}/community.lexicon.calendar.event/e1`,
      ),
    ).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("returns null for malformed at-uris", async () => {
    expect(await resolveDocumentWebUrl("not-an-at-uri")).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
