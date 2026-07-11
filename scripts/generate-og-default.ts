// scripts/generate-og-default.ts
/**
 * Renders the generic OG fallback card used by the web app's static
 * og:image tag. Usage: npx tsx scripts/generate-og-default.ts <output-path>
 */
import { writeFileSync } from "fs";
import { renderDefaultCard } from "../src/services/ogImage";

async function main() {
  const outPath = process.argv[2];
  if (!outPath) {
    console.error(
      "Usage: npx tsx scripts/generate-og-default.ts <output-path>",
    );
    process.exit(1);
  }
  writeFileSync(outPath, await renderDefaultCard());
  console.log(`Wrote ${outPath}`);
}

main();
