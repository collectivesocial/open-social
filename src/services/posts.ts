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
import {
  getSpaceClient,
  getMemberSpaceClient,
  getCommunitySpace,
  SpaceClient,
} from "./spaces";
import { isMember, listMemberships } from "./membership";
import { actorCan } from "./roles";
import { logger } from "../lib/logger";
import { getCommunitySpaceCredential } from "./spaceCredentials";
import { resolvePdsEndpoint } from "./atproto";

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

interface PostRecord {
  text: string;
  author?: string;
  createdAt: string;
}

/** Map a `{rkey,cid,value}` space record to the `CommunityPost` shape. */
function toCommunityPost(
  r: { rkey: string; value: PostRecord },
  fallbackAuthor: string,
): CommunityPost {
  return {
    rkey: r.rkey,
    author: r.value.author ?? fallbackAuthor,
    text: r.value.text,
    createdAt: r.value.createdAt,
  };
}

/** Flatten per-author post lists and sort newest-first. Pure (unit-tested). */
export function aggregateAndSortPosts(
  perAuthor: CommunityPost[][],
): CommunityPost[] {
  return perAuthor.flat().sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
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

/**
 * Post as a member, into the member's own repo within the community posts
 * space. Any active member may do this — no special capability required.
 */
export async function createMemberPost(
  db: Kysely<Database>,
  communityDid: string,
  authorDid: string,
  text: string,
): Promise<{ uri: string; cid: string }> {
  if (!(await isMember(db, communityDid, authorDid))) {
    throw new NotAllowedError("Only community members can post.");
  }
  const space = await postsSpace(db, communityDid);
  const client = await getMemberSpaceClient(db, authorDid); // authed AS the member
  return client.createRecord(space, POST, {
    $type: POST,
    text,
    author: authorDid,
    createdAt: new Date().toISOString(),
  });
}

/**
 * The community feed: aggregate posts across every member's repo in the posts
 * space, plus the community's own repo (for "post as community"). Enumerates
 * authors from the membership records (stands in for the future "list writers"
 * primitive).
 */
export async function listCommunityPosts(
  db: Kysely<Database>,
  communityDid: string,
): Promise<CommunityPost[]> {
  const space = await postsSpace(db, communityDid);
  const ownerClient = await getSpaceClient(db, communityDid);
  const roster = await listMemberships(db, communityDid);
  const memberAuthors = roster
    .map((m) => m.subject)
    .filter((s) => s !== communityDid);

  const perAuthor: CommunityPost[][] = [];

  // Community's own records: read with its own session on its own PDS.
  try {
    const own = await ownerClient.listRecordValues<PostRecord>(
      space,
      POST,
      communityDid,
    );
    perAuthor.push(own.map((r) => toCommunityPost(r, communityDid)));
  } catch (err) {
    logger.warn(
      { err, author: communityDid },
      "failed to read community's own posts",
    );
  }

  // Member records live on each member's PDS; reads require a space credential.
  if (memberAuthors.length > 0) {
    const credential = await getCommunitySpaceCredential(
      db,
      communityDid,
      space,
    );
    for (const author of memberAuthors) {
      try {
        const pdsUrl = await resolvePdsEndpoint(author);
        const client = SpaceClient.withToken(async () => credential, pdsUrl);
        const values = await client.listRecordValues<PostRecord>(
          space,
          POST,
          author,
        );
        perAuthor.push(values.map((r) => toCommunityPost(r, author)));
      } catch (err) {
        logger.warn({ err, author }, "failed to read member repo; skipping");
      }
    }
  }

  return aggregateAndSortPosts(perAuthor);
}
