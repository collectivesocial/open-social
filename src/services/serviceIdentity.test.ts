import { describe, it, expect } from "vitest";
import { buildServiceDidDoc } from "./serviceIdentity";

describe("buildServiceDidDoc", () => {
  it("builds a did:web document with the #opensocial service entry", () => {
    const doc = buildServiceDidDoc({
      serviceDid: "did:web:localhost%3A3001",
      serviceEndpoint: "http://localhost:3001",
    });
    expect(doc.id).toBe("did:web:localhost%3A3001");
    expect(doc["@context"]).toContain("https://www.w3.org/ns/did/v1");
    expect(doc.service).toEqual([
      {
        id: "#opensocial",
        type: "OpenSocialCommunityManagement",
        serviceEndpoint: "http://localhost:3001",
      },
    ]);
  });
});
