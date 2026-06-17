# Permissioned-Spaces Communities — PoC Design (OpenSocial)

Date: 2026-06-17
Branch: cut a new branch off `poc/permissioned-spaces` (both open-social and open-social-web).

## Goal

Demonstrate, end-to-end on the dev-env, an **atmospheric community** whose
governance and roster live on-protocol in a permissioned space, whose content
is authored into **each member's own repo**, and whose access is decided by
OpenSocial as the **managing app** — not by a protocol-mandated member list.
The PoC should make the "who pulls from what" story tangible and stay
forward-compatible with the in-flight protocol direction (member-list removal),
so nothing we build conceptually gets invalidated when that lands.

This is the **managed tier** (Tier 2 below). It is a PoC: correctness of the
_model_ matters; production hardening does not.

## The model (settled)

Worked out in brainstorming; recorded here so the design is self-contained.

### Tiers of community

```
Tier 0 — public space        : isPublic=true. No roster, no app. Anyone mints + reads.
Tier 1 — simple private       : community DID owns access directly. No app, no roles.
Tier 2 — managed (OpenSocial) : managingApp set. OpenSocial is the access authority;
                                membership records are the source of truth; roles,
                                join/approval flows live here.   ← THIS PoC
```

A managing app is **not required** for a community to exist — Tiers 0/1 lean on
the protocol alone. An enabled app discovers whether a community is managed by
reading `managingApp` off the space (`com.atproto.space.getSpace`) — discovery
is protocol-native, no profile shim needed.

### Two lists collapse into one (records-as-truth)

The in-flight protocol proposal (Holmgren/Jesse) removes the materialized
_reader_ member list from the protocol. Access becomes a decision the space host
makes at **credential-mint time**, modeled however it likes — ideally as records
in the space owner's repo within the space (for migration). That deletes the
"protocol ACL vs. governance records" duality: there is **one** list, in the app
layer, which is exactly where we chose to put it.

- **Source of truth** = `membership` records in the **management space**
  (authored by the community DID, in its own repo within that space → the
  migration artifact).
- **Enforcement** = at mint time, the authority (OpenSocial) decides whether to
  issue a space credential. Today's dev-env still mints from a member list and
  has no mint-callout, so OpenSocial **pre-materializes** the decision by
  calling `addMember` — a clearly-labeled, throwaway shim (see Dev-env bridges).
- **Rendering** needs the _writers_, not the readers. The future primitive is
  "list writers"; until it exists, enumerate authors from the membership records.

### Authorship: content lives in each member's own repo

Members write content (posts) into **their own** permissioned repo within the
modality space, attributed to them. The community feed is the **aggregate across
member repos**. There is no central community-owned content store.

"Post on behalf of the community" (write into the _community's_ repo, role-gated)
is kept as a **distinct** action, precisely to contrast the two patterns.

### Access: decide once, read direct

Permission is checked **once, at credential-mint time** — OpenSocial is the
authority, not a per-read gateway and not the data store. After a reader holds a
space credential it reads **directly from member PDSes**, which honor the
credential cryptographically without phoning back to OpenSocial. A credential
reads the **whole** space (no per-record/per-user read filter); tighter subsets
are modeled as separate spaces. The requesting **app** must also be permitted
(`appAccessMode`/`appExceptions`, by OAuth client ID) — the "OAuth consent
boundary = space NSID" point.

## What exists today (the current PoC)

All on `poc/permissioned-spaces`. The plumbing is solid and stays; the content/
roster _semantics_ are what change.

| Area         | File                                    | What it does today                                                                                                                                                                                                                                                                           | Keep / Change                                                               |
| ------------ | --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Space client | `src/services/spaces.ts`                | Raw authenticated XRPC to `com.atproto.space.*` (createSpace, create/put/get/list/deleteRecord, addMember, getMembers). Provisions **3** spaces: `management`, `content`, `posts`. Record methods default `repo` to the **community DID**. `community_spaces` table maps community→kind→uri. | **Keep** client; **change** provisioning + add per-member-repo reads/writes |
| Roles        | `src/services/roles.ts`                 | `community.opensocial.role` (rkey=name, `capabilities[]`) + `roleAssignment` records in the management space; `actorCan(cap)`.                                                                                                                                                               | **Keep** mostly as-is                                                       |
| Posts        | `src/services/posts.ts`                 | `createCommunityPost` writes `community.opensocial.post` into the posts space with **repo = community DID**, gated by `actorCan('post')`. `listCommunityPosts` reads only the **community repo**.                                                                                            | **Change** — add member-authored path + fan-out read                        |
| Membership   | `src/services/membership.ts`            | `membershipProof` record; when a management space exists, `addMember(managementSpace, did)` **and** writes the proof there; else legacy repo.                                                                                                                                                | **Change** — records become source of truth; fix which space members join   |
| Dev API      | `src/routes/poc.ts`                     | Dev-only, no auth, explicit `actorDid`. GET communities / members (`getMembers` on mgmt space + roles) / roles / posts; POST posts (role-gated, 403 on `NotAllowedError`).                                                                                                                   | **Change** — reframe to mirror contract procedures; members from records    |
| Web          | `open-social-web/src/pages/PocPage.tsx` | Act-as switcher, composer, posts list, members list, `/poc` route (unauthed).                                                                                                                                                                                                                | **Change** — show per-author feed + member-vs-community post                |
| Seed         | `scripts/seed-devenv-community.ts`      | Creates `democommunity.test` + `osadmin.test` + `osmember.test` (app passwords), provisions spaces, seeds roles (`admin`→`[post,manage]`, `member`→`[]`) + assignments + membership proofs.                                                                                                  | **Change** — seed member-authored posts; persist member creds               |
| Migration    | `migrations/015_community_spaces.ts`    | `community_spaces(community_did, kind, space_uri, unique(community_did,kind))`.                                                                                                                                                                                                              | **Keep**                                                                    |

### Two correctness gaps in the current PoC (relative to the model)

1. **Everyone joins the management space.** `writeMembershipProof` calls
   `addMember(managementSpace, did)` for _every_ member, and the proof records
   live there too. The management space must be **admin-only** (so the audit log
   stays private). General members should get access to **modality** spaces
   (posts), not the management space.
2. **Posts are community-authored only.** Content is written into the community
   repo, so the "members author into their own repos, feed is the aggregate"
   mechanic — the headline of the new model — isn't exercised at all.

## Target architecture

### Spaces per community

| Space (kind)  | Type NSID                         | Member list (who's added) | Holds                                                                              |
| ------------- | --------------------------------- | ------------------------- | ---------------------------------------------------------------------------------- |
| `management`  | `community.opensocial.management` | **admins/managers only**  | role defs, role assignments, **membership records (roster)**, (optional) audit log |
| `posts`       | `community.opensocial.posts`      | **all members** (shim)    | `community.opensocial.post` records, authored **per-member-repo**                  |
| ~~`content`~~ | —                                 | —                         | drop for the PoC (unused); revisit when a 2nd modality is needed                   |

### Records

- `community.opensocial.membership` (new; supersedes `membershipProof`) — in the
  **management space**, authored by the community DID. Fields: `subject` (did),
  `status` (`active`\|`pending`), `role?`, `joinedAt`, `approvedBy?`. **This is
  the roster source of truth and the migration artifact.**
- `community.opensocial.role` / `roleAssignment` — unchanged.
- `community.opensocial.post` — unchanged shape, but now written with
  `repo = <author DID>` for member posts (and still `repo = <community DID>` for
  the distinct "post as community" action).

### Access flow (PoC, managed tier)

1. **Join** → OpenSocial applies policy → writes a `membership` record (truth) →
   `addMember(postsSpace, did)` (shim, so the dev-env will mint).
2. **Write a post** → as the member: agent for `actorDid` →
   `createRecord(postsSpace, repo=actorDid, collection=post, …)`.
3. **Read the feed** → enumerate authors from `membership` records → for each,
   `listRecords(postsSpace, repo=author, collection=post)` + hydrate → aggregate
   - sort. (Stands in for "list writers".)

## What changes (the deltas)

| #   | Change                                                                                                                                                                                                                                                                                                                              | Where                                                       |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| 1   | **Provision `management` + `posts` only** (drop `content`). Management space member list = admins only.                                                                                                                                                                                                                             | `spaces.ts` `provisionCommunitySpaces`, `SpaceKind`         |
| 2   | **Membership records become the source of truth.** Rename `membershipProof` → `membership` with metadata (`subject/status/role/joinedAt/approvedBy`). Roster is enumerated from these records, **not** `getMembers`.                                                                                                                | `membership.ts`                                             |
| 3   | **Fix space assignment.** General members → `addMember(postsSpace, did)` (shim). Only admins → `addMember(managementSpace, did)`. Membership records still live in the management space (admin-readable; everyone else reads via the procedure).                                                                                    | `membership.ts`, join path                                  |
| 4   | **Add member-authored posting.** `createMemberPost(communityDid, authorDid, text)` → agent for `authorDid` → `createRecord(postsSpace, repo=authorDid, …)`. Requires `authorDid` to be a member (has a `membership` record). Keep `createCommunityPost` (repo=community, `actorCan('post')`) as the distinct "as community" action. | `posts.ts`                                                  |
| 5   | **Fan-out feed read.** `listCommunityPosts` enumerates authors from membership records, lists each author's repo in the posts space, aggregates + sorts. Replaces the single-community-repo read.                                                                                                                                   | `posts.ts`                                                  |
| 6   | **Reframe dev endpoints to mirror the contract.** `isCommunityMember` (`{isMember, role?}`), `getCommunityMembers` (visibility-gated, from records), `joinCommunity`, `listCommunitySpaces`; `/members` reads records, not `getMembers`; `POST /posts` defaults to member-authored, with a flag/route for "as community".           | `routes/poc.ts`                                             |
| 7   | **Persist member creds for act-as writes.** Seed stores each member account's app password where the PoC can build a member agent (DB or dev accounts file).                                                                                                                                                                        | `seed-devenv-community.ts`, a small `getMemberAgent` helper |
| 8   | **Web: show the aggregate.** Feed renders posts from multiple authors with attribution; composer posts **as the acting member** by default, with a separate "post as community" affordance (enabled only when the actor has `post`).                                                                                                | `PocPage.tsx`                                               |
| 9   | **Seed member-authored content.** Seed a couple of posts authored by `osadmin` and `osmember` _in their own repos_ so the aggregate is visible immediately.                                                                                                                                                                         | `seed-devenv-community.ts`                                  |

## Dev-env bridges (explicitly throwaway)

These exist only because the dev-env is behind the protocol proposal. Each is
labeled in-code as deletable when the protocol catches up:

- **`addMember` as a mint shim.** The dev-env mints credentials from a member
  list, so OpenSocial pre-materializes its access decision by adding members to
  the posts space. Deleted when the **mint-callout** lands (PDS asks OpenSocial
  at request time).
- **Author enumeration via membership records** stands in for the future
  **"list writers"** primitive.
- **Act-as switcher + stored app passwords** stand in for real OAuth. The member
  agent writing into the member's own repo is the genuine mechanic; only the
  auth is stubbed.

## Scope

**In:** the deltas above, on the dev-env, for one seeded community with an admin
and a member. The demonstrable thesis: roster-from-records, per-member-repo
authorship, aggregate feed, admin-only management space, managing-app-as-authority.

**Out (follow-on):**

- A real cross-app **consumer** (CollectiveSocial) rendering via the contract.
  The PoC demonstrates the boundary same-app via `/api/poc/*`.
- The genuine **grant → credential → read-from-member-PDS** mint dance with a
  distinct reader identity (see open question). PoC reads as the owner agent.
- Real OAuth login for `.test` handles; the mint-callout method; `isPublic`
  Tier-0 and app-less Tier-1 flows; the `community.opensocial.*` →
  `community.lexicon.community.*` namespace move.

## Open questions to resolve during implementation

1. **Cross-repo reads in the dev-env.** Can the community (owner) agent
   `listRecords`/`getRecord` across _member_ repos in its own space with just
   its owner session, or must it mint a space credential first? A short spike
   gates the shape of the fan-out read (delta #5). If owner-reads work, the PoC
   stays simple; if not, OpenSocial mints a credential for itself.
2. **Where member app passwords live** for act-as writes (delta #7) — reuse the
   existing seed/accounts mechanism vs. a DB column. Pick the lower-friction one.

## Demo / verification

1. `make run-dev-env` (atproto), `os-pg` up, `migrate:devenv`, `seed:devenv`.
2. Open `http://127.0.0.1:5174/poc` (no login).
3. **Aggregate feed**: see posts authored by _both_ `osadmin` and `osmember`,
   each attributed to its author — proving per-member-repo authorship + fan-out.
4. **Act as `osmember`** → post → appears, authored by osmember's repo.
5. **Act as `osmember`** → "post as community" is unavailable (lacks `post`).
   **Act as `osadmin`** → "post as community" works (writes community repo).
6. **Members** list comes from `membership` records (roster), with roles overlaid.
7. Inspect spaces: `management` member list = admins only; `posts` member list =
   all members; membership records live in `management`.
