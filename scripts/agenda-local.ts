/**
 * Builds today's agenda once from this machine and DMs it, for when the deployed bot can't (e.g. Railway is down).
 * Uses ./data for state, so carried-over items and last sync's notes (kept on the bot's volume) aren't included.
 *
 *   npm run agenda:local
 */
import fs from "node:fs";
import path from "node:path";
import type { Triage, triageConversations } from "../src/agenda/triage.js";
import { WebClient } from "@slack/web-api";
import { loadConfig } from "../src/config.js";
import { DailyAgenda } from "../src/agenda/index.js";

const config = loadConfig();
// Prepare a read-only snapshot for manual review when the hosted triage model is unavailable.
// npm run agenda:local -- --prepare
// npm run agenda:local -- --triage data/agenda/local-triage.json
const prepare = process.argv.includes("--prepare");
const triageArg = process.argv.indexOf("--triage");
const reviewedFile = triageArg >= 0 ? process.argv[triageArg + 1] : undefined;
if (triageArg >= 0 && !reviewedFile) throw new Error("--triage requires a JSON file");
if (prepare && reviewedFile) throw new Error("Use either --prepare or --triage");
const prepared = new Error("Local triage input prepared");
const snapshot = path.join(config.DATA_DIR, "agenda", "local-input.json");
const triage = prepare || reviewedFile ? reviewLocally : undefined;

async function reviewLocally(
  _config: unknown,
  input: Parameters<typeof triageConversations>[1],
): Promise<Triage> {
  const serializeInput = () => JSON.stringify({ ...input, trackedIn: [...input.trackedIn] }, null, 2);
  if (prepare) {
    fs.writeFileSync(snapshot, serializeInput());
    console.log(`Prepared read-only triage input: ${snapshot}`);
    throw prepared;
  }
  const original = JSON.parse(fs.readFileSync(snapshot, "utf8"));
  if (
    JSON.stringify(original.conversations) !== JSON.stringify(input.conversations) ||
    original.rejected !== input.rejected
  ) {
    fs.writeFileSync(path.join(config.DATA_DIR, "agenda", "local-input-changed.json"), serializeInput());
    throw new Error("Source messages or rejected suggestions changed; prepare and review again");
  }
  const reviewed = JSON.parse(fs.readFileSync(reviewedFile!, "utf8")) as Triage;
  // Refuse stale or incomplete reviews before the builder can write to Linear.
  const ids = input.conversations.map((c) => c.id);
  const classified = [
    ...reviewed.items.flatMap((i) => i.conversationIds),
    ...reviewed.skipped.map((s) => s.conversationId),
  ];
  if (
    ids.length !== classified.length ||
    new Set(classified).size !== ids.length ||
    classified.some((id) => !ids.includes(id))
  ) {
    throw new Error("Reviewed triage must classify every current conversation exactly once; prepare again");
  }
  return reviewed;
}

const frozen = reviewedFile ? JSON.parse(fs.readFileSync(snapshot, "utf8")) : undefined;
const window = frozen ? { since: new Date(frozen.since), until: new Date(frozen.until) } : undefined;
try {
  const result = await new DailyAgenda(config, new WebClient(config.SLACK_BOT_TOKEN), triage).runNow(window);
  console.log(`Delivered ${result.file}: ${result.items} items, ${result.created.length} Linear issues filed.`);
} catch (error) {
  if (error !== prepared) throw error;
}
