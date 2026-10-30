/**
 * Likely duplicate Linear issues among the agenda's issues and the feedback loop's open ones. A cheap pre-filter
 * (shared Slack thread or visit, shared OASIS codes plus a similar title, or a very similar title) picks candidates
 * per newest-agenda issue; one cached Claude call per group says which are really the same problem. Nothing is
 * marked here: the review comment lists them and `npm run duplicates -- --apply` marks them after a confirm.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { withoutAgendaPrefix } from "../agenda/linear.js";
import type { Config } from "../config.js";
import { fieldKeys } from "./items.js";
import type { Pack } from "./types.js";

export type Confidence = "high" | "medium" | "low";
export interface DuplicatePair {
  a: string;
  b: string;
  confidence: Confidence;
  why: string;
}

/** What the pre-filter compares an issue on. */
export interface IssueProfile {
  id: string;
  title: string;
  description: string;
  state: string;
  createdAt?: string;
  threads: string[];
  tasks: string[];
  codes: string[];
  words: string[];
}

export interface Candidate {
  profile: IssueProfile;
  signals: string[];
  score: number;
}

export type DuplicateModel = (prompt: string) => Promise<DuplicatePair[]>;

const VERSION = 1;
const CONCURRENCY = 4;
const TIMEOUT_MS = 2 * 60_000;
const MAX_CANDIDATES = 5;
const STOP = new Set(
  "with from that this when have been were they them what which into does doesn should would could about after before over under their there field fields form forms issue value values answer answers".split(" "),
);
const RANK: Record<Confidence, number> = { high: 3, medium: 2, low: 1 };
const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["pairs"],
  properties: {
    pairs: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["a", "b", "confidence", "why"],
        properties: {
          a: { type: "string" },
          b: { type: "string" },
          confidence: { type: "string", enum: ["high", "medium", "low"] },
          why: { type: "string", description: "One line: what makes them the same problem" },
        },
      },
    },
  },
} as const;

/** Significant title words: lowercase, 4+ letters, no stop words, agenda prefix and brackets dropped. */
export function titleWords(title: string): string[] {
  const words = withoutAgendaPrefix(title).toLowerCase().replace(/\[[^\]]*\]/g, " ").match(/[a-z0-9]{4,}/g) ?? [];
  return [...new Set(words.filter((w) => !STOP.has(w)))];
}

/** Jaccard overlap of two word lists. */
export function overlap(a: string[], b: string[]): number {
  const set = new Set(a);
  const shared = b.filter((w) => set.has(w)).length;
  const union = new Set([...a, ...b]).size;
  return union ? shared / union : 0;
}

/** One profile per Linear issue in the packs, with the Slack threads and visits of every pack that names it. */
export function issueProfiles(packs: Pack[]): Map<string, IssueProfile> {
  const out = new Map<string, IssueProfile>();
  for (const pack of packs) {
    const threads = pack.threads.map((t) => `${t.ref.channel}/${t.messages[0]?.ts ?? t.ref.ts}`);
    const tasks = pack.visits.map((v) => v.task);
    for (const issue of pack.linear) {
      const prev = out.get(issue.identifier);
      const text = `${withoutAgendaPrefix(issue.title)}\n${issue.description ?? ""}`;
      const keys = fieldKeys(text);
      out.set(issue.identifier, {
        id: issue.identifier,
        title: withoutAgendaPrefix(issue.title),
        description: issue.description ?? "",
        state: issue.state.name,
        createdAt: issue.createdAt ?? prev?.createdAt,
        threads: [...new Set([...(prev?.threads ?? []), ...threads])],
        tasks: [...new Set([...(prev?.tasks ?? []), ...tasks])],
        codes: [...new Set([...keys.oasis, ...keys.lime])],
        words: titleWords(issue.title),
      });
    }
  }
  return out;
}

/** The pre-filter: issues in `pool` that share a thread/visit with `target`, or codes plus title words, or most title words. */
export function candidates(target: IssueProfile, pool: IssueProfile[]): Candidate[] {
  const out: Candidate[] = [];
  for (const other of pool) {
    if (other.id === target.id) continue;
    const signals: string[] = [];
    let score = 0;
    const threads = other.threads.filter((t) => target.threads.includes(t)).length;
    const tasks = other.tasks.filter((t) => target.tasks.includes(t)).length;
    const codes = other.codes.filter((c) => target.codes.includes(c));
    const words = overlap(target.words, other.words);
    const add = (signal: string, points: number) => {
      signals.push(signal);
      score += points;
    };
    if (threads) add(`same Slack thread${threads > 1 ? `s (${threads})` : ""}`, 3);
    if (tasks) add(`same visit${tasks > 1 ? `s (${tasks})` : ""}`, 2);
    if (codes.length && words >= 0.2) add(`same codes ${codes.slice(0, 4).join(", ")} and similar titles`, 2);
    else if (words >= 0.5) add("very similar titles", 1);
    if (signals.length) out.push({ profile: other, signals, score: score + words });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, MAX_CANDIDATES);
}

const describe = (p: IssueProfile) =>
  `${p.id} [${p.state}${p.createdAt ? `, created ${p.createdAt.slice(0, 10)}` : ""}] ${p.title}\n${p.description.replace(/\s+/g, " ").slice(0, 700)}`;

export function duplicatesPrompt(target: IssueProfile, list: Candidate[]): string {
  return `You check a Linear team's issues for duplicates. Two issues are duplicates when fixing one would fix the other: the same underlying problem (same field/behaviour/bug), not merely the same area or the same customer. An umbrella issue and one specific instance of it are NOT duplicates unless the instance adds nothing. Compare the TARGET with each candidate and return only the pairs that are likely duplicates, as { a: "${target.id}", b: <candidate id>, confidence, why } — high only when you'd mark it Duplicate without asking; why is one short line naming the shared evidence. Return an empty list when none are.

TARGET
${describe(target)}

CANDIDATES
${list.map((c) => `${describe(c.profile)}\nShared with target: ${c.signals.join("; ")}`).join("\n\n")}`;
}

/** Pairs with the order of the ids normalised, the strongest copy of each pair kept. */
export function mergePairs(pairs: DuplicatePair[]): DuplicatePair[] {
  const out = new Map<string, DuplicatePair>();
  for (const p of pairs) {
    if (p.a === p.b) continue;
    const key = [p.a, p.b].sort().join("|");
    const prev = out.get(key);
    if (!prev || RANK[p.confidence] > RANK[prev.confidence]) out.set(key, p);
  }
  return [...out.values()].sort((x, y) => RANK[y.confidence] - RANK[x.confidence] || x.a.localeCompare(y.a));
}

/**
 * Likely duplicates of each `targets` issue among `pool` (issue ids; profiles come from the packs): one Claude call
 * per target that has pre-filter candidates, cached by prompt hash in `<cacheDir>/duplicates/`. A failed call is
 * logged and skipped (not cached), so the next run retries it.
 */
export async function findDuplicates(
  config: Pick<Config, "CLAUDE_MODEL">,
  packs: Pack[],
  opts: { targets: string[]; pool: string[]; cacheDir: string; generate?: DuplicateModel },
): Promise<{ pairs: DuplicatePair[]; checked: number; calls: number }> {
  const profiles = issueProfiles(packs);
  const pool = [...new Set([...opts.pool, ...opts.targets])].flatMap((id) => (profiles.has(id) ? [profiles.get(id)!] : []));
  const generate = opts.generate ?? claudeDuplicates(config);
  const dir = path.join(opts.cacheDir, "duplicates");
  fs.mkdirSync(dir, { recursive: true });
  const queue = [...new Set(opts.targets)].flatMap((id) => {
    const target = profiles.get(id);
    const list = target ? candidates(target, pool) : [];
    return target && list.length ? [{ target, list }] : [];
  });
  const checked = queue.length;
  const found: DuplicatePair[] = [];
  let calls = 0;
  const worker = async () => {
    for (let group = queue.shift(); group; group = queue.shift()) {
      const { target, list } = group;
      const prompt = duplicatesPrompt(target, list);
      const hash = createHash("sha256").update(`v${VERSION}\n${prompt}`).digest("hex");
      const file = path.join(dir, `${target.id.replace(/[^\w.-]/g, "_")}.json`);
      const hit = fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, "utf8")) as { hash: string; pairs: DuplicatePair[] }) : null;
      let pairs: DuplicatePair[];
      if (hit?.hash === hash) pairs = hit.pairs;
      else {
        try {
          calls++;
          pairs = await generate(prompt);
          fs.writeFileSync(file, JSON.stringify({ hash, pairs }));
        } catch (error) {
          console.warn(`[duplicates] ${target.id}: ${error instanceof Error ? error.message : error}`);
          continue;
        }
      }
      // Only pairs of the target with one of its own candidates count; the model can't invent others.
      const ids = new Set(list.map((c) => c.profile.id));
      found.push(...pairs.filter((p) => (p.a === target.id && ids.has(p.b)) || (p.b === target.id && ids.has(p.a))));
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker));
  return { pairs: mergePairs(found), checked, calls };
}

/** The newer issue of a pair (later createdAt, else higher number) is the one to mark Duplicate. */
export function newerOf(pair: DuplicatePair, createdAt: Map<string, string | undefined> = new Map()): { newer: string; older: string } {
  const num = (id: string) => Number(id.match(/(\d+)$/)?.[1] ?? 0);
  const [ca, cb] = [createdAt.get(pair.a), createdAt.get(pair.b)];
  const aNewer = ca && cb ? ca > cb : num(pair.a) > num(pair.b);
  return aNewer ? { newer: pair.a, older: pair.b } : { newer: pair.b, older: pair.a };
}

/** Same Agent SDK call as the briefs: low effort, no tools, structured output. */
function claudeDuplicates(config: Pick<Config, "CLAUDE_MODEL">): DuplicateModel {
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
        if (message.subtype !== "success" || !message.structured_output) throw new Error(`Duplicates check stopped early (${message.subtype})`);
        return (message.structured_output as { pairs: DuplicatePair[] }).pairs;
      }
      throw new Error("Duplicates check returned no result");
    } finally {
      clearTimeout(timer);
    }
  };
}
