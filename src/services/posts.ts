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
} from "./spaces";
import { isMember, listMemberships } from "./membership";
import { actorCan } from "./roles";
import { logger } from "../lib/logger";

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
  const client = await getSpaceClient(db, communityDid); // owner reads
  const roster = await listMemberships(db, communityDid);
  const authors = [communityDid, ...roster.map((m) => m.subject)];

  const perAuthor = await Promise.all(
    authors.map(async (repo) => {
      try {
        const recs = await client.listRecordValues<{
          text: string;
          author?: string;
          createdAt: string;
        }>(space, POST, repo);
        return recs.map((r) => ({
          rkey: r.rkey,
          author: r.value.author ?? repo,
          text: r.value.text,
          createdAt: r.value.createdAt,
        }));
      } catch (err) {
        // A single member's repo being unreadable shouldn't break the feed.
        // Logged because, until the cross-repo read path is validated live,
        // this catch could mask the owner-reads-member-repos assumption failing.
        logger.warn({ err, communityDid, repo }, "Failed to read member posts");
        return [] as CommunityPost[];
      }
    }),
  );
  return aggregateAndSortPosts(perAuthor);
}
