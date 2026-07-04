import { promises as fs } from "node:fs";
import path from "node:path";

export interface LexiconDoc extends Record<string, unknown> {
  id: string;
  lexicon: number;
}

/** Load every lexicon JSON (files with a string `id`) under a directory. */
export async function loadLexiconDocs(
  dir: string = path.join(__dirname, "../../lexicons"),
): Promise<LexiconDoc[]> {
  const entries = await fs.readdir(dir);
  const docs: LexiconDoc[] = [];
  for (const entry of entries.filter((e) => e.endsWith(".json")).sort()) {
    const raw = await fs.readFile(path.join(dir, entry), "utf8");
    const doc = JSON.parse(raw);
    if (typeof doc.id === "string") docs.push(doc);
  }
  return docs;
}
