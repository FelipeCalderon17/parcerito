/**
 * Lists the high-confidence duplicate pairs the last `npm run agenda` / `npm run hub` found (review-hub/duplicates.json)
 * and, only with `--apply` and a y/N confirm, marks the newer issue of each pair Duplicate of the older one (relation,
 * Duplicate state, comment). `--all` lists medium/low pairs too (they are never applied). LINEAR_DRY_RUN=1 or
 * `--dry-run` prints the mutations instead of sending them.
 *
 *   npm run duplicates                 # list high-confidence pairs
 *   npm run duplicates -- --all        # list every pair
 *   npm run duplicates -- --apply      # confirm, then mark them in Linear
 */
import fs from "node:fs";
import { createInterface } from "node:readline/promises";
import { LinearClient } from "../src/agenda/linear.js";
import { loadConfig } from "../src/config.js";
import { newerOf } from "../src/review/duplicates.js";
import { DUPLICATES_FILE, type DuplicatesFile } from "./hub-build.js";

async function main() {
  const argv = process.argv.slice(2);
  if (!fs.existsSync(DUPLICATES_FILE)) throw new Error("No duplicates yet: run `npm run agenda` (or `npm run hub`) first.");
  const saved = JSON.parse(fs.readFileSync(DUPLICATES_FILE, "utf8")) as DuplicatesFile;
  const created = new Map(Object.entries(saved.issues).map(([id, i]) => [id, i.createdAt]));
  const listed = argv.includes("--all") ? saved.pairs : saved.pairs.filter((p) => p.confidence === "high");
  const title = (id: string) => saved.issues[id]?.title ?? "";
  console.log(`Duplicates from the ${saved.agenda} agenda run (${saved.generatedAt.slice(0, 16).replace("T", " ")}):`);
  if (!listed.length) return console.log("  none with high confidence.");
  const plan = listed.map((p) => ({ pair: p, ...newerOf(p, created) }));
  for (const { pair, newer, older } of plan)
    console.log(`  ${newer} → duplicate of ${older} (${pair.confidence}: ${pair.why})\n    ${newer}: ${title(newer)}\n    ${older}: ${title(older)}`);

  if (!argv.includes("--apply")) return console.log("\nList only. Re-run with --apply to mark the high-confidence ones.");
  const toApply = plan.filter((p) => p.pair.confidence === "high");
  if (!toApply.length) return console.log("\nNothing high-confidence to apply.");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(`\nMark these ${toApply.length} issue(s) Duplicate in Linear? (y/N) `);
  rl.close();
  if (answer.trim().toLowerCase() !== "y") return console.log("Nothing applied.");

  const config = loadConfig();
  if (!config.LINEAR_API_KEY) throw new Error("Set LINEAR_API_KEY in .env");
  const linear = new LinearClient(config.LINEAR_API_KEY, config.LINEAR_TEAM_KEY, { dryRun: argv.includes("--dry-run") });
  for (const { pair, newer, older } of toApply) {
    try {
      await linear.markDuplicate(newer, older, `Marked as a duplicate of ${older} by parcerito (confirmed by Felipe): ${pair.why}`);
      console.log(`✓ ${newer} → duplicate of ${older}${linear.dryRun ? " (dry run)" : ""}`);
    } catch (error) {
      console.error(`✗ ${newer}: ${error instanceof Error ? error.message : error}`);
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
