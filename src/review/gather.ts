/**
 * Gathers a review pack: the Linear issue, the Slack threads it links (screenshots saved to an assets folder) and,
 * for every visit those reports point at, the read-only prod data. Everything is cached as JSON in a cache folder;
 * delete it to refetch, or pass `fresh` to refetch (and re-cache) one item's data.
 */
import fs from "node:fs";
import path from "node:path";
import { WebClient } from "@slack/web-api";
import { json, visitQueries } from "./queries.js";
import type { Item, LinearIssue, Pack, Query, SlackMessage, SlackRef, SlackThread, VisitData } from "./types.js";

/** Where a pack's JSON cache and downloaded Slack images live. Images are linked as `assets/<name>` from the HTML. */
export interface Dirs {
  cache: string;
  assets: string;
}

const cacheFile = (cacheDir: string, key: string) => path.join(cacheDir, `${key.replace(/[^\w.-]/g, "_")}.json`);

/** Cache files already (re)written by this process, so a thread or issue shared by many items is fetched once a run. */
const written = new Set<string>();

/** A long-running worker must allow fresh reads again on the next build, while deduplicating within this build. */
export function beginGatherRun(cacheDir: string): void {
  const prefix = `${path.resolve(cacheDir)}${path.sep}`;
  for (const file of written) if (path.resolve(file).startsWith(prefix)) written.delete(file);
}

/**
 * Returns `cache/<key>.json` when present, else runs `load` and stores its result there. `fresh` reloads it once
 * per run even when cached.
 */
export async function cached<T>(cacheDir: string, key: string, load: () => Promise<T>, fresh = false): Promise<T> {
  const file = cacheFile(cacheDir, key);
  if ((!fresh || written.has(file)) && fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  let value: T;
  try {
    value = await load();
  } catch (error) {
    // A failed refresh keeps the last good copy rather than losing the item.
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf8")) as T;
    throw error;
  }
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
  written.add(file);
  return value;
}

// ---------- Linear ----------

/** One Linear issue with its description and comments. */
export async function linearIssue(id: string, cacheDir: string, fresh = false): Promise<LinearIssue> {
  return cached(cacheDir, `linear-${id}`, async () => {
    const res = await fetch("https://api.linear.app/graphql", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: process.env.LINEAR_API_KEY! },
      body: JSON.stringify({
        query: `query($id: String!) { issue(id: $id) { identifier title url description state { name } assignee { name }
          comments(first: 100) { nodes { body createdAt user { name } } } } }`,
        variables: { id },
      }),
    });
    const json = (await res.json()) as { data?: { issue: LinearIssue }; errors?: unknown };
    if (!json.data?.issue) throw new Error(`Linear ${id}: ${JSON.stringify(json.errors)}`);
    return json.data.issue;
  }, fresh);
}

/** Stores an issue fetched elsewhere (the feedback-loop list) as its `linearIssue` cache, so this run won't refetch it. */
export function primeLinear(cacheDir: string, issue: LinearIssue): void {
  const file = cacheFile(cacheDir, `linear-${issue.identifier}`);
  fs.writeFileSync(file, JSON.stringify(issue, null, 2));
  written.add(file);
}

// ---------- Slack ----------

/** Every Slack thread a text links to, in its various shapes (client thread URLs, archive permalinks, checkpoints). */
export function slackRefs(text: string): SlackRef[] {
  const refs: SlackRef[] = [];
  for (const m of text.matchAll(/\/thread\/(C[A-Z0-9]+)-(\d{10}\.\d{6})/g)) refs.push({ channel: m[1], ts: m[2] });
  for (const m of text.matchAll(/\/archives\/(C[A-Z0-9]+)\/p(\d{10})(\d{6})(?:\?thread_ts=(\d{10}\.\d{6}))?/g))
    refs.push({ channel: m[1], ts: m[4] ?? `${m[2]}.${m[3]}` });
  for (const m of text.matchAll(/channel (C[A-Z0-9]+); root\/message (\d{10}\.\d{6})/g)) refs.push({ channel: m[1], ts: m[2] });
  const seen = new Set<string>();
  return refs.filter((r) => !seen.has(`${r.channel}/${r.ts}`) && seen.add(`${r.channel}/${r.ts}`));
}

let client: WebClient | undefined;
const slack = () => (client ??= new WebClient(process.env.SLACK_BOT_TOKEN));
const userNames = new Map<string, string>();

async function userName(id: string | undefined): Promise<string> {
  if (!id) return "unknown";
  if (!userNames.has(id)) {
    try {
      const u = await slack().users.info({ user: id });
      userNames.set(id, u.user?.real_name || u.user?.name || id);
    } catch {
      userNames.set(id, id);
    }
  }
  return userNames.get(id)!;
}

/** The whole thread `ref` belongs to (a reply resolves to its root), downloading image attachments to `dirs.assets`. */
export async function slackThread(ref: SlackRef, dirs: Dirs, fresh = false): Promise<SlackThread> {
  const key = `slack-${ref.channel}-${ref.ts}`;
  return cached(dirs.cache, key, async () => {
    const link = `https://app.slack.com/client/T0875BLS0H4/${ref.channel}/thread/${ref.channel}-${ref.ts}`;
    try {
      // A reply's ts only returns the reply: resolve its thread root first (a refetch reuses the cached root, as
      // replies is rate-limited).
      const root = cachedRoot(cacheFile(dirs.cache, key)) ?? (await threadRoot(ref));
      const res = await slack().conversations.replies({ channel: ref.channel, ts: root, limit: 200 });
      const messages: SlackMessage[] = [];
      for (const m of res.messages ?? []) {
        const images: string[] = [];
        const files: string[] = [];
        for (const f of m.files ?? []) {
          if (f.mimetype?.startsWith("image/") && f.url_private_download) {
            const name = `${ref.channel}-${m.ts}-${f.id}.${f.filetype ?? "png"}`;
            const dest = path.join(dirs.assets, name);
            if (!fs.existsSync(dest)) {
              const img = await fetch(f.url_private_download, { headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` } });
              if (img.ok) fs.writeFileSync(dest, Buffer.from(await img.arrayBuffer()));
            }
            images.push(`assets/${name}`);
          } else if (f.name) files.push(f.name);
        }
        const unfurls = (m.attachments ?? []).map((a) => [a.title, a.text, a.from_url].filter(Boolean).join(" ")).join("\n");
        messages.push({
          // Webhook/legacy bot messages carry `username`, which the SDK's message type leaves out.
          author: m.user ? await userName(m.user) : ((m as { username?: string }).username ?? m.bot_profile?.name ?? "bot"),
          ts: m.ts!,
          text: [m.text ?? "", unfurls].filter(Boolean).join("\n"),
          permalink: `https://lime-ai.slack.com/archives/${ref.channel}/p${m.ts!.replace(".", "")}`,
          images,
          files,
        });
      }
      return { ref, link, messages };
    } catch (error) {
      // Rate limits or a hiccup on a refresh shouldn't replace a thread we already read.
      const old = fs.existsSync(cacheFile(dirs.cache, key))
        ? (JSON.parse(fs.readFileSync(cacheFile(dirs.cache, key), "utf8")) as SlackThread)
        : undefined;
      if (old && !old.error) return old;
      return { ref, link, messages: [], error: String((error as { data?: { error?: string } }).data?.error ?? error) };
    }
  }, fresh);
}

async function threadRoot(ref: SlackRef): Promise<string> {
  const first = await slack().conversations.replies({ channel: ref.channel, ts: ref.ts, limit: 1 });
  return first.messages?.[0]?.thread_ts ?? ref.ts;
}

/** The root ts of a thread cached earlier (its first message), if any. */
function cachedRoot(file: string): string | undefined {
  if (!fs.existsSync(file)) return undefined;
  return (JSON.parse(fs.readFileSync(file, "utf8")) as SlackThread).messages[0]?.ts;
}

// ---------- Visits ----------

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

/** Visit ids from app links, plus task ids the investigation comments name explicitly. */
export function visitRefs(text: string): { visits: string[]; tasks: string[] } {
  const visits = [...text.matchAll(new RegExp(`visitId=(${UUID})`, "g"))].map((m) => m[1]);
  const tasks = [...text.matchAll(new RegExp(`task(?:_id|Id| id)?[ :=\`]+(${UUID})`, "gi"))].map((m) => m[1]);
  return { visits: [...new Set(visits)], tasks: [...new Set(tasks)] };
}

/** Case links without a visit: the case's latest task the AI worked on before the Slack message was posted. */
export function caseRefs(threads: SlackThread[]): { caseId: string; ts: string }[] {
  return threads.flatMap((t) =>
    t.messages.flatMap((m) =>
      /visitId=/.test(m.text) ? [] : [...m.text.matchAll(new RegExp(`/cases/(${UUID})`, "g"))].map((c) => ({ caseId: c[1], ts: m.ts })),
    ),
  );
}

/** Resolves visit ids, explicit task ids and case links (see caseRefs) to distinct task ids. */
export async function tasksOf(
  query: Query,
  visits: string[],
  tasks: string[],
  cases: { caseId: string; ts: string }[],
): Promise<string[]> {
  const found = [...tasks];
  if (visits.length) {
    const rows = JSON.parse(
      (await query(json(`select task_id from visit where id in (${visits.map((v) => `'${v}'`).join(",")})`))).trim() || "[]",
    ) as { task_id: string }[];
    found.push(...rows.map((r) => r.task_id));
  }
  for (const { caseId, ts } of cases) {
    const rows = JSON.parse(
      (await query(json(`select t.id from task t where t.case_id = '${caseId}'
        and exists (select 1 from ai_recommendation r where r.task_id = t.id and r.created_at <= to_timestamp(${ts}))
        order by (select max(r.created_at) from ai_recommendation r where r.task_id = t.id) desc limit 1`))).trim() || "[]",
    ) as { id: string }[];
    found.push(...rows.map((r) => r.id));
  }
  return [...new Set(found)];
}

/** Runs every visit query for one task and item; a failing query is kept as `{ error }` instead of aborting. */
export async function fetchVisit(
  query: Query,
  task: string,
  issue: Pick<Item, "id" | "fields">,
  cacheDir: string,
  fresh = false,
): Promise<VisitData> {
  return cached(cacheDir, `db-${issue.id}-${task}`, async () => {
    const queries = visitQueries(task,issue.fields);
    // One connection round trip per visit; fall back to individual sections so a bad query remains visible.
    const bundle = `select json_build_object(${Object.entries(queries).map(([name,sql]) => `'${name}', (${sql})`).join(",")})`;
    try {
      const data = JSON.parse((await query(bundle)).trim() || "{}");
      if (!data || Array.isArray(data) || typeof data !== "object" || !("task" in data)) throw new Error("Invalid bundled trace response");
      return { task, data };
    } catch {
      // Isolate the failed section instead of dropping the rest of the trace.
    }
    const data: Record<string, unknown> = {};
    for (const [name, sql] of Object.entries(queries)) {
      process.stdout.write(`    ${name}… `);
      try {
        data[name] = JSON.parse((await query(sql)).trim() || "[]");
        console.log("ok");
      } catch (error) {
        data[name] = { error: String((error as Error).message ?? error).slice(-600) };
        console.log("FAILED");
      }
    }
    return { task, data };
  }, fresh);
}

// ---------- Whole pack ----------

/**
 * An item's Linear issues and Slack threads (its own refs plus any linked from Linear). Failures are kept on the
 * pack (Linear) or the thread (Slack) so one bad link doesn't abort the build. Visits are added by the caller.
 * `fresh` refetches instead of reading the cache (new comments/replies since the last run).
 */
export async function gatherPack(item: Item, dirs: Dirs, fresh = false): Promise<Pack> {
  const pack: Pack = { item, linear: [], errors: [], threads: [], visits: [] };
  for (const id of item.linear) {
    try {
      pack.linear.push(await linearIssue(id, dirs.cache, fresh));
    } catch (error) {
      pack.errors.push(`Couldn't load ${id} from Linear: ${String((error as Error).message ?? error).slice(0, 300)}`);
    }
  }
  const seen = new Set<string>();
  for (const ref of packSlackRefs(item,pack.linear)) {
    if (seen.has(`${ref.channel}/${ref.ts}`)) continue;
    seen.add(`${ref.channel}/${ref.ts}`);
    pack.threads.push(await slackThread(ref, dirs, fresh));
  }
  return pack;
}

/** Agenda sources are explicit; parent ticket notes must not import other reports' patient charts. */
export function packSlackRefs(item:Item,linear:LinearIssue[]):SlackRef[] {
  const related = item.origin.kind === "agenda" ? [] : slackRefs(linear.flatMap(issue => [issue.description,...issue.comments.nodes.map(comment => comment.body)]).join("\n"));
  return [...new Map([...item.slack,...related].map(ref => [`${ref.channel}/${ref.ts}`,ref])).values()];
}

/** Everything in a pack that can name a visit, task or case. */
export function packText(pack: Pack): string {
  return [
    pack.item.text,
    ...(pack.item.origin.kind === "agenda" ? [] : pack.linear.flatMap((l) => [l.description, ...l.comments.nodes.map((c) => c.body)])),
    ...pack.threads.flatMap((t) => t.messages.map((m) => m.text)),
  ].join("\n");
}

/** The visits of a pack from prod, by every visit/task/case link in its text (see visitRefs, caseRefs). */
export async function packVisits(query: Query, pack: Pack, cacheDir: string, fresh = false, parallel = false): Promise<VisitData[]> {
  const { visits, tasks } = visitRefs(packText(pack));
  const taskIds = await tasksOf(query, visits, tasks, caseRefs(pack.threads));
  const out: VisitData[] = [];
  if (parallel) out.push(...await Promise.all(taskIds.map(task => fetchVisit(query,task,pack.item,cacheDir,fresh))));
  else for (const task of taskIds) out.push(await fetchVisit(query, task, pack.item, cacheDir, fresh));
  fs.writeFileSync(path.join(cacheDir,`visit-tasks-${pack.item.id}.json`),JSON.stringify(taskIds));
  return out;
}

/** The visits already cached for a pack (`--no-db`). */
export function cachedVisits(item: Pick<Item, "id">, cacheDir: string): VisitData[] {
  const manifest = path.join(cacheDir,`visit-tasks-${item.id}.json`);
  const tasks = fs.existsSync(manifest) ? new Set<string>(JSON.parse(fs.readFileSync(manifest,"utf8"))) : null;
  return fs
    .readdirSync(cacheDir)
    .filter((f) => f.startsWith(`db-${item.id}-`) && (!tasks || tasks.has(f.slice(`db-${item.id}-`.length,-5))))
    .map((f) => JSON.parse(fs.readFileSync(path.join(cacheDir, f), "utf8")) as VisitData);
}
