# Permissioned Data Roadmap

How Open Social maps onto atproto's
[permissioned data proposal (0016)](https://github.com/bluesky-social/proposals/tree/main/0016-permissioned-data),
and the migration path from what we have today to a protocol-native
implementation. The announcement space shipped in this repo is deliberately
the first step on this path.

## Why this matters

Open Social's job is to sit between the PDS a group lives on and the apps
that use the group: assemble permissioned group data and enforce the access
boundaries the group has configured. Today that boundary is enforced
entirely at our API layer — group records live in the community's public
atproto repo, and anything that syncs the repo directly bypasses the
boundary. Proposal 0016 moves the boundary into the protocol: records live
in **permissioned repos** inside a **space**, and hosts only serve them to
callers presenting a valid **space credential**.

## Concept mapping

| Proposal 0016 concept                                                                       | Open Social today                                                                                                                                                                                        |
| ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Space authority (a DID that governs a space)                                                | The community DID. Open Social acts as the authority's service.                                                                                                                                          |
| Space (authority DID + space type NSID + space key)                                         | Implicit: a gated collection in the community repo. The announcement space (`community.opensocial.announcement`) is the first one.                                                                       |
| Space membership / writer set                                                               | `community.opensocial.membershipProof` records + the admins record.                                                                                                                                      |
| Authorization policy (`public`, `member-list`, `managing-app` in `com.atproto.simplespace`) | `community_settings.app_visibility_default`, per-app visibility status, and per-collection role rules (`community_app_collection_permissions`). Our model is a superset: role-based rules per operation. |
| App allowlists / client attestations                                                        | App registration + per-community app visibility; HTTP Message Signature auth (CIMD) is our existing app-identity primitive and is structurally similar to client attestation JWTs.                       |
| Delegation token (PDS-minted proof an app acts for a user)                                  | **Missing.** API-key routes accept a caller-asserted `userDid`/`adminDid` and verify it only against membership/admin state — the app is trusted to have authenticated its user.                         |
| Space credential (multi-use, short-lived access grant)                                      | **Missing.** Access is re-checked per request against our database/PDS state.                                                                                                                            |
| Permissioned repo + LtHash commit, `listRepoOps`, CAR recovery                              | **Missing.** All records live in the single public community repo.                                                                                                                                       |

Two takeaways from the table:

1. **The policy engine we already have is the hard, product-shaped part** —
   proposal 0016 explicitly does _not_ define how an authority decides to
   grant access ("the protocol does not define how that decision is made").
   Our membership + roles + per-collection rules become the decision logic
   behind credential issuance.
2. **The missing pieces are protocol plumbing** — token verification,
   credential minting, and the sync surface. These are well-specified and
   mostly cryptographic/mechanical, which also informs the
   [Rust rewrite assessment](RUST_REWRITE.md).

## Migration path

### Phase 0 — group-only spaces at the API layer (shipped)

The announcement space: `community.opensocial.announcement` records in the
community repo with create/update/delete = admin and **read = member**,
enforced by this service. This gives us the product shape of a space
(group-only announcements) and the policy semantics we'll later compile into
credential decisions, while the data remains technically public at the repo
sync layer.

Anything learned here (pinning, editing, role delegation to moderators)
carries forward unchanged, because the permission model is already
expressed as per-collection, per-operation role rules.

### Phase 1 — first-class spaces

Make spaces explicit objects instead of implicit gated collections:

- A `spaces` registry per community: space type (NSID), space key, policy
  (`public` | `member-list` | `managing-app` | role rule), declared
  collections.
- `listGroupSpaces` and `createGroupSpace` methods (the two gaps identified
  in the [group management methods discussion](https://discourse.atprotocol.community/t/another-follow-up-topic-group-management-methods/941)),
  plus `invite`/`revokeInvite` objects for invite-only spaces.
- The announcement space becomes row #1 in the registry rather than a
  special case.

This phase is protocol-independent and immediately useful to client apps.

### Phase 2 — credential flow (become a space authority service)

Adopt the 0016 token model in front of the existing policy engine:

- Verify **delegation tokens** minted by the user's PDS (single-use, ~60s)
  instead of trusting caller-asserted `userDid`/`adminDid` — this closes the
  main trust gap in today's API-key surface.
- Accept **client attestations** where a space gates by app, reusing the
  CIMD/HTTP-signature machinery.
- Issue **space credentials** (multi-use, ~2h) whose grant decision is
  computed from membership, roles, and space policy.
- Support `space:` OAuth scopes (`spaceType`, `authority`, `skey`,
  `collection`, `action` parameters) for user-facing flows.

### Phase 3 — permissioned repos and sync

Move space data out of the public community repo:

- Writes go to per-user **permissioned repos** within the space (an admin's
  announcement lives in the admin's permissioned repo, not the community
  repo), with LtHash set-hash commits.
- Serve the sync surface to credentialed apps: `listRepos` (writer set),
  `listRepoOps` (incremental), CAR download (recovery), best-effort write
  notifications.
- Interop target: whatever `com.atproto.simplespace` requires of every PDS,
  so groups managed by Open Social remain portable.

At this point the group-only boundary holds even against direct repo sync,
and Open Social's role crystallizes into: **space authority service +
policy engine + sync aggregator** for group applications.

## Honest limitations

- Permissioned data is **access control, not confidentiality**: services in
  the path (including this one and each member's PDS) can read the data.
  Nothing here is end-to-end encrypted, and we should not describe
  announcement spaces as "private" in the E2EE sense.
- Until Phase 3, the community repo is publicly syncable; the group-only
  boundary binds apps that go through our API, not raw firehose consumers.
- Proposal 0016 is still a proposal; Phases 2–3 should track its evolution
  (and the `com.atproto.simplespace` baseline) rather than front-run details
  like token formats.
