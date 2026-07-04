/**
 * Publish this repo's community.opensocial.* lexicons to the dev-env
 * lexicon authority so PDSes can resolve our NSIDs.
 * Usage: npm run publish:lexicons  (sources .env.devnet)
 */
import { loadLexiconDocs } from "../src/lib/lexiconDocs";

const INTROSPECT_URL =
  process.env.DEV_INTROSPECT_URL ?? "http://localhost:2581";
const LEXICON_COLLECTION = "com.atproto.lexicon.schema";

async function getAuthority(): Promise<{
  handle: string;
  password: string;
  pds: string;
}> {
  try {
    const res = await fetch(INTROSPECT_URL);
    const info = (await res.json()) as any;
    if (info?.lexiconAuthority) return info.lexiconAuthority;
  } catch {
    // fall through to defaults
  }
  return {
    handle: "lex-authority.test",
    password: "hunter2",
    pds: process.env.PDS_URL ?? "http://localhost:2583",
  };
}

async function main() {
  const authority = await getAuthority();
  const sessionRes = await fetch(
    `${authority.pds}/xrpc/com.atproto.server.createSession`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        identifier: authority.handle,
        password: authority.password,
      }),
    },
  );
  if (!sessionRes.ok)
    throw new Error(
      `createSession failed: ${sessionRes.status} ${await sessionRes.text()}`,
    );
  const { accessJwt, did } = (await sessionRes.json()) as {
    accessJwt: string;
    did: string;
  };

  const docs = await loadLexiconDocs();
  for (const doc of docs) {
    const res = await fetch(
      `${authority.pds}/xrpc/com.atproto.repo.putRecord`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${accessJwt}`,
        },
        body: JSON.stringify({
          repo: did,
          collection: LEXICON_COLLECTION,
          rkey: doc.id,
          record: doc,
          validate: false,
        }),
      },
    );
    if (!res.ok)
      throw new Error(
        `putRecord ${doc.id} failed: ${res.status} ${await res.text()}`,
      );
    console.log(`published ${doc.id}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
