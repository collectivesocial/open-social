/**
 * Community posts in a permissioned "posts" space (PoC).
 *
 * Posts live in the community's posts space and are written "on behalf of the
 * community" (repo = community DID, owner-signed) but attributed to the author.
 * Who may post is gated by the community's roles in the management space: an
 * actor needs a role granting the "post" capability (see services/roles.ts).
 */
import type { Kysely } from "kysely";
import type { Database } from "../db";
import { getCommunitySpace, getSpaceClient } from "./spaces";
import { actorCan } from "./roles";

const POST = "community.opensocial.post";

/** The "post" capability is required to post on behalf of the community. */
export const POST_CAPABILITY = "post";

export class NotAllowedError extends Error {
  constructor(message = "Not allowed") {
    super(message);
    this.name = "NotAllowedError";
  }
}

export interface CommunityPost {
  rkey: string;
  author: string;
  text: string;
  createdAt: string;
}

async function postsSpace(
  db: Kysely<Database>,
  communityDid: string,
): Promise<string> {
  const space = await getCommunitySpace(db, communityDid, "posts");
  if (!space) {
    throw new Error(
      `Community ${communityDid} has no posts space — run provision:spaces first.`,
    );
  }
  return space;
}

/**
 * Post on behalf of the community. Throws NotAllowedError if the author's roles
 * don't grant the "post" capability.
 */
export async function createCommunityPost(
  db: Kysely<Database>,
  communityDid: string,
  authorDid: string,
  text: string,
): Promise<{ uri: string; cid: string }> {
  const allowed = await actorCan(db, communityDid, authorDid, POST_CAPABILITY);
  if (!allowed) {
    throw new NotAllowedError(
      "Your role does not permit posting on behalf of this community.",
    );
  }
  const space = await postsSpace(db, communityDid);
  const client = await getSpaceClient(db, communityDid);
  return client.createRecord(space, POST, {
    $type: POST,
    text,
    author: authorDid,
    createdAt: new Date().toISOString(),
  });
}

export async function listCommunityPosts(
  db: Kysely<Database>,
  communityDid: string,
): Promise<CommunityPost[]> {
  const space = await postsSpace(db, communityDid);
  const client = await getSpaceClient(db, communityDid);
  const recs = await client.listRecordValues<{
    text: string;
    author: string;
    createdAt: string;
  }>(space, POST);
  return recs
    .map((r) => ({
      rkey: r.rkey,
      author: r.value.author,
      text: r.value.text,
      createdAt: r.value.createdAt,
    }))
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}
