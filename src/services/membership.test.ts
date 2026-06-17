import { describe, it, expect } from "vitest";
import { applyMembershipVisibility, type Roster } from "./membership";

const roster: Roster = [
  { subject: "did:plc:a", status: "active", joinedAt: "2026-01-01T00:00:00Z" },
  { subject: "did:plc:b", status: "active", joinedAt: "2026-01-02T00:00:00Z" },
];

describe("applyMembershipVisibility", () => {
  it("public: returns the full roster to anyone", () => {
    expect(
      applyMembershipVisibility(
        roster,
        { isMember: false, isAdmin: false },
        "public",
      ),
    ).toHaveLength(2);
  });
  it("internal: full roster to members, empty to non-members", () => {
    expect(
      applyMembershipVisibility(
        roster,
        { isMember: true, isAdmin: false },
        "internal",
      ),
    ).toHaveLength(2);
    expect(
      applyMembershipVisibility(
        roster,
        { isMember: false, isAdmin: false },
        "internal",
      ),
    ).toHaveLength(0);
  });
  it("admin-only: full roster to admins, empty otherwise", () => {
    expect(
      applyMembershipVisibility(
        roster,
        { isMember: true, isAdmin: true },
        "admin-only",
      ),
    ).toHaveLength(2);
    expect(
      applyMembershipVisibility(
        roster,
        { isMember: true, isAdmin: false },
        "admin-only",
      ),
    ).toHaveLength(0);
  });
  it("none: always empty", () => {
    expect(
      applyMembershipVisibility(
        roster,
        { isMember: true, isAdmin: true },
        "none",
      ),
    ).toHaveLength(0);
  });
});
