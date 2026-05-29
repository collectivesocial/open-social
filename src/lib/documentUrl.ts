/**
 * Resolve the canonical web URL for a `site.standard.document` record.
 *
 * standard.site documents (e.g. Leaflet publications) don't live at the
 * author's handle. The document references a `site.standard.publication`
 * record via its `site` field, and that publication carries the real base
 * URL (e.g. `https://atprotocolorado.leaflet.pub`). The web URL is that base
 * joined with the document's `path`.
 *
 * Building a URL from the author's handle (`https://{handle}{path}`) is wrong
 * whenever the publication is hosted on a different domain than the author's
 * handle — which is the common case for Leaflet.
 *
 * @see https://leaflet.pub
 */

import { logger } from "./logger";
import { TtlCache } from "./cache";
import { resolvePdsEndpoint } from "../services/atproto";

const DOCUMENT_COLLECTION = "site.standard.document";
const PUBLICATION_COLLECTION = "site.standard.publication";

// Resolved URLs are stable; cache them for 5 minutes to avoid repeated
// PDS round-trips when listing shared content.
const urlCache = new TtlCache<string | null>(5 * 60 * 1000, 1000);

interface AtUriParts {
  repo: string;
  collection: string;
  rkey: string;
}

function parseAtUri(uri: string): AtUriParts | null {
  if (!uri.startsWith("at://")) return null;
  const [repo, collection, rkey] = uri.slice("at://".length).split("/");
  if (!repo || !collection || !rkey) return null;
  return { repo, collection, rkey };
}

/** Fetch a single record's `value` via unauthenticated XRPC. */
async function fetchRecordValue(
  pdsUrl: string,
  repo: string,
  collection: string,
  rkey: string,
): Promise<Record<string, unknown> | null> {
  try {
    const url = new URL(`${pdsUrl}/xrpc/com.atproto.repo.getRecord`);
    url.searchParams.set("repo", repo);
    url.searchParams.set("collection", collection);
    url.searchParams.set("rkey", rkey);
    const res = await fetch(url.toString());
    if (!res.ok) return null;
    const data = (await res.json()) as { value?: Record<string, unknown> };
    return data.value ?? null;
  } catch {
    return null;
  }
}

function joinUrl(base: string, path: string): string {
  const cleanBase = base.endsWith("/") ? base.slice(0, -1) : base;
  const segment = path.startsWith("/") ? path : `/${path}`;
  return `${cleanBase}${segment}`;
}

/**
 * Resolve the canonical web URL for a `site.standard.document` referenced by
 * an at:// URI. Follows the document's `site` field to its
 * `site.standard.publication` record and joins the publication's `url` with
 * the document's `path`.
 *
 * Returns `null` when the document isn't a standard.site document, can't be
 * fetched, or has no resolvable publication URL — callers should fall back to
 * their existing URL heuristic in that case.
 */
export async function resolveDocumentWebUrl(
  documentUri: string,
): Promise<string | null> {
  const cached = urlCache.get(documentUri);
  if (cached !== undefined) return cached;

  const result = await resolve(documentUri);
  urlCache.set(documentUri, result);
  return result;
}

/** Clear the resolved-URL cache. Primarily for tests. */
export function clearDocumentUrlCache(): void {
  urlCache.clear();
}

async function resolve(documentUri: string): Promise<string | null> {
  const docRef = parseAtUri(documentUri);
  if (!docRef || docRef.collection !== DOCUMENT_COLLECTION) return null;

  try {
    const pds = await resolvePdsEndpoint(docRef.repo);

    const doc = await fetchRecordValue(
      pds,
      docRef.repo,
      docRef.collection,
      docRef.rkey,
    );
    if (!doc) return null;

    const path = typeof doc.path === "string" ? doc.path : undefined;
    const site = typeof doc.site === "string" ? doc.site : undefined;
    if (!site || !path) return null;

    const siteRef = parseAtUri(site);
    if (!siteRef || siteRef.collection !== PUBLICATION_COLLECTION) return null;

    // The publication usually lives in the same repo as the document, so reuse
    // the PDS endpoint we already resolved unless the repo differs.
    const pubPds =
      siteRef.repo === docRef.repo
        ? pds
        : await resolvePdsEndpoint(siteRef.repo);
    const pub = await fetchRecordValue(
      pubPds,
      siteRef.repo,
      siteRef.collection,
      siteRef.rkey,
    );
    const pubUrl = typeof pub?.url === "string" ? pub.url : undefined;
    if (!pubUrl) return null;

    return joinUrl(pubUrl, path);
  } catch (err) {
    logger.warn(
      { documentUri, error: err },
      "Failed to resolve document web URL",
    );
    return null;
  }
}
