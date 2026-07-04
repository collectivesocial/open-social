# Atmospheric Groups on Permissioned Spaces — Implementation Plan

**Status:** Draft for review — 2026-07-03
**Audience:** OpenSocial / Collective Social contributors, Atmospheric Groups working group
**Prereq reading:** [Proposal 0016 — Permissioned Data](https://github.com/bluesky-social/proposals/tree/main/0016-permissioned-data), [2026-06-17 Permissioned Communities PoC design](./2026-06-17-permissioned-communities-poc-design.md), the interoperable-communities contract draft (currently in the community-app-demo repo at `docs/interoperable-communities.md`)

This document outlines everything needed to move Atmospheric Groups onto real permissioned spaces, in three phases:

1. **Phase 1** — Group space + management space in OpenSocial, on the atproto `permissioned-data` branch.
2. **Phase 2** — Permissioned-data consumption in Collective Social, proving the contract works end-to-end across apps.
3. **Phase 3** — OpenSocial production hardening and redesign backlog.

---

## 1. Overview & layering

Atmospheric Groups sit in a three-layer model:

| Layer                | What lives there                                                 | Examples                                                 |
| -------------------- | ---------------------------------------------------------------- | -------------------------------------------------------- |
| **Protocol**         | Permissioned data: spaces, permissioned repos, credentials, sync | PDS (`com.atproto.space.*`, `com.atproto.simplespace.*`) |
| **Group management** | Roles, governance, moderation, membership policy                 | OpenSocial, the Arbiter                                  |
| **Application**      | Rendering and posting into groups; surfacing public groups       | Bluesky, Collective Social, PopFeed, npmx                |

Guiding principles (from the working-group threads):

- **The group management layer is optional.** Apps can run basic groups without one; the interop contract must let a group "graduate" into managed governance without migrating identity.
- **Member lists are not necessarily public.** Roster visibility is a per-group choice; the protocol never enumerates readers.
- **Not all groups are discoverable.** A public profile record on the group DID opts a group into discovery; its absence keeps the group unlisted.
- **Modularity.** Groups range from a handful of friends to tens of thousands of members; management/moderation must compose.
- **Minimal interop surface.** Define the minimum methods apps need; let management layers grow complexity behind them (XRPC procedures over prescriptive records where possible).

### Mapping Groups concepts onto proposal 0016

| Atmospheric Groups concept                                                     | Proposal 0016 concept                                                                                                                                  |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Group identity                                                                 | The group's own DID — the **space authority** for all of its spaces                                                                                    |
| Group space (announcements, general group records)                             | Space `ats://<groupDid>/community.opensocial.posts/<skey>` (space type to be formalized; see [naming](#space-type-naming))                             |
| Management space (roles, role assignments, audit log, settings, join requests) | Space `ats://<groupDid>/community.opensocial.management/<skey>`                                                                                        |
| Membership decision (who can read)                                             | `simplespace` config `policy=managing-app` → the authority's PDS calls `com.atproto.simplespace.checkUserAccess` on OpenSocial at credential-mint time |
| App gating (which client apps)                                                 | `appAccess`: `#open` initially; `#allowList` later (the branch currently verifies client attestations structurally, not cryptographically)             |
| Member content                                                                 | Each member writes into their **own permissioned repo** on their **own PDS**; the space is the aggregation                                             |
| Group discovery                                                                | Public `community.opensocial.community.profile` record (rkey `self`) in the group DID's public repo                                                    |

> **URI note:** proposal 0016 writes space URIs as `at://<authority>/space/<type>/<skey>` (a literal `space` segment); the implementation branch currently uses a dedicated `ats://<authority>/<type>/<skey>` scheme (`@atproto/syntax` SpaceUri). This doc uses the branch form since that's what we run against; expect one rename before the spec finalizes.

**Architecture decision:** we build on `com.atproto.simplespace` (the management implementation every PDS must support) with `policy=managing-app`, rather than a bespoke space host. This is the least protocol work, runs on the stock `permissioned-data` branch today, and keeps OpenSocial in the loop for every credential decision — dynamic policy without OpenSocial mirroring member lists into the PDS. A bespoke `community.opensocial` space-management implementation remains possible later without changing the space URIs.

### Credential flow with OpenSocial as managing app

```
User's app                User's PDS          Group PDS (authority)      OpenSocial
    |                         |                        |                     |
    |-- getDelegationToken -->|                        |                     |
    |<---- delegation JWT ----|                        |                     |
    |-- getSpaceCredential (delegation JWT) ---------->|                     |
    |                         |                        |-- checkUserAccess ->|
    |                         |                        |<---- authorized ----|
    |<-------------- space credential JWT -------------|                     |
    |-- listRecords / listRepoOps / getRecord (any member's PDS) ----------->
```

---

## 2. Phase 1 — Group + management spaces in OpenSocial

Goal: a group's announcements/posts and its governance records live in real permissioned spaces anchored on the group DID, readable in open-social-web, with membership decisions served by OpenSocial via `checkUserAccess`. This replaces the PoC shims.

### 2.1 Dev environment

- Run the atproto `permissioned-data` branch multi-PDS dev-env: `pnpm --filter @atproto/dev-env start:multi-pds [pdsCount]` (PLC on :2582, introspect server on :2581, primary PDS on :2583, extra PDSes on random ports, alice/bob/carol seeded per PDS). Node ≥22 required.
- Publish our lexicons to the dev-env `lex-authority.test` account so NSIDs resolve (pattern: `publishOurLexicons()` in community-app-demo `app/src/lib/atproto/publish-lexicon.ts` — idempotent `putRecord` of each JSON lexicon as a `com.atproto.lexicon.schema` record).
- Best worked examples of driving the API: `atproto/packages/pds/tests/spaces.test.ts` (full create → write → credential → cross-PDS sync flow) and `space-scope.test.ts` (OAuth scope enforcement). Design notes: `atproto/SPACE_RECONCILIATION_NOTES.md`.
- Note: the docker-based `atproto-devnet` pins the published `pds:0.4` image, which does **not** include spaces. Use the in-repo dev-env (or build a PDS image from the branch).

### 2.2 Formalize the lexicons

Today the governance record types are implicit (`$type` strings in code, no JSON schema): `community.opensocial.role`, `roleAssignment` (in `src/services/roles.ts`), `post` (in `src/services/posts.ts`), and the space type NSIDs are string constants (`src/services/spaces.ts:30-31`). The v2 contract draft in community-app-demo has fuller shapes. Work:

- **Space type declarations** (`"type": "space"` lexicons):
  - `community.opensocial.management` — collections: `role`, `roleAssignment`, `auditLogEntry`, `settings`, `appPermission`, `joinRequest`, `membershipProof`, `membership`.
  - Group content space (see [naming](#space-type-naming)) — collections: `post`, announcements, and whatever general group records we settle on.
- **Governance record lexicons** (port from the draft in community-app-demo `app/lexicons/community/opensocial/community/`): `role` (name, displayName, capabilities[]), `roleAssignment` (subject, role, assignedBy), `auditLogEntry` (actor, action, target, reason, metadata), `settings` (rkey `self`: appVisibilityDefault, blockedApps), `appPermission` (appId, collection, status, canCreate/canRead/canUpdate/canDelete minimum-role strings), `joinRequest` (applicant, status, reviewedBy), `membershipProof`.
- **Permission set** `managementPermissions`: full actions on governance collections but **read+create only** on `auditLogEntry` (append-only, self-protecting). Caveat: the branch currently **drops `space:` permissions inside permission sets**, so apps must request raw `space:` scopes until that's fixed; ship the permission set anyway for the consent-screen end state.
- **Discovery record** `community.opensocial.community.profile` (rkey `self`, public repo of the group DID): displayName, description, communityType (`open`/`closed`/`request`), codeOfConduct, avatar, `space` (URI of the content space), `managementService`. Absence = undiscoverable.
- **Membership & interaction procedures** (the interop contract; served by OpenSocial): `isCommunityMember`, `getCommunityMemberCount`, `joinCommunity`, `leaveCommunity`, `createCommunityDocument`/`readCommunityDocument`/`updateCommunityDocument`/`deleteCommunityDocument`, `createCommunitySpace`/`readCommunitySpace`/`updateCommunitySpace`/`deleteCommunitySpace`. Reconcile these with the existing flat `community.opensocial.*` lexicons in this repo (`getCommunity`, `createRecord`, …) — the flat set becomes legacy; keep serving it during the Collective Social migration window (Phase 2), then retire.

<a name="space-type-naming"></a>**Naming note:** current code uses `community.opensocial.posts` and `community.opensocial.management` as space types. Decide once, before publishing lexicons: keep these, or move to `community.opensocial.group`/`.management` per the contract draft. Either way flag the eventual **prefix swap to a shared authority** (`community.lexicon.community.*`) as a clean rename once the working group lands a shared namespace.

### 2.3 Replace the hand-rolled SpaceClient

`src/services/spaces.ts` hand-rolls `fetch` against `com.atproto.space.*` with the community session's `accessJwt` and `validate: false`, because `@atproto/api` doesn't know these lexicons. Replace with the generated `@atproto/lex` client from the branch (`atproto/packages/lex/lex-schema/src/schema/space.ts`; see the `lex-sdk` docs in that repo). Beware stale `@atproto/api` codegen on the branch: it still emits `com.atproto.space.createSpace`/`deleteSpace`/`updateSpaceConfig` types from before the protocol/management split — the correct methods are `com.atproto.simplespace.*`.

### 2.4 Space provisioning

`provisionCommunitySpaces` moves to `com.atproto.simplespace.createSpace` on the group's PDS, group DID as authority, with config:

```json
{
  "policy": "managing-app",
  "appAccess": { "$type": "com.atproto.simplespace.defs#open" },
  "managingApp": "did:web:opensocial.example#opensocial"
}
```

- OpenSocial needs a stable **service identifier** (DID + fragment) that the group's PDS can resolve to call `checkUserAccess` — add a `#opensocial` service entry to OpenSocial's `did:web` document.
- Keep storing provisioned space URIs in `community_spaces` (migration 015) as an index.
- During bring-up it's fine to start with `policy=member-list` (what the PoC effectively does) and flip to `managing-app` once 2.5 lands — the flip is a single `updateSpace` call.

### 2.5 Implement `checkUserAccess` in OpenSocial

- New XRPC endpoint serving `com.atproto.simplespace.checkUserAccess`, **service-auth verified**: `iss` must be the space's authority DID, `aud` must be OpenSocial's service id. Input: space URI, requesting user DID, attested `client_id` (if any). Output: authorize yes/no.
- Decision backed by the roster in the management space (`membership` records with `status=active`; management space itself additionally requires a role with `manage` capability via `actorCan`).
- Then **delete the pre-materialized `addMember` shims** in `src/services/membership.ts` (lines 153, 302–304) — they exist only because the PoC devnet minted credentials from member lists. Membership changes stop touching PDS member lists entirely.
- Add rate limiting / caching: this endpoint is on the hot path of every credential mint (default credential lifetime 2h).

### 2.6 Consolidate dual systems

- **Membership:** legacy repo `membershipProof` records (plain `com.atproto.repo.*`) vs. management-space `membership` records. Source of truth = the management space. Keep writing a public/legacy proof only if an interop consumer still needs it; otherwise migrate and drop the legacy path in `src/services/membership.ts`.
- **Roles/permissions:** space `role`/`roleAssignment` records vs. Postgres collection-permission tables (migrations 004/011, `src/services/permissions.ts`). Source of truth = the management space (`role`, `roleAssignment`, `appPermission` records). Postgres becomes a synced cache/index only, rebuilt from the space.
- **Audit log:** write `auditLogEntry` records into the management space (append-only via the permission set), with the Postgres `audit_log` table as a queryable mirror. Portability is the point: if a group moves management apps, its audit history moves with its spaces.

### 2.7 Surface in open-social-web

- Group space view: announcements/posts read from the content space.
- Management views (admin-gated): roles & assignments, audit log, join-request queue, settings — all reading management-space records through the OpenSocial API.
- Replace the `/poc` act-as switcher with real OAuth sessions against the dev-env.

### 2.8 Known branch gaps to design around

| Gap                                                                      | Impact                                                   | Workaround                                                                               |
| ------------------------------------------------------------------------ | -------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Permission sets drop `space:` permissions                                | No friendly consent bundling                             | Request raw `space:` scopes (as community-app-demo does in `app/src/lib/auth/client.ts`) |
| Client attestation parsed but not JWKS-verified                          | `appAccess=#allowList` is advisory                       | Treat app allowlists as non-security UX until verification lands                         |
| No dedicated `#atproto_space` key / `#atproto_space_host` resolution yet | Authority key falls back to `#atproto`; space host = PDS | Fine for simplespace (authority = group account); revisit for space transfer             |
| `registerNotify` expiry fixed at 24h                                     | Syncers must re-register daily                           | Schedule re-registration; also periodic sweep via `listRepos` rev comparison             |
| Branch is review-stage (`SPACE_RECONCILIATION_NOTES.md` is scratch)      | APIs may still shift                                     | Pin the atproto checkout; re-sync lexicons when the branch moves                         |

---

## 3. Phase 2 — Collective Social end-to-end interop

Goal: Collective Social (a **community-enabled app** that has never seen OpenSocial's internals) reads and writes group data through the contract, proving Atmospheric Groups work across apps.

The integration seam is already isolated: `collective-social-api/src/services/opensocial.ts` is the only module speaking the wire protocol, and `src/middleware/groupAuth.ts` does membership gating. `collective-social-web` only consumes the REST layer and needs no changes beyond what the API surfaces.

Work:

- **Migrate the proxy client** from the flat legacy namespace (`community.opensocial.createRecord`, `getRecord`, `listRecords`, `putRecord`, `deleteRecord`, `getPermissions`, `searchCommunities`, `getCommunity`, `getMembers`, `joinCommunity`) to the v2 contract (`community.opensocial.community.{create,read,update,delete}CommunityDocument`, `{create,read,update,delete}CommunitySpace`, `isCommunityMember`, `getCommunityMemberCount`, `joinCommunity`, `leaveCommunity`).
- **Update `groupAuth.ts`** to `isCommunityMember`; retire client-side `resolveUserPermissions`/`satisfiesRole` and the hardcoded per-collection defaults — under the proxy model, OpenSocial enforces `appPermission` policy and returns a generic `NotFound` on denial, so the enabled app never learns (or re-implements) the permission model.
- **Direct space read path** — the actual permissioned-data proof, bypassing the proxy for reads:
  1. Add a `space:` scope to `collective-social-api/src/auth/scopes.ts` (raw scope, not `include:`, per the branch gap).
  2. `com.atproto.space.getDelegationToken` on the user's PDS → `com.atproto.space.getSpaceCredential` on the group's PDS (minted via OpenSocial's `checkUserAccess`) → `com.atproto.space.listRecords`/`listRepoOps` against each writer's PDS (writer set from `listRepos`).
  3. Cache synced records server-side (Collective Social acts as a syncer for the groups its users belong to).
- **Writes** stay proxied through `createCommunityDocument` (role checks in OpenSocial), or optionally go direct to the user's own permissioned repo with the `space:` scope — pick one per collection and document it.
- **Discovery**: group search/browse from public `community.opensocial.community.profile` records instead of `searchCommunities` against OpenSocial's Postgres.
- **Demo script** (definition of done): on the multi-PDS dev-env — create a group in OpenSocial, alice (PDS 1) and bob (PDS 2) join, an announcement written via OpenSocial appears in Collective Social via the direct space read path, a non-member on PDS 3 gets `NotFound`, and a `checkUserAccess` denial after `removeMember` cuts read access when the credential expires.

---

## 4. Phase 3 — OpenSocial production hardening & redesign backlog

Candid list, roughly ordered by risk.

### Identity & trust boundary

- **Built-in group DID/PDS provisioning.** Today creating a group requires bringing an existing ATProto account + app password, which OpenSocial stores encrypted (`communities.app_password`, AES via `ENCRYPTION_KEY`) and uses to log in as the group — compromise of that key is control of every group. Replace with first-class provisioning: OpenSocial creates the group account (DID + repo) on a managed PDS via `createAccount`, holding a scoped service credential rather than a full app password; long-term, the group DID's keys should be rotatable and transferable to the community (group portability).
- **Stop trusting asserted DIDs.** API-key routes accept `userDid`/`adminDid` from the request body with no proof-of-user. Every app-facing surface needs real authentication: OAuth sessions, service auth, or HTTP message signatures (partially built in `httpSigning.ts` on the Collective side).
- **Remove PoC surfaces before production:** the no-auth `/api/poc` router, `PocPage`, `poc_member_accounts` (member app passwords), `scripts/_demo.ts`-style helpers.

### Correctness & consistency

- **Transactional group creation.** Postgres row is written first; repo/space record writes sit in a log-only `try/catch` (`routes/communities.ts`), so a group can exist with no profile/admins/proof. Needs a saga (create records first, commit row last, or reconcile job).
- **Become a real syncer.** Roster/content reads do O(members) `listRecords` + per-rkey `getRecord` loops with no caching. Move to the sync protocol: oplog cursors (`listRepoOps` with `since`), `registerNotify` subscriptions (with 24h re-registration), periodic `listRepos` rev sweeps, and Postgres materialized views as the read path.
- **One source of truth** for membership and roles (see 2.6) — finish the consolidation, delete the legacy paths.

### Redesign & docs

- **open-social-web redesign**: information architecture around groups → spaces (content vs. management), admin console for governance, onboarding flow for creating a group (with built-in DID provisioning), consistent design system.
- **Docs redo**: open-social-web README is still the stock Vite template; the merged PR #85 docs (`API.md`, `PERMISSIONED_DATA.md`, `RUST_REWRITE.md`) are no longer in the working tree — recover from git history, update to the spaces architecture, and publish a proper docs site covering: the interop contract (for community-enabled app developers), self-hosting, and the governance model.
- **Formalize every record type as a lexicon** (no `$type` strings without schemas) and publish them at the lexicon authority.

### Ops

- **Deploy pipeline gates**: the GitHub workflow runs `migrate:up` against production on every push to `main` before the image is even built — add staging, migration review, and rollback strategy.
- **Secrets lifecycle**: documented rotation for `ENCRYPTION_KEY` (re-encryption job), `COOKIE_SECRET`, `PRIVATE_KEYS`; the app-password custody removal (above) shrinks this surface dramatically.
- **Rate limiting & abuse controls** on `checkUserAccess`, join flows, and the XRPC surface.

### Testing

- Devnet-backed integration tests for the space paths (membership, roles, `checkUserAccess`, credential denial) against the `permissioned-data` PDS.
- E2E browser tests for open-social-web (currently 2 component tests).
- Contract tests for the `community.opensocial.community.*` procedures that a second implementation (e.g. the Arbiter) could run against.

### Interop completeness

Against the working group's minimum method surface: `listGroups`, `isGroupMember`, `joinGroup`, `leaveGroup` exist; **gaps: `listGroupSpaces`, `invite`/`revokeInvite`, `createGroupSpace`** (the v2 `readCommunitySpace`/`createCommunitySpace` procedures cover the latter two conceptually — verify against the final working-group contract). Keep the Facebook-groups requirements list (jdp23) as a scope checklist — user view (join/leave, post/reply/like, feeds, search, members, events, invites, reporting) and moderator view (guidelines, application forms, approve/reject, hide/delete, mute, pin, screen, lock threads, labelers, announcements) — explicitly marking each as interop-contract vs. management-app vs. application-layer, or out of scope.

---

## 5. Open questions (for the working group)

1. **Shared lexicon authority**: when does `community.opensocial.*` become `community.lexicon.community.*` (or similar)? Plan for the prefix swap; don't block on it.
2. **Roster enumeration**: the protocol never lists readers; `getCommunityMemberCount`/member-list visibility (`applyMembershipVisibility` gates: public/internal/admin-only/none) is app-layer. Is a standard "roster visibility" field part of the contract?
3. **Client attestation**: once the branch verifies JWKS, should groups be able to allowlist apps (`appAccess=#allowList`) as a contract-level feature, and how do public clients (no keys) participate?
4. **Ungoverned groups**: what does a Bluesky-style "basic group without a management layer" look like in this model — `policy=member-list` with the creating app as the only admin surface? Ensure the contract lets such a group later attach a managing app without changing its DID or space URIs.
5. **Events, search, home-feed integration** (from the requirements list): which of these need contract-level methods vs. remaining per-app?

---

## Appendix: source pointers

- Proposal 0016: https://github.com/bluesky-social/proposals/tree/main/0016-permissioned-data (implementation branch: bluesky-social/atproto#5187)
- atproto branch design notes: `SPACE_RECONCILIATION_NOTES.md` (repo root of the `permissioned-data` checkout); protocol lexicons under `lexicons/com/atproto/{space,simplespace}/`; worked flows in `packages/pds/tests/spaces.test.ts`
- Interop contract draft + v2 lexicons: community-app-demo repo, `docs/interoperable-communities.md` and `app/lexicons/community/opensocial/community/`
- Current PoC: [2026-06-17-permissioned-communities-poc-design.md](./2026-06-17-permissioned-communities-poc-design.md), `src/services/{spaces,membership,roles,posts}.ts`
- Collective Social seam: `collective-social-api/src/services/opensocial.ts`, `src/middleware/groupAuth.ts`, `src/auth/scopes.ts`
