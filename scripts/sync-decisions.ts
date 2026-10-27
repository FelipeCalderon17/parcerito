/**
 * After a review meeting with Megan: posts every decision saved in the Lime coder-feedback dashboard since the last
 * sync to its Linear issues, in one batch, after you confirm the list.
 *   - Approved for engineering → comment (questions + answer) and move to Todo in the current cycle, assigned to you.
 *   - Still needs clarification, implemented, verified → comment only.
 * Each decision version is posted once (DATA_DIR/review-decisions-synced.json); editing an answer posts it again.
 *
 *   npm run decisions               # show the list, ask before applying
 *   npm run decisions -- --dry-run  # show the list and the full comments, change nothing
 *   npm run decisions -- --yes      # apply without asking
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { LinearClient } from "../src/agenda/linear.js";
import { loadConfig } from "../src/config.js";
import { loadSynced, planUpdates, saveSynced } from "../src/review/decisions.js";
import { loadOpenDecisions, loadReviewDecisions, reviewConfigured } from "../src/review/publish.js";

const SNAPSHOT = path.join(os.homedir(), "Desktop", "Lime", "review-hub", "review-snapshot.json");

/** Each item's questions to resolve, from the last hub snapshot (the ones that were on screen in the meeting). */
function questionsFromSnapshot(): (id: string) => string[] {
  if (!fs.existsSync(SNAPSHOT)) return () => [];
  const items = (JSON.parse(fs.readFileSync(SNAPSHOT, "utf8")) as { items: { id: string; detail?: { questions?: string[] } }[] }).items;
  const byId = new Map(items.map((i) => [i.id, i.detail?.questions ?? []]));
  return (id) => byId.get(id) ?? [];
}

async function main() {
  const argv = process.argv.slice(2);
  const config = loadConfig();
  if (!reviewConfigured(config)) throw new Error("Set LIME_REVIEW_API_URL and LIME_REVIEW_INGEST_KEY in .env");
  if (!config.LINEAR_API_KEY) throw new Error("Set LINEAR_API_KEY in .env");

  const [approved, open] = await Promise.all([loadReviewDecisions(config), loadOpenDecisions(config)]);
  const synced = loadSynced(config.DATA_DIR);
  const { updates, withoutIssue } = planUpdates([...approved, ...open], synced, questionsFromSnapshot());

  if (!updates.length && !withoutIssue.length) {
    console.log("Nothing new: every saved decision is already on Linear.");
    return;
  }
  console.log(`${updates.length} decision(s) to post to Linear:\n`);
  for (const u of updates)
    console.log(`- ${u.issues.join(", ")} · ${u.decision.title}\n  ${u.action === "comment-and-todo" ? "comment + move to Todo (current cycle, you)" : "comment only"} · ${u.decision.status} by ${u.decision.authorName}`);
  if (withoutIssue.length)
    console.log(`\nNo Linear issue, skipped:\n${withoutIssue.map((d) => `- ${d.title}`).join("\n")}`);

  if (argv.includes("--dry-run")) {
    for (const u of updates) console.log(`\n──── ${u.issues.join(", ")} ────\n${u.comment}`);
    return;
  }
  if (!updates.length) return;
  if (!argv.includes("--yes")) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await rl.question(`\nApply these ${updates.length} update(s) to Linear? (y/N) `);
    rl.close();
    if (answer.trim().toLowerCase() !== "y") {
      console.log("Nothing applied.");
      return;
    }
  }

  const linear = new LinearClient(config.LINEAR_API_KEY, config.LINEAR_TEAM_KEY);
  let applied = 0;
  for (const u of updates) {
    try {
      for (const issue of u.issues) {
        await linear.comment(issue, u.comment);
        if (u.action === "comment-and-todo") await linear.moveToTodo(issue);
      }
      synced.add(u.key);
      saveSynced(config.DATA_DIR, synced);
      applied++;
      console.log(`✓ ${u.issues.join(", ")}`);
    } catch (error) {
      console.error(`✗ ${u.issues.join(", ")}: ${error instanceof Error ? error.message : error} (will retry next run)`);
    }
  }
  console.log(`\n${applied}/${updates.length} applied.`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
