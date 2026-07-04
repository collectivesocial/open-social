/**
 * com.atproto.simplespace.checkUserAccess — the mint-time callout.
 * The group's PDS (space authority) asks us whether `user` may receive a
 * space credential. Fail closed: any doubt => authorized: false.
 */
import type { Request, Response } from "express";
import type { Kysely } from "kysely";
import type { Database } from "../db";
import { verifyServiceAuth, ServiceAuthError } from "./serviceAuth";
import { getCommunitySpaceByUri, type SpaceKind } from "../services/spaces";
import { listMemberships, type Roster } from "../services/membership";
import { actorCan } from "../services/roles";
import { logger } from "../lib/logger";

export const CHECK_USER_ACCESS_LXM = "com.atproto.simplespace.checkUserAccess";

export function decideUserAccess(input: {
  kind: SpaceKind;
  communityDid: string;
  user: string;
  roster: Roster;
  userCanManage: boolean;
}): boolean {
  if (input.user === input.communityDid) return true;
  if (input.kind === "posts") {
    return input.roster.some(
      (m) => m.subject === input.user && m.status === "active",
    );
  }
  return input.userCanManage;
}

export function createCheckUserAccessHandler(db: Kysely<Database>) {
  return async (req: Request, res: Response) => {
    const space = req.query.space;
    const user = req.query.user;
    if (typeof space !== "string" || typeof user !== "string") {
      return res
        .status(400)
        .json({
          error: "InvalidRequest",
          message: "space and user are required",
        });
    }
    let iss: string;
    try {
      ({ iss } = await verifyServiceAuth(
        req.headers.authorization,
        CHECK_USER_ACCESS_LXM,
      ));
    } catch (err) {
      const status = err instanceof ServiceAuthError ? err.status : 401;
      return res
        .status(status)
        .json({ error: "AuthRequired", message: (err as Error).message });
    }
    try {
      const spaceRow = await getCommunitySpaceByUri(db, space);
      if (!spaceRow || spaceRow.community_did !== iss.split("#")[0]) {
        return res.json({ authorized: false });
      }
      const [roster, userCanManage] = await Promise.all([
        listMemberships(db, spaceRow.community_did),
        actorCan(db, spaceRow.community_did, user, "manage"),
      ]);
      const authorized = decideUserAccess({
        kind: spaceRow.kind,
        communityDid: spaceRow.community_did,
        user,
        roster,
        userCanManage,
      });
      return res.json({ authorized });
    } catch (err) {
      logger.warn({ err, space, user }, "checkUserAccess failed; denying");
      return res.json({ authorized: false });
    }
  };
}
