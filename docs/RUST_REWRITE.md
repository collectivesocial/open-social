# Rust Rewrite Assessment

Evaluation of rewriting Open Social in Rust so it can be hardened as shared
group-management infrastructure — a service that sits between the PDS a
group lives on and the many applications that use the group, assembling
permissioned data and enforcing the group's access boundaries.

**TL;DR recommendation: don't big-bang rewrite the existing service. Make
the API contract the stable artifact now (lexicons + [API.md](API.md) + a
black-box conformance suite), and introduce Rust where the upcoming
permissioned-data work actually needs it — the credential service and the
sync engine — behind the same API. Decide later, with data, whether the
CRUD/policy layer follows.**

## What "hardening" actually requires

If many applications depend on this service, the properties that matter are:

1. **A stable, well-specified contract** — apps break on API drift far more
   often than on implementation bugs. (Addressed by the lexicons and
   [API.md](API.md), independent of language.)
2. **Correct security-critical code paths** — token verification, credential
   issuance, signature checks, permission evaluation.
3. **Predictable performance under fan-out** — Phase 3 of the
   [permissioned-data roadmap](PERMISSIONED_DATA.md) makes this service a
   sync aggregator: pulling operation logs from many member repos, verifying
   LtHash set hashes, parsing CAR files, and serving many concurrent apps.
4. **Operational simplicity** — cheap to run many instances of, easy for
   other operators to self-host.

Rust genuinely helps with 2–4. It does nothing for 1, which is the largest
risk today.

## The case for Rust

- **The future workload fits Rust.** Today's service is I/O-bound CRUD over
  Postgres and PDS calls — Node handles that fine. The permissioned-data
  work adds CPU-bound, concurrency-heavy paths (JWT/attestation verification
  on every request, lattice-hash verification, CAR encoding/decoding,
  high-fan-out repo sync). That profile is exactly where Rust's performance
  and fearless concurrency pay off.
- **Type rigor at the trust boundary.** Exhaustive enums and no implicit
  `any` remove a class of bugs that matter in an authorization service. Our
  current code has several `as any` escapes around dynamic column names and
  agent types that Rust would force us to model.
- **Deployment footprint.** A single static binary with a small memory
  footprint lowers the barrier for other communities/operators to run their
  own instance — relevant if Open Social becomes reference infrastructure.
- **Longevity signal.** Bluesky's own direction (and community projects like
  rsky) make Rust a credible long-term home for atproto infrastructure.

## The case against (rewriting now)

- **Ecosystem gap.** The first-party atproto SDKs (`@atproto/api`,
  `@atproto/oauth-client-node`, lexicon codegen) are TypeScript. Rust has
  community crates (atrium for the API/XRPC layer; rsky components) but
  notably weaker support for the **atproto OAuth client** flow our web
  session auth depends on. We would be reimplementing or maintaining forks
  of security-sensitive auth code — the opposite of hardening.
- **The requirements are still moving.** Proposal 0016 is a proposal;
  the group-management method set is an active community discussion.
  Rewriting while the spec evolves means paying the rewrite cost and the
  churn cost in the slower-iteration language.
- **Rewrite risk on a working system.** 423 passing tests, migrations,
  webhooks, WebSocket streaming, hierarchy — a full port is months of work
  that delivers zero new user-facing capability and reintroduces bugs the
  current code has already burned down.
- **Memory safety is not the argument.** Node is memory-safe. The real wins
  are the ones listed above; be suspicious of "Rust = secure" as the
  motivation.

## Recommended strategy: strangler, not big bang

### Step 1 — freeze the contract, not the code (now)

- Treat `lexicons/` + [API.md](API.md) as the interface of record.
- Build a **black-box conformance suite**: HTTP-level tests that run against
  a base URL (the devnet setup already gets us most of the way). Any future
  implementation — TS or Rust — must pass it. This is the single highest-
  leverage hardening investment, and it converts a risky rewrite into a
  mechanical one.

### Step 2 — new security-critical components start in Rust (Phase 2 of the roadmap)

The delegation-token / space-credential service is new code with no TS
legacy, a narrow interface (verify token → evaluate policy → mint
credential), and the strongest correctness requirements. Build it as a
separate Rust service (or embedded via a sidecar) with:

- **axum** (or actix-web) for HTTP
- **sqlx** against the same Postgres, or gRPC/HTTP calls into the existing
  policy endpoints to avoid duplicating policy logic initially
- **jsonwebtoken/josekit** + **atrium** crates for token and DID/key handling

The existing TS service proxies to it; apps see no change.

### Step 3 — sync engine in Rust (Phase 3 of the roadmap)

`listRepos` / `listRepoOps` / CAR recovery / LtHash verification is the
performance-critical fan-out path and is largely self-contained. Natural
second Rust component; it shares the credential service's crates.

### Step 4 — decide about the rest with evidence

Once Steps 2–3 are in production, the remaining TS surface is CRUD + policy
administration + web session auth — the part best served by the mature TS
atproto SDKs. Port it only if a trigger fires:

- the Rust atproto OAuth client story matures,
- operating two runtimes proves more expensive than porting, or
- load on the CRUD layer actually demands it.

If a trigger fires, the conformance suite from Step 1 makes the port safe,
and the Step 2–3 crates already contain the hard parts.

## Cost sketch

| Path                             | Rough effort                                               | New capability delivered                |
| -------------------------------- | ---------------------------------------------------------- | --------------------------------------- |
| Big-bang rewrite                 | 2–4 months before parity                                   | none until parity                       |
| Conformance suite (Step 1)       | 1–2 weeks                                                  | contract safety for every future change |
| Rust credential service (Step 2) | 3–6 weeks, overlaps roadmap Phase 2 work we must do anyway | delegation tokens, space credentials    |
| Rust sync engine (Step 3)        | scoped by 0016's final shape                               | permissioned repo sync                  |

The strangler path spends almost all effort on things the roadmap requires
regardless of language, and leaves us with the option — not the obligation —
to finish the migration.
