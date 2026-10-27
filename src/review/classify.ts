/**
 * Classifies the feedback loop's issues with Claude: ready to work when the CMS OASIS-E2 manual (or the issue's own
 * evidence) settles what should happen, needs clarification when something is missing. One cached call per issue,
 * re-run only when its input changes. The agency's documentation preferences (see agency.ts) go in as reference.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { Config } from "../config.js";
import { manualItems, oasisCodes } from "../manual/codes.js";
import { loadManual, type ManualIndex } from "../manual/lookup.js";
import { describeNotes, manualNotes, pageRange, type ManualNote, type NotesModel } from "../manual/notes.js";
import type { AgencyReference } from "./agency.js";
import { topicOf } from "./queries.js";
import type { Pack, Triage } from "./types.js";

/** Turns a prompt into a triage; injectable so tests don't call the model. */
export type ClassifyModel = (prompt: string) => Promise<Triage>;

/** Bump when the prompt or schema changes so every issue is re-classified. */
export const PROMPT_VERSION = 1;
export const MAX_INPUT = 12_000;
/** The agency reference's cap, on top of MAX_INPUT. */
export const REFERENCE_CAP = 4_000;
const CONCURRENCY = 4;
const TIMEOUT_MS = 3 * 60_000;
const MAX_CODES = 6;
const BOTS = /dotterino|^parcerito$|^linear$|^bot$|sentry/i;
const ADL_CONVENTIONS = /^1\.5\.8\.2 /;

const clip = (text: unknown, max: number) => {
  const s = String(text ?? "").replace(/\s+/g, " ").trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
};
const rows = (v: unknown) => (Array.isArray(v) ? v : []) as Record<string, any>[];
const show = (v: unknown) => (v === null || v === undefined || v === "" ? "blank" : typeof v === "string" ? v : JSON.stringify(v));
const name = (v: unknown) => String(v ?? "").replace(/\s*<[^>]*>$/, "");

/** Lines joined until `max` chars, cut at whole lines; `newest` keeps the last ones instead. */
function upTo(lines: string[], max: number, newest = false): string {
  if (newest) return upTo([...lines].reverse(), max).split("\n").reverse().join("\n");
  const out: string[] = [];
  let size = 0;
  for (const line of lines) {
    if (size + line.length > max) break;
    out.push(line);
    size += line.length + 1;
  }
  return out.join("\n");
}

/** The issue's fields on its visits: AI value → final answer, who decided and why, 1–2 evidence snippets; for fields with no suggestion, the status and what the AI saw. No names. */
export function visitTrace(pack: Pack, max = 2_000): string {
  const lines = pack.visits.flatMap((v, i) => {
    const t = rows(v.data.task)[0] ?? {};
    const clinician = name(t.clinician);
    const role = (by: unknown) => (!by ? "nobody" : name(by) === clinician ? "visit clinician" : "coder/reviewer");
    const head = `Visit ${i + 1} (${clip(t.form ?? t.task_name ?? "", 60)}, ${String(t.visit_date ?? "").slice(0, 10)}):`;
    const fields = rows(v.data.fields).map((f) => {
      const final = rows(f.answers).at(-1);
      const ev = rows(f.evidence)
        .slice(0, 2)
        .map((e) => `[${e.type}${e.page ? ` p.${e.page}` : e.at ? ` ${e.at}` : ""}] "${clip(e.snippet || e.text, 160)}"`);
      const fb = rows(f.feedback).map((x) => `feedback: "${clip(x.message, 160)}"`);
      return [
        `- ${f.key}: AI ${clip(show(f.ai_value), 80)} → final ${clip(show(final?.value), 80)}; ${f.decision ?? "pending"}`,
        f.decision === "rejected" ? ` via ${f.rejected_via ?? "?"}, reason ${f.rejection_reason ?? "none"}` : "",
        f.decided_by ? `, by ${role(f.decided_by)}` : "",
        ...[...ev, ...fb].map((x) => `\n    ${x}`),
      ].join("");
    });
    const steps = rows(v.data.no_suggestion_steps);
    const seen = rows(v.data.seen_evidence);
    const none = rows(v.data.unanswered).map((u) => {
      const last = steps.filter((s) => s.key === u.key).at(-1);
      const status = !last ? "never asked" : last.abstained ? "abstained" : last.gated ? "gated" : last.document_only ? "document-only" : last.error ? "error" : "no answer";
      const final = rows(u.answers).at(-1);
      const topic = topicOf(u.key);
      const passages = [...new Set(seen.filter((s) => s.key === u.key && (!topic || new RegExp(topic, "i").test(s.text ?? ""))).map((s) => `[${s.type}] "${clip(s.text, 200)}"`))].slice(0, 2);
      return [`- ${u.key}: no AI suggestion (${status}) → final ${clip(show(final?.value), 80)}${final ? ` by ${role(final.by)}` : ""}`, ...passages.map((p) => `    AI saw: ${p}`)].join("\n");
    });
    return [head, ...fields, ...none];
  });
  return upTo(lines, max);
}

/** The manual notes of the codes an issue names (title and description first, then comments), at most six items. */
export function issueCodes(pack: Pack, manual: ManualIndex | null): string[] {
  if (!manual) return [];
  const linear = pack.linear[0];
  const text = [pack.item.title, linear?.description ?? "", ...(linear?.comments.nodes.map((c) => c.body) ?? [])].join("\n");
  return manualItems(manual, oasisCodes(text)).slice(0, MAX_CODES).map((i) => i.code);
}

/**
 * The model's input for one issue, at most `MAX_INPUT` chars: the issue, its last comments, the Slack reports (bots
 * out), the visit trace, Megan's curated questions if any and the manual notes (+ ADL conventions for M18xx); then,
 * when given, the agency's documentation preferences (`reference`, at most `REFERENCE_CAP` more) with how to use them.
 */
export function issueInput(pack: Pack, notes: ManualNote[], opts: { manual?: ManualIndex | null; reference?: string } = {}): string {
  const { item } = pack;
  const linear = pack.linear[0];
  const comments = (linear?.comments.nodes ?? [])
    .slice()
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .slice(-8)
    .map((c) => `- ${c.createdAt.slice(0, 10)}: ${clip(c.body, 400)}`);
  const slack = pack.threads.flatMap((t) => t.messages.filter((m) => !BOTS.test(m.author)).map((m) => `- ${clip(m.text, 300)}`));
  const megan = item.verdict ? (item.panel.questions?.items ?? []) : [];
  const conventions = notes.some((n) => n.code.startsWith("M18"))
    ? (opts.manual?.general ?? []).filter((g) => ADL_CONVENTIONS.test(g.title)).map((g) => `${g.title} (${pageRange(g.pages)}): ${clip(g.text, 1_300)}`)
    : [];
  const sections = [
    // The Linear state stays out: moving an issue (Triage → Todo) shouldn't re-classify it.
    `ISSUE ${item.id}: ${clip(item.title, 200)}`,
    `DESCRIPTION\n${clip(linear?.description ?? item.text, 2_000)}`,
    comments.length ? `LAST COMMENTS\n${upTo(comments, 2_000, true)}` : "",
    slack.length ? `SLACK REPORTS\n${upTo(slack, 1_800)}` : "",
    pack.visits.length ? `VISIT TRACE (the issue's fields)\n${visitTrace(pack)}` : "",
    megan.length ? `ALREADY ASKED OF MEGAN\n${megan.map((q) => `- ${q}`).join("\n")}` : "",
    notes.length ? `CMS OASIS-E2 MANUAL NOTES\n${describeNotes(notes, 2_400)}` : "CMS OASIS-E2 MANUAL NOTES\n(the issue names no OASIS item the manual covers)",
    conventions.length ? `MANUAL CONVENTIONS\n${conventions.join("\n")}` : "",
  ];
  const input = sections.filter(Boolean).join("\n\n").slice(0, MAX_INPUT);
  const reference = opts.reference?.trim().slice(0, REFERENCE_CAP);
  return reference ? `${input}\n\n${AGENCY_HEADER}\n${reference}` : input;
}

/** How the classifier reads the agency reference; only in prompts that have one, so the others keep their cache. */
const AGENCY_HEADER = `AGENCY DOCUMENTATION PREFERENCES (from Megan: the agency's documentation preferences and defaults; "(generic)"
= the EHR's docs, not this agency's own). If these preferences answer what should happen, the issue is ready to work:
cite them in reason as "Agency prefs: <doc> · <section>". Use only what is written here, never invent a preference. The manual still wins for CMS coding rules;
these win for agency-specific questions (lime.* fields, narratives, defaults, what to leave blank).`;

/** The full prompt: the rule, then the issue's input. */
export function classifyPrompt(input: string): string {
  return `
You triage one Linear issue from Lime's prompts & forms feedback loop. Lime's AI fills home-health OASIS-E2 and
agency forms from visit recordings and documents; coders and clinicians review its answers, and these issues report
problems with them.

Rule: if, with the reference docs below, we know what should happen, the issue is ready to work; if something is
missing, it needs clarification from Megan (clinical lead).
- ready: the correct behaviour is determined by the manual notes, or is unambiguous from the issue and its evidence
  (e.g. an app or EHR-push bug with a clear expected result, a request that says what to change, a coding question
  the manual answers).
- needs-clarification: the correct clinical/coding answer depends on something the manual doesn't settle — an
  agency-specific field (lime.*), an agency preference, conflicting evidence, a missing expected value, or clinical
  judgement.

Use only the text below. Never invent manual content; cite pages only from the manual notes given (e.g. "M1830
p.125"). kind: coding-rule (how an item should be coded), prompt-behaviour (what the AI extracts, abstains on or
writes), ehr-push (pushing to/pulling from the EHR), app-bug (Lime app bug), request (new feature or change), other.
manualVerdict: covered / partial / not-in-manual for coding and prompt questions; n/a when the manual is irrelevant.
reason: 1–2 sentences — what is happening and which rule settles it, or what's missing. If ready: nextStep = the
concrete change in one sentence, questions = []. If needs-clarification: 1–4 concrete questions for Megan specific
to this evidence (skip any already asked of her), no nextStep.

${input}
`.trim();
}

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["classification", "kind", "reason", "manualVerdict", "questions"],
  properties: {
    classification: { type: "string", enum: ["ready", "needs-clarification"] },
    kind: { type: "string", enum: ["coding-rule", "prompt-behaviour", "ehr-push", "app-bug", "request", "other"] },
    reason: { type: "string" },
    manualVerdict: { type: "string", enum: ["covered", "partial", "not-in-manual", "n/a"] },
    questions: { type: "array", items: { type: "string" }, maxItems: 4 },
    nextStep: { type: "string" },
  },
} as const;

/** The real model: same Agent SDK call as the manual notes, low effort, no tools, structured output. */
function claudeClassify(config: Pick<Config, "CLAUDE_MODEL">): ClassifyModel {
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
        return message.structured_output as Triage;
      }
      throw new Error("no result");
    } finally {
      clearTimeout(timer);
    }
  };
}

const norm = (q: string) => q.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** Megan's curated questions first, then the classifier's new ones (deduped, case and punctuation ignored). */
export function mergeQuestions(curated: string[], extra: string[]): string[] {
  const seen = new Set<string>();
  return [...curated, ...extra].filter((q) => {
    const k = norm(q);
    if (!k || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/**
 * Puts a triage on its item: the class (Megan's issues stay needs-clarification), the reason, and for needs
 * clarification the questions for Megan (her curated ones first).
 */
export function applyTriage(pack: Pack, triage: Triage): void {
  const { item } = pack;
  const megan = !!item.verdict;
  const classification = megan ? "needs-clarification" : triage.classification;
  item.triage = { ...triage, classification };
  item.classification = classification;
  item.classificationReason = triage.reason;
  if (classification === "needs-clarification") {
    const curated = megan ? (item.panel.questions?.items ?? []) : [];
    const items = mergeQuestions(curated, triage.questions);
    if (items.length) item.panel = { ...item.panel, questions: { title: "❓ Questions for Megan", items } };
  }
}

export interface ClassifyTally {
  ready: number;
  needs: number;
  failed: number;
  cached: number;
}

/**
 * Classifies every issue pack (origin.kind === "issue") in place, 4 at a time, each with its agency reference. Each result is cached at
 * `<cacheDir>/classify/<id>.json` with a hash of its exact prompt; a failure keeps the Part-1 placeholder class with
 * "classifier failed: …" and isn't cached, so the next run retries it.
 */
export async function classifyIssues(
  config: Pick<Config, "CLAUDE_MODEL" | "DATA_DIR">,
  packs: Pack[],
  opts: {
    cacheDir: string;
    generate?: ClassifyModel;
    notesModel?: NotesModel;
    manual?: ManualIndex | null;
    /** The issue's agency documentation preferences (see agencyReference), if any. */
    reference?: (pack: Pack) => AgencyReference | null;
    log?: (line: string) => void;
  },
): Promise<ClassifyTally> {
  const manual = opts.manual === undefined ? loadManual() : opts.manual;
  const generate = opts.generate ?? claudeClassify(config);
  const log = opts.log ?? console.log;
  const dir = path.join(opts.cacheDir, "classify");
  fs.mkdirSync(dir, { recursive: true });
  const issues = packs.filter((p) => p.item.origin.kind === "issue");
  const tally: ClassifyTally = { ready: 0, needs: 0, failed: 0, cached: 0 };
  let done = 0;

  const one = async (pack: Pack) => {
    const file = path.join(dir, `${pack.item.id.replace(/[^\w.-]/g, "_")}.json`);
    try {
      const notes = await manualNotes(config, issueCodes(pack, manual), { manual, ...(opts.notesModel ? { generate: opts.notesModel } : {}) });
      const reference = opts.reference?.(pack) ?? null;
      if (reference) pack.item.agencySources = reference.sources;
      const prompt = classifyPrompt(issueInput(pack, notes, { manual, reference: reference?.text }));
      const hash = createHash("sha256").update(`v${PROMPT_VERSION}\n${prompt}`).digest("hex");
      const hit = fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, "utf8")) as { hash: string; triage: Triage }) : null;
      let triage: Triage;
      if (hit?.hash === hash) {
        triage = hit.triage;
        tally.cached++;
      } else {
        triage = await generate(prompt);
        fs.writeFileSync(file, JSON.stringify({ hash, triage }, null, 2));
      }
      applyTriage(pack, triage);
      if (pack.item.classification === "ready") tally.ready++;
      else tally.needs++;
    } catch (error) {
      tally.failed++;
      pack.item.classificationReason = `classifier failed: ${clip((error as Error).message ?? error, 200)}`;
    }
    if (++done % 10 === 0 || done === issues.length)
      log(`classified ${done}/${issues.length} (${tally.ready} ready, ${tally.needs} needs clarification, ${tally.failed} failed, ${tally.cached} cached)`);
  };

  let next = 0;
  const worker = async () => {
    while (next < issues.length) await one(issues[next++]!);
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, issues.length) }, worker));
  return tally;
}
