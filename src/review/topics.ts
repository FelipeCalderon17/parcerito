/**
 * Felipe's Megan meeting spreadsheet (10-21): its topics, and how each relates to the hub's Linear issues. A topic
 * matches an issue by an explicit Linear id, the same Slack thread, the same visit/task/case, or (for topics none of
 * those match) one cached Claude call. Matches show on the issue pages, a filled-in "Megan's answer" goes to the
 * classifier as reference, and the Issues overview lists every topic's coverage. The spreadsheet holds coder quotes
 * and PHI: it's read from disk and its parsed copy stays in ~/Desktop/Lime/review-hub, never in the repo.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { Config } from "../config.js";
import { AGENCIES, words, type AgencyReference } from "./agency.js";
import { slackRefs } from "./gather.js";
import { fieldKeys } from "./items.js";
import type { Pack, SlackRef, SlackThread } from "./types.js";
import type { Cell, Sheet } from "./xlsx.js";

export type MatchMethod = "linear-ref" | "slack-thread" | "visit" | "model";

export interface TopicMatch {
  issue: string;
  method: MatchMethod;
  /** Model matches only. */
  why?: string;
  confidence?: "high" | "medium";
}

export interface MeganTopic {
  n: number;
  priority: string;
  topic: string;
  fields: string;
  org: string;
  questions: string;
  answer: string;
  nextStep: string;
  /** Every column of the topic's row, by header. */
  columns: Record<string, string>;
  /** Hyperlink URLs per column (only columns that have any). */
  links: Record<string, string[]>;
  /** Links the other sheets (Links, Slack sources, Screenshots…) list under this topic's #. */
  extraLinks: string[];
  /** Every ENG id the topic names, in the hub or not. */
  linearRefs: string[];
  matches: TopicMatch[];
}

/** The parsed spreadsheet as written to megan-topics.json. */
export interface TopicsFile {
  source: string;
  parsedAt: string;
  topics: MeganTopic[];
}

export const TOPICS_SHEET = "Megan meeting";
const COL = {
  priority: "Priority",
  topic: "Topic",
  fields: "Fields",
  org: "Org · EHR",
  questions: "Questions for Megan",
  answer: "Megan's answer",
  nextStep: "Next step after her answer",
  open: "Open in Lime",
} as const;
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

const cellAt = (row: Cell[], i: number): Cell => row[i] ?? { text: "", links: [] };
const topicNo = (text: string) => (/^\s*\d+\s*$/.test(text) ? Number(text) : NaN);

/** The links every other sheet with a "#" first column lists per topic number. */
function linksByTopic(sheets: Sheet[]): Map<number, string[]> {
  const out = new Map<number, string[]>();
  for (const s of sheets) {
    if (s.name === TOPICS_SHEET || cellAt(s.rows[0] ?? [], 0).text.trim() !== "#") continue;
    for (const row of s.rows.slice(1)) {
      const n = topicNo(cellAt(row, 0).text);
      if (Number.isNaN(n)) continue;
      const urls = row.flatMap((c) => [...c.links, ...(c.text.match(/https?:\/\/\S+/g) ?? [])]);
      out.set(n, [...new Set([...(out.get(n) ?? []), ...urls])]);
    }
  }
  return out;
}

/** The topics of a workbook: one per numbered row of the "Megan meeting" sheet (or the first sheet). */
export function parseTopics(sheets: Sheet[]): MeganTopic[] {
  const main = sheets.find((s) => s.name === TOPICS_SHEET) ?? sheets[0];
  if (!main) return [];
  const headers = (main.rows[0] ?? []).map((c) => c.text.trim());
  const extra = linksByTopic(sheets);
  return main.rows.slice(1).flatMap((row) => {
    const n = topicNo(cellAt(row, 0).text);
    if (Number.isNaN(n)) return [];
    const columns: Record<string, string> = {};
    const links: Record<string, string[]> = {};
    headers.forEach((h, i) => {
      if (!h) return;
      const c = cellAt(row, i);
      columns[h] = c.text.trim();
      if (c.links.length) links[h] = c.links;
    });
    const col = (h: string) => columns[h] ?? "";
    const topic: MeganTopic = {
      n,
      priority: col(COL.priority),
      topic: col(COL.topic),
      fields: col(COL.fields),
      org: col(COL.org),
      questions: col(COL.questions),
      answer: col(COL.answer),
      nextStep: col(COL.nextStep),
      columns,
      links,
      extraLinks: extra.get(n) ?? [],
      linearRefs: [],
      matches: [],
    };
    topic.linearRefs = linearIds(topicText(topic));
    return [topic];
  });
}

/** All of a topic's text and links, one string. */
export function topicText(t: Pick<MeganTopic, "columns" | "links" | "extraLinks">): string {
  return [...Object.values(t.columns), ...Object.values(t.links).flat(), ...t.extraLinks].join("\n");
}

/** ENG-1234 ids named in a text (Linear URLs included), each once. */
export function linearIds(text: string): string[] {
  return [...new Set([...text.matchAll(/\bENG-\d+\b/g)].map((m) => m[0]))];
}

/** Case, visit and task ids of Lime app links (and "task id …" mentions); org ids stay out. */
export function limeIds(text: string): string[] {
  const re = new RegExp(`(?:/cases/|visitId=|taskId=|task[ _]id[ :=\`]+)(${UUID})`, "gi");
  return [...new Set([...text.matchAll(re)].map((m) => m[1]!.toLowerCase()))];
}

/** A topic's Lime ids: its "Open in Lime" cell and every app link on it or its other sheets. */
export function topicLimeIds(t: MeganTopic): string[] {
  const appLinks = [...Object.values(t.links).flat(), ...t.extraLinks].filter((u) => /getlimeai\.com/.test(u));
  return limeIds([t.columns[COL.open] ?? "", ...appLinks].join("\n"));
}

const key = (r: SlackRef) => `${r.channel}/${r.ts}`;

/** Reply ts → thread root ts, `channel/ts` keys, from the threads given (a thread's first message is its root). */
export function slackRoots(threads: SlackThread[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const t of threads) {
    const root = t.messages[0]?.ts ?? t.ref.ts;
    const rootKey = `${t.ref.channel}/${root}`;
    out.set(key(t.ref), rootKey);
    for (const m of t.messages) out.set(`${t.ref.channel}/${m.ts}`, rootKey);
  }
  return out;
}

/** Every Slack thread cached in the hub cache (slack-*.json), for `slackRoots`. */
export function cachedThreads(cacheDir: string): SlackThread[] {
  if (!fs.existsSync(cacheDir)) return [];
  return fs
    .readdirSync(cacheDir)
    .filter((f) => /^slack-.*\.json$/.test(f))
    .flatMap((f) => {
      try {
        return [JSON.parse(fs.readFileSync(path.join(cacheDir, f), "utf8")) as SlackThread];
      } catch {
        return [];
      }
    });
}

/**
 * What the reference matchers compare per issue: the Slack messages it names (its Linear text and gathered threads,
 * not links quoted inside Slack), their thread roots, and the Lime ids its Linear text names.
 */
interface IssueRefs {
  id: string;
  messages: Set<string>;
  slack: Set<string>;
  lime: Set<string>;
}

/** A thread shared by more issues than this (a busy channel thread many reports came from) only matches by the same reply. */
export const MAX_THREAD_ISSUES = 3;

function issueRefs(pack: Pack, roots: Map<string, string>): IssueRefs {
  const named = [...pack.item.slack, ...pack.threads.map((t) => t.ref)].map(key);
  // The issue's own text only: a busy thread's messages (and the visits they resolve to) name other reports' charts too.
  const own = [pack.item.text, ...pack.linear.flatMap((l) => [l.description ?? "", ...l.comments.nodes.map((c) => c.body)])].join("\n");
  return {
    id: pack.item.id,
    messages: new Set(named),
    slack: new Set(named.map((k) => roots.get(k) ?? k)),
    lime: new Set([...own.matchAll(new RegExp(UUID, "gi"))].map((m) => m[0].toLowerCase())),
  };
}

/**
 * The reference matches of one topic, strongest first and one per issue: Linear ids it names (linear-ref), Slack
 * threads it shares (slack-thread: the same reply, or the same thread via `roots` when at most MAX_THREAD_ISSUES
 * issues share it), Lime case/visit/task ids it shares (visit).
 */
export function refMatches(topic: MeganTopic, issues: IssueRefs[], roots: Map<string, string>): TopicMatch[] {
  const out = new Map<string, TopicMatch>();
  const add = (issue: string, method: MatchMethod) => (out.has(issue) ? undefined : out.set(issue, { issue, method }));
  const ids = new Set(issues.map((i) => i.id));
  for (const id of topic.linearRefs) if (ids.has(id)) add(id, "linear-ref");
  const quiet = (root: string) => issues.filter((i) => i.slack.has(root)).length <= MAX_THREAD_ISSUES;
  for (const k of slackRefs(topicText(topic)).map(key)) {
    const root = roots.get(k) ?? k;
    // A reply named by both is specific; a busy thread's root (or any of its other replies) is not.
    const ok = quiet(root);
    for (const i of issues) if ((k !== root && i.messages.has(k)) || (ok && i.slack.has(root))) add(i.id, "slack-thread");
  }
  const lime = topicLimeIds(topic);
  for (const i of issues) if (lime.some((u) => i.lime.has(u))) add(i.id, "visit");
  return [...out.values()];
}

// ---------- model step ----------

export interface ModelMatch {
  topic: number;
  issue: string;
  confidence: "high" | "medium" | "low";
  why: string;
}

/** Turns the matching prompt into matches; injectable so tests don't call the model. */
export type MatchModel = (prompt: string) => Promise<ModelMatch[]>;

const clip = (text: unknown, max: number) => {
  const s = String(text ?? "").replace(/\s+/g, " ").trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
};
const rows = (v: unknown) => (Array.isArray(v) ? v : []) as Record<string, any>[];
const PER_TOPIC = 12;
const MAX_CANDIDATES = 60;
const TIMEOUT_MS = 3 * 60_000;

/** An issue as the model sees it: id, title, one-line description, agencies and field codes. */
export interface Candidate {
  id: string;
  title: string;
  line: string;
  orgs: string[];
  codes: string[];
  words: Set<string>;
}

function candidate(pack: Pack): Candidate {
  const l = pack.linear[0];
  const focus = `${pack.item.title}\n${l?.description ?? ""}`;
  const keys = fieldKeys(focus);
  const visitOrgs = pack.visits.map((v) => String(rows(v.data.task)[0]?.organization ?? "")).join("\n");
  return {
    id: pack.item.id,
    title: pack.item.title,
    line: clip((l?.description ?? "").replace(/[#*>`_]/g, " "), 160),
    orgs: AGENCIES.filter((a) => a.pattern.test(`${focus}\n${visitOrgs}`)).map((a) => a.name),
    codes: [...keys.oasis, ...keys.lime].slice(0, 8),
    words: words(pack.item.title),
  };
}

/** How well an issue fits a topic, for the shortlist: 3 per shared field code, 2 per shared agency, 1 per shared title word. */
export function candidateScore(topic: MeganTopic, c: Pick<Candidate, "orgs" | "codes" | "words">): number {
  const keys = fieldKeys(`${topic.fields}\n${topic.topic}`);
  const codes = [...keys.oasis, ...keys.lime];
  const shared = codes.filter((k) => c.codes.some((x) => x.startsWith(k) || k.startsWith(x))).length;
  const orgs = AGENCIES.filter((a) => a.pattern.test(topic.org)).filter((a) => c.orgs.includes(a.name)).length;
  const own = words(`${topic.topic} ${topic.fields}`);
  const common = [...c.words].filter((w) => own.has(w)).length;
  return shared * 3 + orgs * 2 + common;
}

/** The model prompt: the unmatched topics (short) and their shortlisted issues. */
export function matchPrompt(topics: MeganTopic[], candidates: Candidate[]): string {
  const t = topics.map((x) => `#${x.n}: ${clip(x.topic, 160)} | fields: ${clip(x.fields, 120)} | org: ${clip(x.org, 60)} | questions: ${clip(x.questions, 300)}`);
  const c = candidates.map((x) => `${x.id}: ${clip(x.title, 140)} | ${x.line || "-"} | org: ${x.orgs.join(", ") || "-"} | codes: ${x.codes.join(", ") || "-"}`);
  return `
You relate topics of a clinical review meeting (home-health OASIS-E2 and agency forms filled by Lime's AI) to existing
Linear issues. An issue matches a topic when it is about the same problem (same field and agency, or the same
behaviour). A topic can match several issues, or none. Only use the ids listed. For each match give confidence
(high = clearly the same problem, medium = same field/behaviour but scope differs, low = only loosely related) and a
one-line why. Leave out topics with no match.

TOPICS
${t.join("\n")}

ISSUES
${c.join("\n")}
`.trim();
}

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["matches"],
  properties: {
    matches: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["topic", "issue", "confidence", "why"],
        properties: {
          topic: { type: "integer" },
          issue: { type: "string" },
          confidence: { type: "string", enum: ["high", "medium", "low"] },
          why: { type: "string" },
        },
      },
    },
  },
} as const;

/** The real model: Agent SDK, low effort, no tools, structured output (as classify.ts). */
function claudeMatch(config: Pick<Config, "CLAUDE_MODEL">): MatchModel {
  return async (prompt) => {
    const abortController = new AbortController();
    const timer = setTimeout(() => abortController.abort(), TIMEOUT_MS);
    try {
      for await (const message of query({
        prompt,
        options: {
          model: config.CLAUDE_MODEL,
          effort: "low",
          tools: [],
          permissionMode: "dontAsk",
          settingSources: [],
          outputFormat: { type: "json_schema", schema: SCHEMA },
          abortController,
        },
      })) {
        if (message.type !== "result") continue;
        if (message.subtype !== "success" || !message.structured_output) throw new Error(`stopped early (${message.subtype})`);
        return (message.structured_output as { matches: ModelMatch[] }).matches;
      }
      throw new Error("no result");
    } finally {
      clearTimeout(timer);
    }
  };
}

/**
 * The model matches of the topics no reference matched: each topic's 12 best-scoring issues (see candidateScore),
 * 60 at most, in one call cached at `<cacheDir>/megan-topics-match.json` by prompt hash. Medium/high only, ids
 * checked against the shortlist.
 */
async function modelMatches(
  topics: MeganTopic[],
  packs: Pack[],
  opts: { cacheDir: string; generate: () => MatchModel },
): Promise<Map<number, TopicMatch[]>> {
  const out = new Map<number, TopicMatch[]>();
  if (!topics.length) return out;
  const all = packs.map(candidate);
  const picked = new Map<string, Candidate>();
  for (const t of topics)
    all
      .map((c) => ({ c, s: candidateScore(t, c) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, PER_TOPIC)
      .forEach((x) => picked.size < MAX_CANDIDATES && picked.set(x.c.id, x.c));
  if (!picked.size) return out;
  const prompt = matchPrompt(topics, [...picked.values()]);
  const hash = createHash("sha256").update(prompt).digest("hex");
  const file = path.join(opts.cacheDir, "megan-topics-match.json");
  const hit = fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, "utf8")) as { hash: string; matches: ModelMatch[] }) : null;
  let matches: ModelMatch[];
  if (hit?.hash === hash) matches = hit.matches;
  else {
    matches = await opts.generate()(prompt);
    fs.mkdirSync(opts.cacheDir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ hash, matches }, null, 2));
  }
  const wanted = new Set(topics.map((t) => t.n));
  for (const m of matches) {
    if (m.confidence === "low" || !wanted.has(m.topic) || !picked.has(m.issue)) continue;
    const list = out.get(m.topic) ?? [];
    if (!list.some((x) => x.issue === m.issue)) list.push({ issue: m.issue, method: "model", why: m.why, confidence: m.confidence });
    out.set(m.topic, list);
  }
  return out;
}

/**
 * Sets every topic's `matches` against the hub's issue packs (origin.kind === "issue"): reference matches first,
 * then one model call for the topics still unmatched. Slack replies resolve through the packs' threads and any
 * thread cached in `cacheDir`.
 */
export async function matchTopics(
  topics: MeganTopic[],
  packs: Pack[],
  opts: { cacheDir: string; config: Pick<Config, "CLAUDE_MODEL">; generate?: MatchModel },
): Promise<MeganTopic[]> {
  const issues = packs.filter((p) => p.item.origin.kind === "issue");
  const roots = slackRoots([...cachedThreads(opts.cacheDir), ...issues.flatMap((p) => p.threads)]);
  const refs = issues.map((p) => issueRefs(p, roots));
  for (const t of topics) t.matches = refMatches(t, refs, roots);
  const generate = () => opts.generate ?? claudeMatch(opts.config);
  const model = await modelMatches(
    topics.filter((t) => !t.matches.length),
    issues,
    { cacheDir: opts.cacheDir, generate },
  );
  for (const t of topics) t.matches.push(...(model.get(t.n) ?? []));
  return topics;
}

// ---------- hub ----------

/** The topics matched to one issue. */
export const topicsOf = (topics: MeganTopic[], issue: string) => topics.filter((t) => t.matches.some((m) => m.issue === issue));

/** The questions of the spreadsheet topics an issue matches, one per line (bullets and numbering stripped). */
export function topicQuestions(topics: MeganTopic[], issue: string): string[] {
  return topicsOf(topics, issue)
    .flatMap((t) => t.questions.split(/\n+/))
    .map((q) => q.replace(/^\s*(?:[-•*]|\d+[.)])\s*/, "").trim())
    .filter(Boolean);
}

/** Megan's spreadsheet answers on an issue's topics, as classifier reference; null when none is filled. */
export function topicReference(topics: MeganTopic[], issue: string): string | null {
  const lines = topicsOf(topics, issue)
    .filter((t) => t.answer.trim())
    .map((t) => `[Megan's answer · spreadsheet 10-21 · topic #${t.n}] ${t.topic}\n${t.answer.trim()}`);
  return lines.length ? lines.join("\n\n") : null;
}

/** The classifier reference: Megan's spreadsheet answers (if any) first, then the agency docs' sections. */
export function withAnswers(answers: string | null, agency: AgencyReference | null): AgencyReference | null {
  if (!answers) return agency;
  return { text: agency ? `${answers}\n\n${agency.text}` : answers, sources: ["Megan spreadsheet 10-21", ...(agency?.sources ?? [])] };
}

/** The parsed topics, or null when megan-topics.json is missing. */
export function loadTopics(file: string): TopicsFile | null {
  return fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, "utf8")) as TopicsFile) : null;
}
