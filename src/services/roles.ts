/**
 * Community roles stored in the permissioned management space (PoC).
 *
 * Role definitions (`community.opensocial.role`, rkey = role name) carry a list
 * of capabilities; role assignments (`community.opensocial.roleAssignment`)
 * bind a member DID to a role name. Both live as records in the community's
 * management space, so "who may do what" is governance data on-protocol rather
 * than rows in OpenSocial's database.
 *
 * Capability gating (e.g. "post") reads these records — see services/posts.ts.
 */
import type { Kysely } from "kysely";
import type { Database } from "../db";
import { getCommunitySpace, getSpaceClient } from "./spaces";

const ROLE = "community.opensocial.role";
const ROLE_ASSIGNMENT = "community.opensocial.roleAssignment";

export interface RoleDefinition {
  name: string;
  displayName: string;
  capabilities: string[];
}

export interface RoleAssignment {
  subject: string;
  role: string;
}

async function managementSpace(
  db: Kysely<Database>,
  communityDid: string,
): Promise<string> {
  const space = await getCommunitySpace(db, communityDid, "management");
  if (!space) {
    throw new Error(
      `Community ${communityDid} has no management space — run provision:spaces first.`,
    );
  }
  return space;
}

/** Create/replace a role definition (rkey = role name). */
export async function writeRoleDefinition(
  db: Kysely<Database>,
  communityDid: string,
  name: string,
  displayName: string,
  capabilities: string[],
): Promise<void> {
  const space = await managementSpace(db, communityDid);
  const client = await getSpaceClient(db, communityDid);
  await client.putRecord(space, ROLE, name, {
    $type: ROLE,
    name,
    displayName,
    capabilities,
    createdAt: new Date().toISOString(),
  });
}

/** Assign a role to a member (idempotent on subject+role). */
export async function assignRole(
  db: Kysely<Database>,
  communityDid: string,
  subjectDid: string,
  roleName: string,
  assignedBy?: string,
): Promise<void> {
  const existing = await listRoleAssignments(db, communityDid);
  if (existing.some((a) => a.subject === subjectDid && a.role === roleName)) {
    return;
  }
  const space = await managementSpace(db, communityDid);
  const client = await getSpaceClient(db, communityDid);
  await client.createRecord(space, ROLE_ASSIGNMENT, {
    $type: ROLE_ASSIGNMENT,
    subject: subjectDid,
    role: roleName,
    ...(assignedBy ? { assignedBy } : {}),
    createdAt: new Date().toISOString(),
  });
}

export async function listRoleDefinitions(
  db: Kysely<Database>,
  communityDid: string,
): Promise<RoleDefinition[]> {
  const space = await managementSpace(db, communityDid);
  const client = await getSpaceClient(db, communityDid);
  const recs = await client.listRecordValues<RoleDefinition>(space, ROLE);
  return recs.map((r) => ({
    name: r.value.name,
    displayName: r.value.displayName,
    capabilities: r.value.capabilities ?? [],
  }));
}

export async function listRoleAssignments(
  db: Kysely<Database>,
  communityDid: string,
): Promise<RoleAssignment[]> {
  const space = await managementSpace(db, communityDid);
  const client = await getSpaceClient(db, communityDid);
  const recs = await client.listRecordValues<RoleAssignment>(
    space,
    ROLE_ASSIGNMENT,
  );
  return recs.map((r) => ({ subject: r.value.subject, role: r.value.role }));
}

/** Role names assigned to `actorDid`. */
export async function getActorRoleNames(
  db: Kysely<Database>,
  communityDid: string,
  actorDid: string,
): Promise<string[]> {
  const assignments = await listRoleAssignments(db, communityDid);
  return assignments.filter((a) => a.subject === actorDid).map((a) => a.role);
}

/** Whether any role assigned to `actorDid` grants `capability`. */
export async function actorCan(
  db: Kysely<Database>,
  communityDid: string,
  actorDid: string,
  capability: string,
): Promise<boolean> {
  const [roleNames, defs] = await Promise.all([
    getActorRoleNames(db, communityDid, actorDid),
    listRoleDefinitions(db, communityDid),
  ]);
  const capsByRole = new Map(defs.map((d) => [d.name, d.capabilities]));
  return roleNames.some((r) => (capsByRole.get(r) ?? []).includes(capability));
}
