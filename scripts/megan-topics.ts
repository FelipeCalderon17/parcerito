/**
 * Parses Felipe's Megan meeting spreadsheet and relates its topics to the hub's Linear issues (see
 * src/review/topics.ts). The spreadsheet holds coder quotes and PHI: its parsed copy goes next to the hub, outside the
 * repo. The next `npm run hub` shows the matches on the issue pages and the Issues overview.
 *
 *   npm run megan-topics                       # ~/Downloads/megan-meeting-2026-10-21.xlsx
 *   npm run megan-topics -- path/to/file.xlsx
 *
 * Writes ~/Desktop/Lime/review-hub/megan-topics.json and prints topic # · topic · matched issues · method. Issues come
 * from the hub cache (Linear's loop list is refetched; Slack threads and visits are read from cache).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../src/config.js";
import { parseTopics, type TopicsFile } from "../src/review/topics.js";
import { readWorkbook } from "../src/review/xlsx.js";
import { agendaFilesIn, cachedIssuePacks, matchSpreadsheet, TOPICS_FILE } from "./hub-build.js";

const DEFAULT = path.join(os.homedir(), "Downloads", "megan-meeting-2026-10-21.xlsx");
const short = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

async function main() {
  const source = process.argv.slice(2).find((a) => !a.startsWith("--")) ?? DEFAULT;
  const topics = parseTopics(readWorkbook(source));
  if (!topics.length) throw new Error(`no topics found in ${source}`);
  const file: TopicsFile = { source, parsedAt: new Date().toISOString(), topics };
  fs.mkdirSync(path.dirname(TOPICS_FILE), { recursive: true });
  fs.writeFileSync(TOPICS_FILE, JSON.stringify(file, null, 2));
  console.log(`${topics.length} topics parsed, ${topics.filter((t) => t.answer).length} with Megan's answer`);

  const packs = await cachedIssuePacks(agendaFilesIn());
  console.log(`${packs.length} hub issues`);
  const matched = await matchSpreadsheet(packs, loadConfig());

  for (const t of matched) {
    const list = t.matches.map((m) => `${m.issue} (${m.method}${m.confidence ? `, ${m.confidence}` : ""})`).join(", ");
    console.log(`#${String(t.n).padStart(2)} · ${short(t.topic, 50).padEnd(50)} · ${list || "—"}`);
  }
  const none = matched.filter((t) => !t.matches.length);
  console.log(`\n${matched.length - none.length}/${matched.length} matched; unmatched: ${none.map((t) => `#${t.n}`).join(", ") || "none"}`);
  console.log(`→ ${TOPICS_FILE}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
