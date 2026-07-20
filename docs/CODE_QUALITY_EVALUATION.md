# Code Quality & Performance Evaluation — July 2026

## Overview

This document records a full-codebase evaluation (code quality + performance
bottlenecks), the fixes implemented on the `claude/code-quality-performance`
branch, and the larger structural recommendations that were deliberately
deferred. The trigger was the app "feeling slow"; the evaluation traced that
to a small number of concrete hot-path problems, most of which are now fixed.

## Fixes implemented

### 1. API-key auth ran synchronous scrypt against every app on every request

**Problem**: `verifyApiKey` middleware — attached to nearly every `/api/v1/*`
and `/xrpc/*` route — loaded **all** active apps (`SELECT *`) and ran
`crypto.scryptSync` (N=16384, ~30–100 ms of pure CPU) against each row until a
match. Cost grew linearly with the number of registered apps, an invalid key
scanned the whole table, and because `scryptSync` is synchronous it **blocked
the entire event loop**, stalling every other in-flight request. The same
pattern was duplicated in `POST /api/v1/apps/verify`. This was the single
biggest cause of perceived slowness under load.

**Location**: `src/middleware/auth.ts`, `src/routes/apps.ts`

**Solution**:

- Migration 016 adds an indexed `apps.api_key_lookup` column storing the
  SHA-256 hex of the raw key. Keys carry 256 bits of entropy (`osc_` + 64 hex
  chars), so an unsalted digest is safe as a _lookup_ value; scrypt remains
  the verifier.
- Auth fetches the single candidate row by index and verifies with **async**
  `crypto.scrypt` (thread pool, event loop stays free).
- Verified keys are cached for 60 s in `apiKeyAuthCache`, keyed by the digest
  (never the raw key).
- Apps registered before migration 016 can't have the column backfilled (only
  salted hashes are stored), so auth falls back to the legacy scan and
  backfills `api_key_lookup` on the first successful match.

**Tradeoff**: a rotated or deactivated key can keep authenticating for up to
60 s (the cache TTL). Rotation stores the new key's lookup immediately; the
old key ages out with the TTL.

### 2. Membership checks scanned the entire PDS collection over the network

**Problem**: join, promote, membership-check, and the permissions endpoint
each paged through the community's entire `membershipProof` collection (100
records per sequential PDS round-trip) to answer "is this DID a member?" —
copy-pasted inline and bypassing the 5-minute cache that already existed in
`checkMembership`. A non-member check on a 5,000-member community cost ~50
sequential network calls. Worse, `memberCache` had **no invalidation
anywhere**, so routing mutations through the cache would have served stale
answers.

**Location**: `src/routes/members.ts`, `src/routes/communities.ts`,
`src/xrpc/members.ts`, `src/services/permissions.ts`

**Solution**:

- All boolean membership checks now go through the cached `checkMembership`.
- Leave/remove need the record rkey for deletion, so they use a new shared
  `findMembershipProof` helper that always scans live data (deletions must
  not trust a cache) and warms the cache with what it learns.
- Every proof mutation — join, approve, leave, remove, across the REST,
  OAuth, and XRPC paths — now writes the cache (`true`/`false`) immediately,
  so answers are consistent right after a change.

### 3. Community detail recounted all members on every request

**Problem**: `GET /communities/:did` walked the entire membership collection
(unbounded) on every call to compute `memberCount`, ignoring the cached
`member_count` column the search path already maintained.

**Location**: `src/routes/communities.ts`

**Solution**: serve the cached column; if stale (>24 h) return the cached
value and refresh in the background; only when no value exists do one inline
count, capped at 1000 (shared `countMembersCapped` helper, also reused by the
list handler).

### 4. N+1 queries and uncached external fetches on member lists

**Problem**: `GET /:did/members` issued one `community_member_roles` join
query **and** one external Bluesky profile fetch per member per page (up to
100 + 100 round-trips), with no timeout and no cache; the pending-members
list had the same per-member fetch.

**Location**: `src/routes/members.ts`, new `src/lib/profiles.ts`

**Solution**: one roles query for the whole page (`WHERE member_did IN`),
grouped in memory; profile resolution moved to `src/lib/profiles.ts` with a
10-minute TTL cache (negative results included), 3 s timeouts, batching via
`app.bsky.actor.getProfiles` (25 actors per call), and per-DID fallback if
the batch endpoint fails. A page now costs ≤1 DB query + ≤4 HTTP calls.

### 5. Missing indexes on hot tables

**Problem**: `audit_log` (queried `WHERE community_did ORDER BY created_at
DESC`, grows unbounded), `pending_members` (point lookups on every
join/approve/reject/check and status-ordered lists), and `webhooks`
(filtered on every dispatched event) had no indexes at all.

**Location**: `migrations/017_perf_indexes.ts`

**Solution**: four covering indexes matching the actual query shapes.

### 6. Connection pool defaults and a duplicate pool

**Problem**: the Kysely `pg.Pool` used all defaults — `max: 10` and, most
dangerously, `connectionTimeoutMillis: 0` (wait forever on pool exhaustion).
A second module-level pool in `src/services/database.ts` had **zero
importers** but still opened connections at import time.

**Location**: `src/db.ts`, `src/config.ts`

**Solution**: pool `max`, `idleTimeoutMillis` (30 s), and
`connectionTimeoutMillis` (5 s) are configurable via `PG_POOL_MAX`,
`PG_IDLE_TIMEOUT_MS`, `PG_CONNECTION_TIMEOUT_MS`; the dead pool module was
deleted.

### 7. No response compression

**Problem**: member lists, community search results, and audit logs were sent
as uncompressed JSON.

**Solution**: `compression()` middleware in `src/index.ts` (WebSocket
upgrades bypass Express middleware, so the event stream is unaffected).

### 8. Untimed external fetches on request paths

**Problem**: profile lookups, PDS `listRecords` calls, and banner downloads
had no timeout — one hung upstream held the request (and any `Promise.all`
containing it) open indefinitely.

**Solution**: `AbortSignal.timeout` on all of them (3 s profile / 5 s PDS
list / 10 s banner blob), matching the pattern already used in
`src/lib/ogAvatar.ts`. `fetchBlueskyAvatar` no longer constructs a fresh
`BskyAgent` per call.

### 9. Committed build artifacts shadowing sources

**Problem**: `src/config.js` and `src/lib/crypto.js` — stale compiled
output — were committed alongside their `.ts` sources and were picked up by
module resolution under vitest, shadowing current code.

**Solution**: removed and gitignored (`src/**/*.js`).

## Code-quality assessment

**Done well**: security posture (tiered rate limiting, CSRF, scrypt-hashed
keys, SSRF/XSS guards, encrypted secrets at rest, explicit CORS allowlist);
centralized structured pino logging with correlation IDs; strict TypeScript
with zero `@ts-ignore`/`@ts-expect-error`; strong unit tests for libs and
services (~480 tests); consistent DI/router-factory layering; working CI+CD;
essentially no TODO/FIXME debt markers.

**Weakest areas** (see deferred recommendations):

- `src/routes/auth.ts` is a ~5,000-line god-module holding ~48 handlers for
  unrelated concerns (OAuth, profile, memberships, publications, events,
  community CRUD, links, roles, apps, permissions). `getSessionAgent`
  boilerplate is repeated 64×; there is no `requireSessionAgent` middleware.
- Error handling is defined but unused: a central Express error handler
  exists but always returns 500 and only two handlers call `next(err)`;
  `AppError` in `src/lib/errors.ts` is never thrown; ~183 inline
  `res.status(500|400)` calls; several empty `catch {}` blocks.
- ~300 `any` occurrences, mostly at the ATProto record boundary — no shared
  typed decoders, so the `any` leaks into business logic.
- Route-level test coverage is thin where the most logic lives: only ~2 of
  ~48 `auth.ts` endpoints are exercised; no tests for the communities/
  permissions/records/webhooks routes or any `xrpc/*` handler.
- No ESLint, and CI runs neither `tsc --noEmit` nor a lint step — vitest
  (esbuild) does not typecheck, so type errors cannot fail CI today.
- `envalid` is a dependency but unused; env handling is raw `process.env`
  with `|| ''` fallbacks, so misconfiguration surfaces late.

## Deferred recommendations (highest leverage first)

1. **Postgres membership index table.** The structural fix behind most
   remaining slowness: mirror `(community_did, member_did, proof_rkey)` into
   an indexed table updated on join/leave/approve/remove. Membership checks
   and rkey lookups become one indexed query; the full-collection PDS scans
   (including `findMembershipProof` and duplicate-content checks in
   `src/routes/content.ts`) disappear. Requires a backfill job and a
   reconciliation story for out-of-band PDS changes.
2. **Split `src/routes/auth.ts`** into ~6–8 routers and extract a
   `requireSessionAgent` middleware plus a shared error wrapper. Mechanical,
   large-diff refactor best done in a dedicated PR.
3. **Add `tsc --noEmit` and ESLint to CI** (`.github/workflows/test.yml`).
   Cheap and prevents whole classes of regressions.
4. **Wire the central error handler**: make it honor `AppError.statusCode`,
   convert handlers to `next(err)`, or delete `lib/errors.ts`'s unused parts.
5. **Bump `member_count` on join/leave** instead of relying solely on
   read-path staleness refresh.
6. Timeouts for `BskyAgent.login()` paths (needs an injected fetch handler);
   deduplicate `resolveBlueskyProfile` in `auth.ts` into `src/lib/profiles.ts`.
7. Wrap the 7 sequential DELETEs in community deletion in a transaction
   (`src/routes/communities.ts`); bulk-upsert `seedCollectionPermissions`
   instead of select-then-insert per collection.
8. WebSocket broadcast backpressure: skip/disconnect clients whose
   `ws.bufferedAmount` exceeds a threshold (`src/ws/eventStream.ts`).
9. Move OG image rendering (satori + resvg, CPU-bound) to a worker thread;
   it is well-cached today so this only bites on cold-cache bursts.
10. Replace stale `scripts/schema.sql` (predates several migrations) or
    delete it in favor of migrations as the single source of truth.
