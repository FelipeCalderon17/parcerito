/**
 * The short docs brief on an item's page: one paragraph on what the CMS manual and the agency prefs say
 * that matters for THIS issue, and how to handle it — instead of every rule note for every item it names.
 * Generated once per item input (sha256-cached), like the classifier.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { Config } from "../config.js";
import { pageRange } from "../manual/notes.js";
import type { Item } from "./types.js";

export type BriefModel = (prompt: string) => Promise<string>;
type Note = { code: string; title: string; pages: [number, number]; notes: string };
type Entry = { item: Item; notes: Note[]; agency?: string };

const BRIEF_VERSION = 2;
const CONCURRENCY = 4;
const TIMEOUT_MS = 2 * 60_000;
const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["brief"],
  properties: { brief: { type: "string" } },
} as const;

/** What the item is about, from its panel (agenda "What happened" / issue text) and the classifier, if any. */
function itemContext(item: Item): string {
  const blocks = item.panel.blocks.filter((b) => !b.title.includes("CMS OASIS-E2 manual")).map((b) => `${b.title}: ${b.text}`);
  const t = item.triage;
  return [
    `Issue: ${item.title}`,
    ...blocks.map((b) => b.slice(0, 700)),
    t ? `Classifier: ${t.classification} (${t.kind}). ${t.reason}${t.nextStep ? ` Next step: ${t.nextStep}` : ""}` : "",
    item.agencySources?.length ? `Agency prefs used: ${item.agencySources.join("; ")}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export function briefPrompt(item: Item, notes: Note[], agency?: string): string {
  return `You brief a clinical/engineering review meeting on one issue about AI-filled OASIS/agency form fields.
Write ONE paragraph, at most 70 words, for someone reading 20 of these in a row: the rules that actually matter for this issue — from the CMS manual (cite pages like "p.130") and from the agency's own documentation preferences (cite as "Agency prefs: <doc> · <section>"; for agency-specific fields and defaults they win) — and how we should handle it (what the AI/prompt should do). If the docs don't settle it, say what is missing and what to ask Megan (clinical lead). Use only the text below; don't list rules that don't bear on this issue; never invent pages or preferences.

${itemContext(item)}

MANUAL NOTES
${notes.length ? notes.map((n) => `${n.code} ${n.title} (${pageRange(n.pages)})\n${n.notes}`).join("\n\n") : "(none for this issue)"}
${agency ? `\nAGENCY DOCUMENTATION PREFERENCES (from Megan)\n${agency}` : ""}`;
}

/** Briefs for the items, keyed by item id; items with neither manual notes nor agency prefs, or whose call fails, are left out. */
export async function manualBriefs(
  config: Pick<Config, "CLAUDE_MODEL">,
  entries: Entry[],
  cacheDir: string,
  generate: BriefModel = claudeBrief(config),
): Promise<Map<string, string>> {
  const dir = path.join(cacheDir, "manual-brief");
  fs.mkdirSync(dir, { recursive: true });
  const out = new Map<string, string>();
  const queue = entries.filter((e) => e.notes.length || e.agency);
  const worker = async () => {
    for (let e = queue.shift(); e; e = queue.shift()) {
      const prompt = briefPrompt(e.item, e.notes, e.agency);
      const hash = createHash("sha256").update(`v${BRIEF_VERSION}\n${prompt}`).digest("hex");
      const file = path.join(dir, `${e.item.id.replace(/[^\w.-]/g, "_")}.json`);
      const cached = fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, "utf8")) as { hash: string; brief: string }) : null;
      if (cached?.hash === hash) {
        out.set(e.item.id, cached.brief);
        continue;
      }
      try {
        const brief = (await generate(prompt)).trim();
        fs.writeFileSync(file, JSON.stringify({ hash, brief }));
        out.set(e.item.id, brief);
      } catch (error) {
        console.warn(`[brief] ${e.item.id}: ${error instanceof Error ? error.message : error}`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker));
  return out;
}

/** Same Agent SDK call as the notes: low effort, no tools, structured output. */
function claudeBrief(config: Pick<Config, "CLAUDE_MODEL">): BriefModel {
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
        if (message.subtype !== "success" || !message.structured_output) throw new Error(`Brief stopped early (${message.subtype})`);
        return (message.structured_output as { brief: string }).brief;
      }
      throw new Error("Brief returned no result");
    } finally {
      clearTimeout(timer);
    }
  };
}
