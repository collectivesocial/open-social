import { describe, it, expect } from "vitest";
import { Secp256k1Keypair } from "@atproto/crypto";
import { createServiceJwt } from "@atproto/xrpc-server";
import { verifyServiceAuth, ServiceAuthError } from "./serviceAuth";

const LXM = "com.atproto.simplespace.checkUserAccess";
const SERVICE_ID = "did:web:localhost%3A3001#opensocial";

// config.serviceId comes from env; set it for this suite.
process.env.OPENSOCIAL_SERVICE_DID = "did:web:localhost%3A3001";

async function makeJwt(overrides: Partial<{ aud: string; lxm: string }> = {}) {
  const keypair = await Secp256k1Keypair.create();
  const jwt = await createServiceJwt({
    iss: "did:plc:authority",
    aud: overrides.aud ?? SERVICE_ID,
    lxm: overrides.lxm ?? LXM,
    keypair,
  });
  const getSigningKey = async () => keypair.did();
  return { jwt, getSigningKey };
}

describe("verifyServiceAuth", () => {
  it("accepts a valid authority-signed JWT and returns iss", async () => {
    const { jwt, getSigningKey } = await makeJwt();
    const payload = await verifyServiceAuth(`Bearer ${jwt}`, LXM, {
      getSigningKey,
    });
    expect(payload.iss).toBe("did:plc:authority");
  });

  it("rejects a missing header", async () => {
    await expect(verifyServiceAuth(undefined, LXM)).rejects.toBeInstanceOf(
      ServiceAuthError,
    );
  });

  it("rejects a wrong audience", async () => {
    const { jwt, getSigningKey } = await makeJwt({
      aud: "did:web:evil.example#other",
    });
    await expect(
      verifyServiceAuth(`Bearer ${jwt}`, LXM, { getSigningKey }),
    ).rejects.toBeInstanceOf(ServiceAuthError);
  });

  it("rejects a wrong lxm", async () => {
    const { jwt, getSigningKey } = await makeJwt({
      lxm: "com.atproto.space.notifyWrite",
    });
    await expect(
      verifyServiceAuth(`Bearer ${jwt}`, LXM, { getSigningKey }),
    ).rejects.toBeInstanceOf(ServiceAuthError);
  });

  it("rejects a signature from a different key", async () => {
    const { jwt } = await makeJwt();
    const other = await Secp256k1Keypair.create();
    await expect(
      verifyServiceAuth(`Bearer ${jwt}`, LXM, {
        getSigningKey: async () => other.did(),
      }),
    ).rejects.toBeInstanceOf(ServiceAuthError);
  });
});
