import { logger } from "./logger";

/**
 * Convert an ATProto blob ref into a fully-qualified PDS URL that can be used
 * as an `<img src>`. Accepts the various shapes the field comes back in:
 *
 * - already-resolved URL string
 * - typed `BlobRef` instance from `@atproto/api` (where `ref.toString()`
 *   yields the CID)
 * - plain CBOR-decoded blob object: `{ $type: 'blob', ref: { $link: cid }, ... }`
 *
 * Returns `undefined` if the blob is missing or in an unexpected shape so
 * callers can fall back to a public Bluesky avatar / a default.
 */
export function blobToUrl(
  blob: unknown,
  did: string,
  pdsHost: string,
): string | undefined {
  if (!blob) return undefined;
  if (typeof blob === "string") return blob;
  if (typeof blob !== "object") return undefined;

  const b = blob as { ref?: unknown; $type?: unknown };

  // Typed BlobRef from @atproto/api (has a `ref` we can stringify).
  if (
    b.ref &&
    (typeof b.ref === "string" || typeof (b.ref as any).toString === "function")
  ) {
    const cid = typeof b.ref === "string" ? b.ref : (b.ref as any).toString();
    if (cid && cid !== "[object Object]") {
      return `${pdsHost}/xrpc/com.atproto.sync.getBlob?did=${did}&cid=${cid}`;
    }
  }

  // Plain CBOR-decoded blob: `{ $type: 'blob', ref: { $link: cid } }`.
  if (
    b.$type === "blob" &&
    b.ref &&
    typeof b.ref === "object" &&
    typeof (b.ref as { $link?: unknown }).$link === "string"
  ) {
    const cid = (b.ref as { $link: string }).$link;
    return `${pdsHost}/xrpc/com.atproto.sync.getBlob?did=${did}&cid=${cid}`;
  }

  return undefined;
}

/**
 * Best-effort lookup of a DID's Bluesky profile avatar. Used as a fallback
 * when a community hasn't uploaded its own avatar yet — gives them whatever
 * is set on the underlying Bluesky account.
 */
export async function fetchBlueskyAvatar(
  did: string,
): Promise<string | undefined> {
  try {
    const res = await fetch(
      `https://public.api.bsky.app/xrpc/app.bsky.actor.getProfile?actor=${encodeURIComponent(did)}`,
      { signal: AbortSignal.timeout(3000) },
    );
    if (!res.ok) return undefined;
    const profile = (await res.json()) as { avatar?: string };
    return profile.avatar || undefined;
  } catch (err) {
    logger.warn({ error: err, did }, "Could not fetch Bluesky avatar");
    return undefined;
  }
}
