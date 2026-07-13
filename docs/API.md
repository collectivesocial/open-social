# Open Social — Group Management API Reference

Open Social is group management infrastructure for atproto. It sits **between
the PDS a group lives on and the applications that use the group**, assembling
group data and enforcing the access boundaries the group has configured.

Each community (group) is a real atproto account: a DID plus a repo hosted on
a PDS. The service holds an encrypted app-password for each community and
writes `community.opensocial.*` records to the community's repo on its behalf.
Postgres holds only operational state — registered apps, permissions, roles,
pending members, audit log, caches. The source of truth for group identity,
membership proofs, and content is the atproto repo.

This document covers every API surface: the app-facing REST API
(`/api/v1/…`), the ATProto-style XRPC surface (`/xrpc/…`), and the
session-authenticated endpoints used by web UIs.

**Related reading:**

- [Group management methods (community discussion)](https://discourse.atprotocol.community/t/another-follow-up-topic-group-management-methods/941)
  — the cross-app method set this API is converging toward; see
  [Mapping to proposed group management methods](#mapping-to-proposed-group-management-methods)
- [PERMISSIONED_DATA.md](PERMISSIONED_DATA.md) — how this service maps to
  atproto's permissioned data proposal (0016)

---

## Table of contents

- [Concepts](#concepts)
- [Authentication](#authentication)
- [Conventions](#conventions)
- [Mapping to proposed group management methods](#mapping-to-proposed-group-management-methods)
- [Apps](#apps)
- [Communities](#communities)
- [Membership](#membership)
- [Admins](#admins)
- [Roles](#roles)
- [Settings, app visibility & collection permissions](#settings-app-visibility--collection-permissions)
- [Spaces](#spaces)
- [Records (generic)](#records-generic)
- [Announcements (group-only space)](#announcements-group-only-space)
- [Shared content](#shared-content)
- [Hierarchy](#hierarchy)
- [Audit log](#audit-log)
- [Webhooks](#webhooks)
- [Event stream](#event-stream)
- [XRPC surface](#xrpc-surface)
- [Lexicons](#lexicons)

---

## Concepts

| Term                          | Meaning                                                                                                                                                                                                           |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Community**                 | A group. An atproto account (DID + repo) managed by this service.                                                                                                                                                 |
| **App**                       | A third-party application registered with the service. Apps act on behalf of users and are subject to per-community visibility and per-collection permissions.                                                    |
| **System app** (`app_system`) | The built-in app identity used by the Open Social web UI and session-authenticated routes.                                                                                                                        |
| **Member**                    | A user with a confirmed membership. Membership is recorded twice: a `community.opensocial.membership` record in the _user's_ repo, and a `community.opensocial.membershipProof` record in the _community's_ repo. |
| **Admin**                     | A DID listed in the community's `community.opensocial.admins` record. The first entry is the primary admin (owner).                                                                                               |
| **Role**                      | `admin` and `member` are built in; communities can define custom roles (e.g. `moderator`) and assign them to members.                                                                                             |
| **Collection permission**     | Per (community, app, collection) rule declaring the minimum role required for each of create/read/update/delete. This is the access-boundary mechanism.                                                           |
| **Space**                     | A collection with an access boundary. Today the announcement space (`community.opensocial.announcement`) is the first group-only space; the long-term model is atproto permissioned data (proposal 0016).         |

## Authentication

Three mechanisms, used by different surfaces:

### 1. API key (apps)

App-facing routes (`/api/v1/communities/*` except announcements/content,
`/api/v1/webhooks`, `/xrpc/*`) authenticate the **app** via the `X-Api-Key`
header. Keys are issued at app registration and can be rotated.

```
X-Api-Key: <api key>
```

### 2. HTTP Message Signatures (apps)

Apps registered with `authMethod: "http_signature"` (or `"both"`) may instead
sign requests per RFC 9421 using `Signature-Input` / `Signature` headers. The
signing key is discovered from the app's CIMD document (`cimdUrl`, which must
be HTTPS on the app's domain).

### 3. atproto OAuth session (users)

User-facing routes (login, `/users/me/*`, community browsing/joining, shared
content, announcements) authenticate the **user** with an atproto OAuth
session held in an `sid` cookie. Requested scopes:
`atproto repo:community.opensocial.membership`.

> **Note on user identity in app-authenticated routes:** API-key routes accept
> `userDid` / `adminDid` in the request body and verify them against the
> community's membership/admins records — the DID is asserted by the calling
> app, and the app is trusted to have authenticated its user. Tightening this
> (proof-of-user via delegation tokens) is part of the permissioned-data
> roadmap.

## Conventions

- **Base URL**: all REST paths below are relative to the service origin.
- **DIDs in paths** are URL-encoded (e.g. `did%3Aplc%3Aabc123`).
- **Pagination**: list endpoints take `limit` (default 20 or 50, max 100) and
  an opaque `cursor`; responses include `cursor` when more results exist.
- **Errors**: non-2xx responses are `{ "error": "<message>" }`, with
  `details` (Zod issue map) on validation failures. `401` unauthenticated,
  `403` unauthorized/insufficient role, `404` not found, `409` conflict,
  `429` rate limited.
- **Rate limiting** applies to `/api/v1/*` and `/xrpc/*`, configurable per
  app (`GET/PUT /api/v1/apps/:appId/rate-limit`).

---

## Mapping to proposed group management methods

The [group management methods discussion](https://discourse.atprotocol.community/t/another-follow-up-topic-group-management-methods/941)
proposes a minimal method set apps need to interact with groups, independent
of how any one service manages them. Here is where Open Social stands on each:

| Proposed method           | Open Social today                                                                                  | Notes / gaps                                                                                                                                                            |
| ------------------------- | -------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `listGroups`              | `GET /api/v1/communities?userDid=…` · `GET /xrpc/community.opensocial.searchCommunities`           | Paginated; optional `userDid` filters to that user's groups.                                                                                                            |
| `isGroupMember`           | `POST /api/v1/communities/:did/membership/check` · `GET /xrpc/community.opensocial.getPermissions` | `getPermissions` also returns roles, satisfying the "optional role field" question.                                                                                     |
| `joinGroup`               | `POST /api/v1/communities/:did/members/join` · `POST /xrpc/community.opensocial.joinCommunity`     | Honors community type: `open` joins immediately (writes membership proof); `admin-approved` queues a pending request.                                                   |
| `leaveGroup`              | `POST /api/v1/communities/:did/members/leave` · `POST /xrpc/community.opensocial.leaveCommunity`   | Primary admin cannot leave without transferring ownership.                                                                                                              |
| `listGroupSpaces`         | `GET /api/v1/communities/:did/spaces`                                                              | First-class spaces: each has a key, name, policy (read/write access), and its collections. Pass `userDid` to get per-space `canRead`/`canWrite`. See [Spaces](#spaces). |
| `invite` / `revokeInvite` | `POST /api/v1/communities/:did/spaces/:spaceKey/invites` · `DELETE …/invites/:inviteeDid`          | User-level invites for invite-only spaces (`readAccess: "invite"`). Community-to-community invites remain in the hierarchy flow.                                        |
| `createGroupSpace`        | `POST /api/v1/communities/:did/spaces`                                                             | Admins create a space by declaring its collections and read/write policy; the definition is mirrored to the community repo as a `community.opensocial.space` record.    |

On the two open questions in the thread:

- **Data vs XRPC methods** — Open Social exposes both: group state lives in
  ordinary atproto records anyone can sync (profile, admins, membership
  proofs), while mutations and permission-aware reads go through XRPC/REST
  methods. Experience here suggests records for _state_, methods for
  _transitions and gated reads_.
- **To role or not to role** — a minimal built-in pair (`admin`, `member`)
  plus service-defined custom roles has proven enough. Only the built-in pair
  needs cross-app standardization; custom roles stay an implementation detail
  behind `getPermissions`-style methods.

---

## Apps

Base: `/api/v1/apps` — mixed OAuth (registration by a logged-in user) and API key.

| Method & path                                       | Auth          | Description                                                                                                                                                                                                                                                                                                                                                                            |
| --------------------------------------------------- | ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /register`                                    | OAuth session | Register an app. Body: `name` (3–100 chars), `domain`, optional `authMethod` (`api_key` \| `http_signature` \| `both`), optional `cimdUrl` (HTTPS, must match domain), optional `defaultPermissions[]` (`{ collection, defaultCanCreate, defaultCanRead, defaultCanUpdate, defaultCanDelete }`, role defaults member/member/member/admin). Returns the app + its API key (shown once). |
| `GET /`                                             | OAuth session | List apps created by the current user.                                                                                                                                                                                                                                                                                                                                                 |
| `GET /:appId`                                       | OAuth session | App details.                                                                                                                                                                                                                                                                                                                                                                           |
| `PUT /:appId`                                       | OAuth session | Update `name`, `domain`, `cimdUrl`, `authMethod` (at least one).                                                                                                                                                                                                                                                                                                                       |
| `DELETE /:appId`                                    | OAuth session | Delete the app.                                                                                                                                                                                                                                                                                                                                                                        |
| `POST /:appId/rotate-key`                           | OAuth session | Rotate the API key.                                                                                                                                                                                                                                                                                                                                                                    |
| `POST /verify`                                      | API key       | Verify an API key resolves to an active app.                                                                                                                                                                                                                                                                                                                                           |
| `GET /:appId/rate-limit` · `PUT /:appId/rate-limit` | OAuth session | Read/update the app's rate limit (`maxRequests`, `windowMs`).                                                                                                                                                                                                                                                                                                                          |

## Communities

Base: `/api/v1/communities` — API key.

| Method & path           | Description                                                                                                                                                                                                                                                                                          |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /`                | Create (register) a community. Body: `did`, `appPassword` (stored encrypted; used for the community service agent), `displayName` (1–64), `creatorDid`, optional `description` (≤512). Writes the profile + admins records to the community repo and seeds the calling app's collection permissions. |
| `GET /`                 | List/search communities. Query: `query` (fuzzy match), `userDid` (only communities the user belongs to), `limit`, `cursor`.                                                                                                                                                                          |
| `GET /:did`             | Community details (profile, member count, type). Query: `userDid` (optional — include that user's membership status).                                                                                                                                                                                |
| `GET /:did/permissions` | The calling app's effective collection permissions in this community, plus (with `userDid`) the user's roles and whether they satisfy each rule. This is the "what can I do here" method apps should call first.                                                                                     |
| `DELETE /:did`          | Delete the community registration. Body: `adminDid` (must be the primary admin).                                                                                                                                                                                                                     |

Session-authenticated equivalents used by the web UI (mounted at `/`):
`POST /users/me/communities` (create), `GET /communities/search`,
`GET /communities/:did`, `POST /communities/:did/join`,
`POST /communities/:did/leave`, `PUT /communities/:did/profile`
(`displayName`, `description`, `type` ∈ `open`/`admin-approved`/`private`,
`guidelines`), avatar/banner uploads, `GET /users/me/memberships`.

## Membership

Base: `/api/v1/communities/:did/members` — API key.

| Method & path               | Description                                                                                                                                                                                                                                                                                                  |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `POST /join`                | Join. Body: `userDid`, optional `membershipCid` (CID of the membership record the user wrote in their own repo, for proof pinning). Open communities: writes a `membershipProof` to the community repo and returns `joined`. Approval-required communities: creates a pending request and returns `pending`. |
| `POST /leave`               | Leave. Body: `userDid`. Removes the membership proof. The primary admin must transfer ownership first.                                                                                                                                                                                                       |
| `GET /`                     | List members with profiles and roles. Query: `adminDid` (for member-list access where restricted), `public` (public view), `search`, `limit`, `cursor`.                                                                                                                                                      |
| `GET /pending`              | List pending join requests. Query: `adminDid` (must be an admin).                                                                                                                                                                                                                                            |
| `POST /approve`             | Approve a pending member. Body: `adminDid`, `memberDid`, optional `reason` (≤500). Writes the membership proof.                                                                                                                                                                                              |
| `POST /reject`              | Reject a pending member. Body: `adminDid`, `memberDid`, optional `reason`.                                                                                                                                                                                                                                   |
| `DELETE /:memberDid`        | Remove a member. Body: `adminDid`, optional `reason`.                                                                                                                                                                                                                                                        |
| `POST /../membership/check` | (`POST /api/v1/communities/:did/membership/check`) Body: `userDid`. Returns membership status without listing.                                                                                                                                                                                               |

All membership mutations dispatch webhooks (`member.joined`, `member.left`,
`member.approved`, `member.rejected`, `member.removed`) and write audit-log
entries.

## Admins

Base: `/api/v1/communities/:did/admins` — API key, admin-gated.

| Method & path    | Description                                                                                                   |
| ---------------- | ------------------------------------------------------------------------------------------------------------- |
| `POST /promote`  | Body: `adminDid`, `memberDid`. Adds `memberDid` to the admins record.                                         |
| `POST /demote`   | Body: `adminDid`, `memberDid`. Removes from admins (primary admin cannot be demoted).                         |
| `POST /transfer` | Body: `currentOwnerDid`, `newOwnerDid`. Transfers primary adminship; only the current primary admin may call. |

## Roles

Base: `/api/v1/communities/:did/roles` — API key, admin-gated.

| Method & path                                   | Description                                                                                                                          |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /`                                         | List custom roles. Query: `publicOnly=true` restricts to visible roles.                                                              |
| `POST /`                                        | Create a role. Body: `adminDid`, `name` (lowercase `[a-z0-9_-]+`), `displayName`, optional `description`, `visible` (default false). |
| `PUT /:roleName`                                | Update `displayName` / `description` / `visible`. Body includes `adminDid`.                                                          |
| `DELETE /:roleName`                             | Delete a role. Body: `adminDid`.                                                                                                     |
| `GET /../members/:memberDid/roles`              | List a member's roles.                                                                                                               |
| `POST /../members/:memberDid/roles`             | Assign. Body: `adminDid`, `memberDid`, `roleName`.                                                                                   |
| `DELETE /../members/:memberDid/roles/:roleName` | Revoke. Body: `adminDid`.                                                                                                            |

Role semantics (`src/services/permissions.ts`):

- `admin` satisfies every requirement.
- `member` is satisfied by `member` or `admin`.
- A custom role requirement is satisfied by that exact role or `admin`.

## Settings, app visibility & collection permissions

Base: `/api/v1/communities/:did` — API key, admin-gated. This is where a
community defines its access boundaries.

| Method & path                     | Description                                                                                                                                                           |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /settings` · `PUT /settings` | Community-level defaults. Body (PUT): `adminDid`, `appVisibilityDefault` (`open` \| `approval_required`), `blockedAppIds[]`.                                          |
| `GET /apps`                       | Apps and their visibility status for this community.                                                                                                                  |
| `PUT /apps/:appId`                | Set an app's status. Body: `adminDid`, `status` (`enabled` \| `disabled` \| `pending`).                                                                               |
| `GET /apps/:appId/permissions`    | Collection permission rules for an app.                                                                                                                               |
| `PUT /apps/:appId/permissions`    | Upsert a rule. Body: `adminDid`, `collection` (NSID), and any of `canCreate` / `canRead` / `canUpdate` / `canDelete` (each `admin`, `member`, or a custom role name). |
| `DELETE /apps/:appId/permissions` | Remove a rule (collection becomes inaccessible through that app). Body: `adminDid`, `collection`.                                                                     |

Resolution order when an app touches a collection: app visibility
(explicit status → blocklist → community default) → per-community collection
rule → app's registered defaults → deny/fallback.

## Spaces

Base: `/api/v1/communities/:did/spaces` — API key; mutations are
admin-gated. A **space** is a named access boundary around one or more
collections in the community's repo (permissioned data Phase 1 — see
[PERMISSIONED_DATA.md](PERMISSIONED_DATA.md)). Every community starts with
an `announcements` space (read = member, write = admin). Space definitions
are mirrored into the community repo as `community.opensocial.space`
records so they are discoverable on-protocol; the database registry is
authoritative for enforcement.

Space policies are enforced as an **additional gate** on the records and
announcements endpoints: if a collection belongs to a space, the space's
read/write policy must also be satisfied. A space can only tighten access,
never loosen it.

| Method & path                           | Description                                                                                                                                                                                                                                                                                                                                                                                                                     |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /`                                 | List spaces (`listGroupSpaces`). Query: optional `userDid` — adds `canRead`/`canWrite` per space.                                                                                                                                                                                                                                                                                                                               |
| `POST /`                                | Create a space (`createGroupSpace`). Body: `adminDid`, `spaceKey` (lowercase slug), `name` (1–128), optional `description` (≤512), optional `spaceType` (NSID), `readAccess` (`public` \| `member` \| `admin` \| `invite` \| custom role; default `member`), `writeAccess` (`member` \| `admin` \| custom role; default `admin`), `collections` (1–16 NSIDs). A collection can belong to at most one space (`409` on conflict). |
| `GET /:spaceKey`                        | Space details. Query: optional `userDid` for access flags.                                                                                                                                                                                                                                                                                                                                                                      |
| `PUT /:spaceKey`                        | Update `name` / `description` / `readAccess` / `writeAccess` / `collections`. Body includes `adminDid`.                                                                                                                                                                                                                                                                                                                         |
| `DELETE /:spaceKey`                     | Delete the space (and its invites). Body: `adminDid`. Records in the space's collections are not deleted — they just lose the space gate.                                                                                                                                                                                                                                                                                       |
| `POST /:spaceKey/invites`               | Invite a user to an invite-only space. Body: `adminDid`, `inviteeDid`.                                                                                                                                                                                                                                                                                                                                                          |
| `GET /:spaceKey/invites`                | List invites. Query: `adminDid`.                                                                                                                                                                                                                                                                                                                                                                                                |
| `DELETE /:spaceKey/invites/:inviteeDid` | Revoke an invite. Body: `adminDid`.                                                                                                                                                                                                                                                                                                                                                                                             |

Access semantics: admins always read and write; `readAccess: "invite"`
admits only explicitly invited DIDs (membership is not sufficient);
custom-role access admits holders of that role. All space mutations are
audit-logged (`space.*` actions).

## Records (generic)

Base: `/api/v1/communities/:did/records` — API key. Generic CRUD for any
collection in the community repo, gated by the calling app's collection
permissions. This is how third-party apps build arbitrary group features.

| Method & path               | Description                                                                                                                   |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `POST /`                    | Create. Body: `collection` (NSID), `record` (must include `$type`), `userDid`, optional `rkey`. Requires `create` permission. |
| `PUT /`                     | Update. Body: `collection`, `rkey`, `record`, `userDid`. Requires `update`.                                                   |
| `DELETE /:collection/:rkey` | Delete. Query: `userDid`. Requires `delete`.                                                                                  |
| `GET /:collection`          | List. Query: `limit`, `cursor`, optional `userDid` (some collections are read-gated). Requires `read`.                        |
| `GET /:collection/:rkey`    | Get one. Query: optional `userDid`. Requires `read`.                                                                          |

## Announcements (group-only space)

Base: `/api/v1/communities/:did/announcements` — **OAuth session** (system
app). The first group-only space: by default **only admins can post, edit, or
delete announcements, and only members can read them**. Unlike shared
content, reads are permission-checked — a non-member (or logged-out user)
gets `401`/`403`, never the content. Communities can adjust both sides of the
boundary through the collection-permission endpoints above (collection
`community.opensocial.announcement`, app `app_system`) — e.g. delegate
posting to a custom `moderator` role.

| Method & path   | Required role (default) | Description                                                                                                                                                                                                                             |
| --------------- | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /`        | admin                   | Create. Body: `title` (1–300), `text` (1–10000), optional `pinned` (bool). Returns `201 { uri, cid }`.                                                                                                                                  |
| `GET /`         | member                  | List, newest first with pinned announcements surfaced first within the page. Query: `limit` (default 50, max 100), `cursor`. Returns `{ records: [{ uri, cid, rkey, title, text, createdBy, createdAt, updatedAt, pinned }], cursor }`. |
| `GET /:rkey`    | member                  | Fetch a single announcement.                                                                                                                                                                                                            |
| `PUT /:rkey`    | admin                   | Partial update of `title` / `text` / `pinned`; stamps `updatedAt`.                                                                                                                                                                      |
| `DELETE /:rkey` | admin                   | Delete. Returns `{ success: true }`.                                                                                                                                                                                                    |

Mutations dispatch `record.created` / `record.updated` / `record.deleted`
webhooks and write `announcement.*` audit-log entries.

Third-party apps can reach the same space through the
[generic records endpoints](#records-generic) once a community grants their
app permission rules for the `community.opensocial.announcement` collection.

> **Caveat (until permissioned data ships):** records live in the community's
> atproto repo, which is publicly syncable like any repo. The group-only
> boundary is enforced at this service's API layer — apps that access group
> data through Open Social respect it, but the raw repo is not confidential.
> Proposal 0016 moves this boundary into the protocol; see
> [PERMISSIONED_DATA.md](PERMISSIONED_DATA.md).

## Shared content

Base: `/api/v1/communities/:did/content` — OAuth session (system app).
Members share existing atproto documents/events into the community
(create = member, read = public, update/delete = admin or the sharer).

| Method & path                                      | Description                                                                                                                                                                                                                                            |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /check?documentUri=…`                         | Is this document already shared here?                                                                                                                                                                                                                  |
| `GET /`                                            | Combined feed (documents + events, including native `community.lexicon.calendar.event` records). Query: `limit`, `cursor`.                                                                                                                             |
| `POST /documents` · `POST /events`                 | Share. Body: `documentUri` (at-uri), `documentCid`, `title`, `url`, `source`, `author` (did), optional `path`, `tags[]`; events add optional `startsAt`, `endsAt`, `location`, `mode` (`in-person` \| `virtual` \| `hybrid`). Duplicates return `409`. |
| `GET /documents` · `GET /events`                   | List by type.                                                                                                                                                                                                                                          |
| `DELETE /documents/:rkey` · `DELETE /events/:rkey` | Remove a share (original sharer or anyone with `delete` permission).                                                                                                                                                                                   |

## Hierarchy

Base: `/api/v1/communities/:did/hierarchy` — API key. Parent/child
relationships between communities (e.g. an umbrella org with chapters).

| Method & path                                    | Description                                                           |
| ------------------------------------------------ | --------------------------------------------------------------------- |
| `POST /request`                                  | Ask another community to form a relationship.                         |
| `POST /approve`                                  | Counterparty admin approves; hierarchy records written to both repos. |
| `POST /invite` · `POST /accept` · `POST /reject` | Invite flow in the other direction.                                   |
| `GET /`                                          | Current relationships.                                                |
| `GET /pending`                                   | Pending requests/invites.                                             |
| `GET /content`                                   | Aggregated shared content across the hierarchy.                       |
| `DELETE /:rkey`                                  | Revoke a relationship.                                                |

## Audit log

`GET /api/v1/communities/:did/audit-log` — API key. Query: `adminDid`
(must be an admin), `limit`, `cursor`. Every admin action (membership
decisions, role changes, permission changes, announcements, hierarchy
changes, profile updates) is recorded with actor, action, target, reason,
and metadata.

## Webhooks

Base: `/api/v1/webhooks` — API key. Per-app webhooks, optionally scoped to a
community.

| Method & path        | Description                                                                                                                                                                                                                            |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /`             | Create. Body: `url`, `events[]` ⊆ {`member.joined`, `member.left`, `member.approved`, `member.rejected`, `member.removed`, `record.created`, `record.updated`, `record.deleted`}, optional `communityDid`. Returns a signing `secret`. |
| `GET /`              | List the app's webhooks.                                                                                                                                                                                                               |
| `PUT /:webhookId`    | Update `url` / `events` / `active`.                                                                                                                                                                                                    |
| `DELETE /:webhookId` | Delete.                                                                                                                                                                                                                                |

Deliveries are signed with the webhook secret so receivers can verify origin.

## Event stream

Real-time alternative to webhooks:

1. `POST /api/v1/stream/token` (API key) → short-lived token.
2. Connect to the WebSocket endpoint with the token to receive the same
   event types as webhooks, optionally filtered by community.

`GET /api/v1/events/resolve` supports resolving native calendar-event URIs.

## XRPC surface

Base: `/xrpc/<methodId>` — API key. ATProto-style RPC mirroring the REST
surface, with request/response shapes validated against the lexicon files in
[`lexicons/`](../lexicons). Queries are `GET`, procedures are `POST`.

**Queries:**

| Method                                   | Params                                                              |
| ---------------------------------------- | ------------------------------------------------------------------- |
| `community.opensocial.getCommunity`      | `did`, optional `userDid`                                           |
| `community.opensocial.searchCommunities` | `query`, optional `userDid`, `limit`, `cursor`                      |
| `community.opensocial.getMembers`        | `communityDid`, optional `userDid`, `limit`, `cursor`               |
| `community.opensocial.getPendingMembers` | `communityDid`, `adminDid`                                          |
| `community.opensocial.getPermissions`    | `communityDid`, optional `userDid`                                  |
| `community.opensocial.getRecord`         | `communityDid`, `collection`, `rkey`, optional `userDid`            |
| `community.opensocial.listRecords`       | `communityDid`, `collection`, `limit`, `cursor`, optional `userDid` |

**Procedures:** `joinCommunity`, `leaveCommunity`, `approveMember`,
`rejectMember`, `removeMember`, `createRecord`, `putRecord`, `deleteRecord`,
`deleteCommunity` — inputs mirror the corresponding REST bodies.

## Lexicons

Record types written by this service (all in the community's repo unless
noted):

| Lexicon                                                                          | Key       | Purpose                                                                                                |
| -------------------------------------------------------------------------------- | --------- | ------------------------------------------------------------------------------------------------------ |
| `community.opensocial.profile`                                                   | `self`    | Display name, description, avatar/banner, type (`open`/`admin-approved`/`private`), guidelines, links. |
| `community.opensocial.admins`                                                    | `self`    | Ordered admin DIDs; index 0 is the primary admin.                                                      |
| `community.opensocial.membership`                                                | tid       | Written to the **user's** repo when they join.                                                         |
| `community.opensocial.membershipProof`                                           | tid       | Community-side confirmation (`memberDid`, `cid` of the user's membership record).                      |
| `community.opensocial.announcement`                                              | tid       | Group-only announcement (`title`, `text`, `createdBy`, `createdAt`, optional `updatedAt`, `pinned`).   |
| `community.opensocial.sharedDocument` / `sharedEvent` / `sharedContent` (legacy) | tid       | Content shared into the community.                                                                     |
| `community.opensocial.space`                                                     | space key | Space definition: name, read/write access policy, member collections.                                  |
| `community.opensocial.hierarchy`                                                 | tid       | Parent/child relationship records.                                                                     |
| `community.opensocial.authBasic`                                                 | —         | Permission set granting apps write access to the user's `membership` collection.                       |
