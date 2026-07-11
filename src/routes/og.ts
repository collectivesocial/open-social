import express, { Request, Response, NextFunction, Router } from "express";
import type { Kysely } from "kysely";
import type { Database } from "../db";
import { config } from "../config";
import { getCommunityCardData } from "../services/ogCard";
import { renderCommunityCard } from "../services/ogImage";
import { fetchAvatarAsDataUri } from "../lib/ogAvatar";

const PNG_CACHE_TTL_MS = 60 * 60 * 1000; // matches Cache-Control max-age=3600
const PNG_CACHE_MAX_ENTRIES = 500;
const pngCache = new Map<string, { buf: Buffer; expires: number }>();

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Public base URL of this API (for absolute og:image URLs). */
function apiBaseUrl(req: Request): string {
  return config.serviceUrl || `${req.protocol}://${req.get("host")}`;
}

/** Public base URL of the web app (redirect target). */
function appBaseUrl(): string {
  return config.corsOrigin || "http://127.0.0.1:5174";
}

/**
 * Public OG share-card endpoints, consumed by link-preview crawlers.
 * No auth: crawlers have no session, and the data shown is already public.
 */
export function createOgRouter(db: Kysely<Database>): Router {
  const router = express.Router();

  router.get(
    "/communities/:did/og-image",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const did = decodeURIComponent(req.params.did);

        const sendPng = (buf: Buffer) => {
          res.setHeader("Content-Type", "image/png");
          res.setHeader("Cache-Control", "public, max-age=3600");
          res.send(buf);
        };

        const cached = pngCache.get(did);
        if (cached && cached.expires > Date.now()) {
          return sendPng(cached.buf);
        }

        const data = await getCommunityCardData(db, did);
        if (!data) {
          return res.status(404).json({ error: "Community not found" });
        }

        const avatarDataUri = data.avatarUrl
          ? await fetchAvatarAsDataUri(data.avatarUrl)
          : undefined;
        const buf = await renderCommunityCard({
          displayName: data.displayName,
          avatarDataUri,
        });

        if (pngCache.size >= PNG_CACHE_MAX_ENTRIES) {
          const oldest = pngCache.keys().next().value;
          if (oldest !== undefined) pngCache.delete(oldest);
        }
        pngCache.set(did, { buf, expires: Date.now() + PNG_CACHE_TTL_MS });

        sendPng(buf);
      } catch (err) {
        next(err);
      }
    },
  );

  router.get(
    "/communities/:did/share",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const did = decodeURIComponent(req.params.did);
        const data = await getCommunityCardData(db, did);
        if (!data) {
          return res.status(404).send("Community not found");
        }

        const encodedDid = encodeURIComponent(did);
        const imageUrl = `${apiBaseUrl(req)}/communities/${encodedDid}/og-image`;
        const targetUrl = `${appBaseUrl()}/communities/${encodedDid}?action=join`;
        const title = escapeHtml(`Join ${data.displayName} on Open Social`);
        const description = escapeHtml(
          data.description || "Join this community on Open Social.",
        );

        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.setHeader("Cache-Control", "public, max-age=300");
        res.send(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${title}</title>
<meta property="og:site_name" content="Open Social">
<meta property="og:type" content="website">
<meta property="og:title" content="${title}">
<meta property="og:description" content="${description}">
<meta property="og:image" content="${imageUrl}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:url" content="${escapeHtml(targetUrl)}">
<meta name="twitter:card" content="summary_large_image">
<meta http-equiv="refresh" content="0; url=${escapeHtml(targetUrl)}">
</head>
<body>
<p>Redirecting to <a href="${escapeHtml(targetUrl)}">${title}</a>…</p>
<script>window.location.replace(${JSON.stringify(targetUrl)});</script>
</body>
</html>`);
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}
