import { logger } from "./logger";

/**
 * cdn.bsky.app serves WebP by default, which satori/resvg cannot decode.
 * Appending "@jpeg" to the image path asks the CDN to transcode to JPEG.
 */
export function preferJpegCdnUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.hostname === "cdn.bsky.app" && !/@\w+$/.test(u.pathname)) {
      return `${u.origin}${u.pathname}@jpeg${u.search}`;
    }
  } catch {
    // Not a parseable URL — return as-is and let fetch fail downstream.
  }
  return url;
}

function sniffImageMime(buf: Buffer): string | undefined {
  if (
    buf.length >= 3 &&
    buf[0] === 0xff &&
    buf[1] === 0xd8 &&
    buf[2] === 0xff
  ) {
    return "image/jpeg";
  }
  if (
    buf.length >= 4 &&
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47
  ) {
    return "image/png";
  }
  if (
    buf.length >= 4 &&
    buf[0] === 0x47 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46 &&
    buf[3] === 0x38
  ) {
    return "image/gif";
  }
  return undefined; // WebP or anything else satori can't embed
}

/**
 * Fetch an avatar and return it as a data URI for embedding in a satori
 * layout. Returns undefined on any failure (timeout, non-image, WebP, …)
 * so callers can fall back to a monogram card.
 */
export async function fetchAvatarAsDataUri(
  url: string,
  timeoutMs = 3000,
): Promise<string | undefined> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(preferJpegCdnUrl(url), {
      signal: controller.signal,
      // Even an allowlisted host shouldn't be able to redirect this
      // server-side fetch elsewhere (SSRF via open redirect). Treat a
      // redirect as a failure and fall back to the monogram card.
      redirect: "error",
    });
    if (!res.ok) return undefined;
    const buf = Buffer.from(await res.arrayBuffer());
    const mime = sniffImageMime(buf);
    if (!mime) {
      logger.warn({ url }, "Avatar is not a satori-embeddable image type");
      return undefined;
    }
    return `data:${mime};base64,${buf.toString("base64")}`;
  } catch (err) {
    logger.warn({ error: err, url }, "Failed to fetch avatar for OG card");
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}
