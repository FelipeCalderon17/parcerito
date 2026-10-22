/**
 * Runs the read-only trace queries the bot prepared (a `*traces*.sql` file it uploaded to your DM) against Lime
 * production and uploads the results to the same DM, so the bot can fill in the traces. Runs on your machine
 * (see prod-db.ts).
 *
 *   npm run traces                                   # newest *traces*.sql the bot uploaded to your DM
 *   npm run traces -- --sql ~/Downloads/megan-traces-2026-10-21.sql
 *
 * The full prompt holds the patient's name, DOB, transcript and documents, so those columns are dropped: the
 * export keeps the field's own prompt line and instructions, the cited snippets, the AI value and the final answer.
 */
import fs from "node:fs";
import { openBotDm, withProdDb, type Query } from "./prod-db.js";

const DROPPED_COLUMNS = new Set(["user_prompt", "system_prompt", "document_map", "evidence_unit_full_text"]);
const MAX_TEXT = 2000;
const CONCURRENCY = 4;

interface Statement {
  item: string;
  label: string;
  sql: string;
}

async function main() {
  const { slack, channel } = await openBotDm();
  const { name, sql } = await loadSql(slack, channel);
  const statements = parseStatements(sql);
  if (!statements.length) throw new Error(`No queries found in ${name}`);
  console.log(`Running ${statements.length} read-only queries from ${name}…`);

  const results = await withProdDb((query) => runAll(query, statements));
  const failed = results.filter((r) => r.error).length;

  const exportedAt = new Date().toISOString();
  await slack.files.uploadV2({
    channel_id: channel,
    filename: `traces-${exportedAt.slice(0, 10)}.json`,
    title: "AI field traces (prod export)",
    content: JSON.stringify({ exportedAt, source: name, results }),
    initial_comment:
      `🔎 Ran ${statements.length} trace queries from ${name}` +
      (failed ? `, ${failed} failed (their errors are in the file).` : ".") +
      " DM me `traces` to fill them in.",
  });
  console.log(`Uploaded ${results.length - failed} results${failed ? ` and ${failed} errors` : ""} to your DM with the bot.`);
}

async function loadSql(slack: Awaited<ReturnType<typeof openBotDm>>["slack"], channel: string) {
  const sqlArg = process.argv.indexOf("--sql");
  if (sqlArg > 0) {
    const file = process.argv[sqlArg + 1];
    if (!file) throw new Error("--sql needs a path");
    return { name: file.split("/").pop()!, sql: fs.readFileSync(file, "utf8") };
  }
  const files = await slack.files.list({ channel, count: 50 });
  const latest = (files.files ?? [])
    .filter((f) => f.name && /traces.*\.sql$/.test(f.name) && f.url_private_download)
    .sort((a, b) => (b.created ?? 0) - (a.created ?? 0))[0];
  if (!latest) throw new Error("No *traces*.sql in your DM with the bot. Ask it for one, or pass --sql <file>.");
  const res = await fetch(latest.url_private_download!, {
    headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` },
  });
  if (!res.ok) throw new Error(`Couldn't download ${latest.name}: ${res.status}`);
  return { name: latest.name!, sql: await res.text() };
}

/**
 * Splits the file into its SELECT statements (each ends with `;` at the end of a line), labeled with the
 * `-- Item N: …` heading above them and the comment right before them. BEGIN/ROLLBACK are left out: every query
 * already runs read-only.
 */
export function parseStatements(sql: string): Statement[] {
  const statements: Statement[] = [];
  let item = "";
  let comments: string[] = [];
  let body: string[] = [];
  for (const line of sql.split("\n")) {
    const trimmed = line.trim();
    if (!body.length && trimmed.startsWith("--")) {
      const text = trimmed.replace(/^--\s?/, "");
      if (/^Item \d+:/.test(text)) item = text;
      else if (text && !/^=+$/.test(text)) comments.push(text);
      continue;
    }
    if (!body.length && !trimmed) continue;
    body.push(line);
    if (!trimmed.endsWith(";")) continue;
    const statement = body.join("\n").trim().replace(/;$/, "");
    if (!/^(begin|rollback|commit)\b/i.test(statement)) {
      statements.push({ item, label: comments.at(-1) ?? "", sql: statement });
    }
    body = [];
    comments = [];
  }
  return statements;
}

async function runAll(query: Query, statements: Statement[]) {
  const results: { item: string; label: string; rows?: unknown[]; error?: string }[] = [];
  let next = 0;
  const worker = async () => {
    while (next < statements.length) {
      const i = next++;
      const { item, label, sql } = statements[i]!;
      try {
        const stdout = await query(`select coalesce(json_agg(q), '[]'::json) from (\n${sql}\n) q`);
        results[i] = { item, label, rows: (JSON.parse(stdout) as unknown[]).map(trimRow) };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        results[i] = { item, label, error: message.split("\n").find((l) => l.includes("ERROR")) ?? message };
      }
      console.log(`  ${i + 1}/${statements.length} ${results[i]!.error ? "✖" : "✔"} ${item} · ${label}`);
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  return results;
}

/** Drops the full-prompt and full-document columns and shortens any other long text. */
function trimRow(row: unknown): unknown {
  if (!row || typeof row !== "object") return row;
  return Object.fromEntries(
    Object.entries(row)
      .filter(([key]) => !DROPPED_COLUMNS.has(key))
      .map(([key, value]) => [key, trimValue(value)]),
  );
}

function trimValue(value: unknown): unknown {
  if (typeof value === "string" && value.length > MAX_TEXT) return `${value.slice(0, MAX_TEXT)}… [trimmed]`;
  if (Array.isArray(value)) return value.map(trimValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, trimValue(v)]));
  }
  return value;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
