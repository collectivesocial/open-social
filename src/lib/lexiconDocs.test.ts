import { describe, it, expect } from "vitest";
import path from "node:path";
import { loadLexiconDocs } from "./lexiconDocs";

describe("loadLexiconDocs", () => {
  it("loads every community.opensocial lexicon JSON with an id", async () => {
    const docs = await loadLexiconDocs(path.join(__dirname, "../../lexicons"));
    const ids = docs.map((d) => d.id);
    for (const required of [
      "community.opensocial.management",
      "community.opensocial.posts",
      "community.opensocial.role",
      "community.opensocial.roleAssignment",
      "community.opensocial.membership",
      "community.opensocial.post",
      "community.opensocial.auditLogEntry",
    ]) {
      expect(ids).toContain(required);
    }
    for (const d of docs) expect(d.lexicon).toBe(1);
  });

  it("space type declarations list their collections", async () => {
    const docs = await loadLexiconDocs(path.join(__dirname, "../../lexicons"));
    const mgmt = docs.find(
      (d) => d.id === "community.opensocial.management",
    ) as any;
    expect(mgmt.defs.main.type).toBe("space");
    expect(mgmt.defs.main.collections).toContain(
      "community.opensocial.membership",
    );
    expect(mgmt.defs.main.collections).toContain("community.opensocial.role");
    expect(mgmt.defs.main.collections).toContain(
      "community.opensocial.auditLogEntry",
    );
  });
});
