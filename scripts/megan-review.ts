/**
 * Builds a local HTML review pack for the Megan meeting: per Linear issue, the Slack reports behind it, and for
 * every visit those reports link to, the AI's suggestions on the issue's fields with the prompt instruction, the
 * cited evidence, who decided (coder), rejections and the answer history. Read-only against production (see
 * prod-db.ts). Output holds PHI, so it stays on your machine and is never uploaded.
 *
 *   npx tsx --env-file=.env scripts/megan-review.ts            # Linear + Slack, then prod, then the HTML
 *   npx tsx --env-file=.env scripts/megan-review.ts --no-db    # Linear + Slack only (no AWS login)
 *
 * Writes ~/Desktop/Lime/megan-review/index.html (+ assets/ with the Slack screenshots). Linear/Slack and every
 * visit are cached in that folder, delete cache/ to refetch. Gathering and rendering live in src/review/.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { cachedVisits, gatherPack, linearIssue, packVisits } from "../src/review/gather.js";
import { ISSUES, meganItem } from "../src/review/megan-issues.js";
import { render } from "../src/review/render.js";
import type { Pack } from "../src/review/types.js";
import { withProdDb } from "./prod-db.js";

const OUT = path.join(os.homedir(), "Desktop", "Lime", "megan-review");
const CACHE = path.join(OUT, "cache");
const ASSETS = path.join(OUT, "assets");

async function main() {
  const noDb = process.argv.includes("--no-db");
  for (const dir of [OUT, CACHE, ASSETS]) fs.mkdirSync(dir, { recursive: true });

  const dirs = { cache: CACHE, assets: ASSETS };
  const packs: Pack[] = [];
  for (const issue of ISSUES) {
    console.log(issue.id);
    const pack = await gatherPack(meganItem(issue, await linearIssue(issue.id, CACHE)), dirs);
    console.log(`  ${pack.threads.length} Slack threads${pack.threads.some((t) => t.error) ? " (some unreadable)" : ""}`);
    packs.push(pack);
  }

  if (noDb) {
    for (const pack of packs) pack.visits = cachedVisits(pack.item, CACHE);
  } else {
    await withProdDb(async (query) => {
      for (const pack of packs) {
        pack.visits = await packVisits(query, pack, CACHE);
        console.log(`${pack.item.id}: ${pack.visits.length} visits`);
      }
    });
  }

  packs.sort((a, b) => a.item.group - b.item.group);
  fs.writeFileSync(path.join(OUT, "index.html"), render(packs));
  console.log(`\n→ ${path.join(OUT, "index.html")}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
