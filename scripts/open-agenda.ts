/**
 * The morning command: downloads the newest agenda the bot DMed you into AGENDA_LOCAL_DIR, then builds the local
 * review hub from every agenda there (pulling visits from prod, see hub-build.ts) and opens the hub in your browser.
 * File names stay the same, so your ticks and notes (kept by the browser) survive re-opening.
 *
 *   npm run agenda                    # download, build the hub with the prod pull (AWS login if expired), open it
 *   npm run agenda -- --no-db         # same, but visits come from the hub's cache only (no AWS login)
 *   npm run agenda -- --agenda-only   # old behaviour: download and open the agenda file, no hub
 *   npm run agenda -- --since 2026-10-22   # no meeting since then: also fetch those days' agendas, all in Today
 *   npm run agenda -- --linear-dry-run     # print what it would post to Linear (titles, Agenda review comments)
 *   npm run agenda -- --no-open            # don't open the browser (used by the weekday schedule)
 *   npm run agenda -- --no-linear          # leave Linear alone
 *   npm run agenda -- --publish            # also publish to the (retired) Lime dashboard
 *
 * By default the newest agenda's Linear issues get the `[Agenda - date]` title and an "Agenda review — date" comment
 * with everything the hub shows (see linear-review.ts), and likely duplicates are listed (npm run duplicates).
 *
 * If the hub build fails (login cancelled, tunnel error…) the downloaded agenda is opened instead.
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WebClient } from "@slack/web-api";
import { agendaFilesIn, buildHub, hubFlags } from "./hub-build.js";

const AGENDA_FILE = /^nico-sync-\d{4}-\d{2}-\d{2}\.html$/;

/**
 * Downloads the newest agenda from your DM into `dir` (unless a newer local copy exists) and returns its path. With
 * `since` (YYYY-MM-DD), every agenda from that day on is downloaded too, so days without a meeting aren't skipped.
 */
async function downloadAgenda(dir: string, since?: string): Promise<string> {
  const token = process.env.SLACK_BOT_TOKEN;
  const recipient = process.env.AGENDA_RECIPIENT_ID ?? process.env.ALLOWED_SLACK_USER_IDS?.split(",")[0]?.trim();
  if (!token || !recipient) throw new Error("Set SLACK_BOT_TOKEN and ALLOWED_SLACK_USER_IDS in .env");

  const slack = new WebClient(token);
  const dm = await slack.conversations.open({ users: recipient });
  // Fresh uploads can appear in the DM before Slack's file-list index catches up.
  const [files, history] = await Promise.all([
    slack.files.list({ channel: dm.channel!.id!, count: 100 }),
    slack.conversations.history({ channel: dm.channel!.id!, limit: 200 }),
  ]);
  // The last upload of each day's agenda (the bot re-posts it when rebuilt).
  const byName = new Map<string, { name?: string; created?: number; url_private_download?: string }>();
  for (const f of [...(files.files ?? []), ...(history.messages ?? []).flatMap((m) => m.files ?? [])])
    if (f.name && AGENDA_FILE.test(f.name) && f.url_private_download && (f.created ?? 0) >= (byName.get(f.name)?.created ?? 0))
      byName.set(f.name, f);
  const all = [...byName.values()].sort((a, b) => a.name!.localeCompare(b.name!));
  const latest = all.at(-1);
  if (!latest) throw new Error("No agenda in your DM yet. DM the bot `agenda` to build one.");
  const wanted = since ? all.filter((f) => f.name!.slice(10, 20) >= since) : [latest];

  fs.mkdirSync(dir, { recursive: true });
  for (const agenda of wanted.length ? wanted : [latest]) {
    const file = path.join(dir, agenda.name!);
    // A local copy changed after the bot posted it (e.g. items added by hand) wins over the Slack one.
    const localIsNewer = fs.existsSync(file) && fs.statSync(file).mtimeMs / 1000 > (agenda.created ?? 0);
    if (!localIsNewer) {
      const res = await fetch(agenda.url_private_download!, { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) throw new Error(`Couldn't download ${agenda.name}: ${res.status}`);
      fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
    }
    console.log(`${localIsNewer ? "Kept local" : "Downloaded"} agenda: file://${file}`);
  }
  return path.join(dir, latest.name!);
}

/** `--since YYYY-MM-DD`: the first agenda since the last meeting. */
function sinceArg(argv: string[]): string | undefined {
  const value = argv[argv.indexOf("--since") + 1];
  if (!argv.includes("--since")) return undefined;
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error("--since needs a date like 2026-10-22");
  return value;
}

async function main() {
  const argv = process.argv.slice(2);
  const dir = process.env.AGENDA_LOCAL_DIR ?? path.join(os.homedir(), "Desktop", "Lime", "agenda");
  const since = sinceArg(argv);
  const agenda = await downloadAgenda(dir, since);
  let open = agenda;
  if (!argv.includes("--agenda-only")) {
    const noDb = argv.includes("--no-db");
    console.log(`Building review hub ${noDb ? "from cached visits (--no-db)" : "with the prod visit pull"}…`);
    try {
      open = await buildHub({ agendaFiles: agendaFilesIn(dir), noDb, since, ...hubFlags(argv) });
      console.log(`Hub ready: file://${open}`);
    } catch (error) {
      console.error(`Hub build failed: ${error instanceof Error ? error.message : error}`);
      console.error("Opening the agenda instead.");
    }
  }
  console.log(`Opening file://${open}`);
  // The scheduled run (scripts/agenda-scheduled.sh) passes --no-open: nobody is waiting at the screen.
  if (!argv.includes("--no-open")) execFile("open", [open]);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
