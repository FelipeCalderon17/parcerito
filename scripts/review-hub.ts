/**
 * Builds the local review hub: an Agenda tab with every item of the daily Nico-sync agendas and an Issues tab with
 * the prompts & forms feedback loop's Linear issues (Megan's clarification issues among them), with the Megan review's per-item pages (Slack reports, visits & AI, Linear notes). Read-only
 * against production (see prod-db.ts). Output holds PHI, so it stays on your machine and is never uploaded.
 * `npm run agenda` builds it too, right after downloading the day's agenda; this is the standalone command.
 *
 *   npm run hub                                   # every ~/Desktop/Lime/agenda/nico-sync-*.html
 *   npm run hub -- --agenda a.html --agenda b.html
 *   npm run hub -- --no-db                        # Linear + Slack only, visits from cache (no AWS login)
 *   npm run hub -- --since 2026-10-22             # Today = every agenda since the last meeting
 *   npm run hub -- --no-classify                  # skip the Claude issue classifier (placeholder classes)
 *   npm run hub -- --linear-dry-run               # print what it would post to Linear instead of posting it
 *   npm run hub -- --no-linear                    # don't touch Linear (no titles, no review comments)
 *   npm run hub -- --publish                      # also publish to the (retired) Lime dashboard
 *
 * Writes ~/Desktop/Lime/review-hub/index.html (+ assets/). Only the newest agenda's items refetch Linear, Slack and their
 * visits every run (`--since` just widens Today); everything else is cached in cache/, delete it to refetch. Decisions live in the browser, so
 * regenerating the file keeps them. The build itself lives in hub-build.ts.
 */
import { agendaFilesIn, buildHub, hubFlags } from "./hub-build.js";

async function main() {
  const argv = process.argv.slice(2);
  const given = argv.flatMap((a, i) => (a === "--agenda" && argv[i + 1] ? [argv[i + 1]!] : []));
  const since = argv.includes("--since") ? argv[argv.indexOf("--since") + 1] : undefined;
  if (since !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(since)) throw new Error("--since needs a date like 2026-10-22");
  const file = await buildHub({ agendaFiles: given.length ? given : agendaFilesIn(), noDb: argv.includes("--no-db"), since, noClassify: argv.includes("--no-classify"), ...hubFlags(argv) });
  console.log(`\n→ ${file}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
