/**
 * Permissioned-space client + provisioning for OpenSocial communities.
 *
 * OpenSocial historically stores community data as plain records in the
 * community account's repo (com.atproto.repo.*). This module introduces AT
 * Protocol *permissioned spaces* (com.atproto.space.*) so that governance and
 * membership records can live in a dedicated space owned by the community — a
 * step toward credible exit between community-management apps.
 *
 * `@atproto/api`'s agent does not know the experimental com.atproto.space.*
 * lexicons, so we issue raw authenticated XRPC calls against the community's
 * PDS, reusing the cached community agent's session token for auth. This keeps
 * the integration self-contained (no @atproto/lex codegen) for the PoC.
 *
 * NOTE: com.atproto.space.* only exists on the atproto `permissioned-data`
 * branch. The community account must live on a PDS that runs it (e.g. the dev
 * PDS); production PDSes (bsky.social) will 404 these endpoints.
 */
import type { BskyAgent } from "@atproto/api";
import type { Kysely } from "kysely";
import type { Database } from "../db";
import {
  createCommunityAgent,
  getMemberAgent,
  resolvePdsEndpoint,
} from "./atproto";
import { logger } from "../lib/logger";

/** Space type NSIDs. Declared as `type: space` lexicons for the PoC. */
export const MANAGEMENT_SPACE_TYPE = "community.opensocial.management";
export const POSTS_SPACE_TYPE = "community.opensocial.posts";

export type SpaceKind = "management" | "posts";

const SPACE_TYPE_BY_KIND: Record<SpaceKind, string> = {
  management: MANAGEMENT_SPACE_TYPE,
  posts: POSTS_SPACE_TYPE,
};

export class SpaceXrpcError extends Error {
  constructor(
    public status: number,
    public nsid: string,
    public detail: string,
  ) {
    super(`space XRPC ${nsid} failed (${status}): ${detail}`);
    this.name = "SpaceXrpcError";
  }
}

interface SpaceXrpcOptions {
  method: "GET" | "POST";
  params?: Record<string, string | number | undefined>;
  body?: unknown;
}

export interface SpaceRecord<V = any> {
  uri: string;
  cid: string;
  value: V;
}

/**
 * A listing entry from com.atproto.space.listRecords. Note it carries NO record
 * value (unlike com.atproto.repo.listRecords) — fetch the value with getRecord.
 */
export interface SpaceRecordRef {
  collection: string;
  rkey: string;
  cid: string;
}

/**
 * Thin authenticated client for com.atproto.space.* on a single community's
 * PDS. Construct via {@link getSpaceClient}.
 */
export class SpaceClient {
  constructor(
    private agent: BskyAgent,
    private pdsUrl: string,
  ) {}

  private async call<T = any>(
    nsid: string,
    opts: SpaceXrpcOptions,
  ): Promise<T | undefined> {
    const token = (this.agent as any).session?.accessJwt as string | undefined;
    if (!token) throw new Error("community agent has no active session");

    const url = new URL(`/xrpc/${nsid}`, this.pdsUrl);
    if (opts.params) {
      for (const [k, v] of Object.entries(opts.params)) {
        if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
      }
    }

    const res = await fetch(url, {
      method: opts.method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(opts.body !== undefined
          ? { "content-type": "application/json" }
          : {}),
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new SpaceXrpcError(res.status, nsid, detail);
    }

    const text = await res.text();
    return text ? (JSON.parse(text) as T) : undefined;
  }

  /** Create a permissioned space owned by `ownerDid`. */
  async createSpace(
    ownerDid: string,
    type: string,
    skey?: string,
  ): Promise<{ uri: string }> {
    return (await this.call("com.atproto.space.createSpace", {
      method: "POST",
      body: { did: ownerDid, type, ...(skey ? { skey } : {}) },
    })) as { uri: string };
  }

  /**
   * DID of the authenticated account (the community). com.atproto.space.*
   * record methods all require a `repo` — the repo within the space to act on —
   * which defaults to the community's own repo.
   */
  private ownDid(): string {
    const did = (this.agent as any).session?.did as string | undefined;
    if (!did) throw new Error("community agent has no active session");
    return did;
  }

  async createRecord(
    space: string,
    collection: string,
    record: Record<string, unknown>,
    rkey?: string,
    repo: string = this.ownDid(),
  ): Promise<{ uri: string; cid: string }> {
    return (await this.call("com.atproto.space.createRecord", {
      method: "POST",
      body: {
        space,
        repo,
        collection,
        ...(rkey ? { rkey } : {}),
        record,
        validate: false,
      },
    })) as { uri: string; cid: string };
  }

  async putRecord(
    space: string,
    collection: string,
    rkey: string,
    record: Record<string, unknown>,
    repo: string = this.ownDid(),
  ): Promise<{ uri: string; cid: string }> {
    return (await this.call("com.atproto.space.putRecord", {
      method: "POST",
      body: { space, repo, collection, rkey, record, validate: false },
    })) as { uri: string; cid: string };
  }

  async getRecord<V = any>(
    space: string,
    collection: string,
    rkey: string,
    repo: string = this.ownDid(),
  ): Promise<SpaceRecord<V> | undefined> {
    return this.call<SpaceRecord<V>>("com.atproto.space.getRecord", {
      method: "GET",
      params: { space, repo, collection, rkey },
    });
  }

  async listRecords(
    space: string,
    collection: string,
    opts: { limit?: number; cursor?: string } = {},
    repo: string = this.ownDid(),
  ): Promise<{ records: SpaceRecordRef[]; cursor?: string }> {
    const res = await this.call<{ records: SpaceRecordRef[]; cursor?: string }>(
      "com.atproto.space.listRecords",
      {
        method: "GET",
        params: {
          space,
          repo,
          collection,
          limit: opts.limit,
          cursor: opts.cursor,
        },
      },
    );
    return res ?? { records: [] };
  }

  /**
   * listRecords + getRecord hydration. com.atproto.space.listRecords returns
   * only {collection, rkey, cid} (no value), so fetch each record's value.
   */
  async listRecordValues<V = any>(
    space: string,
    collection: string,
    repo: string = this.ownDid(),
  ): Promise<Array<{ rkey: string; cid: string; value: V }>> {
    const out: Array<{ rkey: string; cid: string; value: V }> = [];
    let cursor: string | undefined;
    do {
      const { records, cursor: next } = await this.listRecords(
        space,
        collection,
        { limit: 100, cursor },
        repo,
      );
      for (const ref of records) {
        const full = await this.getRecord<V>(space, collection, ref.rkey, repo);
        if (full?.value)
          out.push({ rkey: ref.rkey, cid: ref.cid, value: full.value });
      }
      cursor = next;
    } while (cursor);
    return out;
  }

  async deleteRecord(
    space: string,
    collection: string,
    rkey: string,
    repo: string = this.ownDid(),
  ): Promise<void> {
    await this.call("com.atproto.space.deleteRecord", {
      method: "POST",
      body: { space, repo, collection, rkey },
    });
  }

  async addMember(space: string, did: string): Promise<void> {
    await this.call("com.atproto.space.addMember", {
      method: "POST",
      body: { space, did },
    });
  }

  async getMembers(
    space: string,
    opts: { limit?: number; cursor?: string } = {},
  ): Promise<{ members: Array<{ did: string }>; cursor?: string }> {
    const res = await this.call<{
      members: Array<{ did: string }>;
      cursor?: string;
    }>("com.atproto.space.getMembers", {
      method: "GET",
      params: { space, limit: opts.limit, cursor: opts.cursor },
    });
    return res ?? { members: [] };
  }
}

/** Build a {@link SpaceClient} for a community, authenticated as that community. */
export async function getSpaceClient(
  db: Kysely<Database>,
  communityDid: string,
): Promise<SpaceClient> {
  const agent = await createCommunityAgent(db, communityDid);
  const community = await db
    .selectFrom("communities")
    .select("pds_host")
    .where("did", "=", communityDid)
    .executeTakeFirst();
  const pdsUrl = await resolvePdsEndpoint(communityDid, community?.pds_host);
  return new SpaceClient(agent, pdsUrl);
}

/**
 * Build a SpaceClient authenticated as a *member* (not the community), so the
 * member can write records into their OWN repo within a community space.
 */
export async function getMemberSpaceClient(
  db: Kysely<Database>,
  memberDid: string,
): Promise<SpaceClient> {
  const agent = await getMemberAgent(db, memberDid);
  const acct = await db
    .selectFrom("poc_member_accounts")
    .select("pds_host")
    .where("did", "=", memberDid)
    .executeTakeFirst();
  const pdsUrl = await resolvePdsEndpoint(memberDid, acct?.pds_host);
  return new SpaceClient(agent, pdsUrl);
}

/**
 * Ensure the community's management + posts spaces exist, creating any that
 * are missing. Idempotent: provisioned space URIs are recorded in
 * `community_spaces`.
 */
export async function provisionCommunitySpaces(
  db: Kysely<Database>,
  communityDid: string,
): Promise<Record<SpaceKind, string>> {
  const existing = await db
    .selectFrom("community_spaces")
    .select(["kind", "space_uri"])
    .where("community_did", "=", communityDid)
    .execute();
  const byKind = new Map(
    existing.map((r) => [r.kind as SpaceKind, r.space_uri]),
  );

  const client = await getSpaceClient(db, communityDid);
  const result = {} as Record<SpaceKind, string>;

  for (const kind of Object.keys(SPACE_TYPE_BY_KIND) as SpaceKind[]) {
    let uri = byKind.get(kind);
    if (!uri) {
      const created = await client.createSpace(
        communityDid,
        SPACE_TYPE_BY_KIND[kind],
      );
      uri = created.uri;
      await db
        .insertInto("community_spaces")
        .values({ community_did: communityDid, kind, space_uri: uri })
        .onConflict((oc) => oc.columns(["community_did", "kind"]).doNothing())
        .execute();
      logger.info({ communityDid, kind, uri }, "Provisioned community space");
    }
    result[kind] = uri;
  }

  return result;
}

/** Look up a provisioned space URI for a community, or null if not provisioned. */
export async function getCommunitySpace(
  db: Kysely<Database>,
  communityDid: string,
  kind: SpaceKind,
): Promise<string | null> {
  const row = await db
    .selectFrom("community_spaces")
    .select("space_uri")
    .where("community_did", "=", communityDid)
    .where("kind", "=", kind)
    .executeTakeFirst();
  return row?.space_uri ?? null;
}

/**
 * Return the community's management space URI, provisioning all spaces if it
 * has not been set up yet. Used by code paths that need to read/write
 * governance or membership records in the space.
 */
export async function getOrProvisionManagementSpace(
  db: Kysely<Database>,
  communityDid: string,
): Promise<string> {
  const existing = await getCommunitySpace(db, communityDid, "management");
  if (existing) return existing;
  const provisioned = await provisionCommunitySpaces(db, communityDid);
  return provisioned.management;
}
