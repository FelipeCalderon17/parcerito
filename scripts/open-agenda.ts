/**
 * Downloads the newest agenda the bot DMed you into AGENDA_LOCAL_DIR and opens it in your browser.
 * The file name stays the same for a given day, so your ticks and notes (kept by the browser) survive re-opening.
 *
 *   npm run agenda
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WebClient } from "@slack/web-api";

const AGENDA_FILE = /^nico-sync-\d{4}-\d{2}-\d{2}\.html$/;

async function main() {
  const token = process.env.SLACK_BOT_TOKEN;
  const recipient = process.env.AGENDA_RECIPIENT_ID ?? process.env.ALLOWED_SLACK_USER_IDS?.split(",")[0]?.trim();
  if (!token || !recipient) throw new Error("Set SLACK_BOT_TOKEN and ALLOWED_SLACK_USER_IDS in .env");
  const dir = process.env.AGENDA_LOCAL_DIR ?? path.join(os.homedir(), "Desktop", "Lime", "agenda");

  const slack = new WebClient(token);
  const dm = await slack.conversations.open({ users: recipient });
  const files = await slack.files.list({ channel: dm.channel!.id!, count: 50 });
  const latest = (files.files ?? [])
    .filter((f) => f.name && AGENDA_FILE.test(f.name) && f.url_private_download)
    .sort((a, b) => (b.created ?? 0) - (a.created ?? 0))[0];
  if (!latest) throw new Error("No agenda in your DM yet. DM the bot `agenda` to build one.");

  const res = await fetch(latest.url_private_download!, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Couldn't download ${latest.name}: ${res.status}`);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, latest.name!);
  fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));

  console.log(`file://${file}`);
  execFile("open", [file]);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
