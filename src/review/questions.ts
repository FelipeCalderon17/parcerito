/**
 * Keeps each issue's questions to resolve short enough to go through 20 issues in one meeting: when the merged list
 * (Megan's curated questions, the classifier's, the spreadsheet topics') runs past MAX_QUESTIONS, Claude condenses it
 * into at most that many questions that still settle the issue. Cached per item by input hash.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { Config } from "../config.js";
import type { Item } from "./types.js";

export const MAX_QUESTIONS = 5;
export type CondenseModel = (prompt: string) => Promise<string[]>;

const VERSION = 1;
const CONCURRENCY = 4;
const TIMEOUT_MS = 2 * 60_000;
const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["questions"],
  properties: { questions: { type: "array", items: { type: "string" }, minItems: 1, maxItems: MAX_QUESTIONS } },
} as const;

/** Where an item keeps its questions to resolve: the classifier's (needs clarification) or the panel's. */
function questionsOf(item: Item): string[] | undefined {
  return item.triage?.classification === "needs-clarification" ? item.triage.questions : item.panel.questions?.items;
}

function setQuestions(item: Item, questions: string[]): void {
  if (item.triage?.classification === "needs-clarification") item.triage.questions = questions;
  else if (item.panel.questions) item.panel.questions.items = questions;
}

export function condensePrompt(item: Item, questions: string[]): string {
  return `A clinical lead (Megan) will go through about 20 issues in one meeting. This issue has ${questions.length} open questions; rewrite them as AT MOST ${MAX_QUESTIONS} questions that together are enough to resolve it. Merge duplicates and overlapping questions, drop ones the others already cover or that don't change what we'd build, keep each one concrete and answerable in a sentence, and keep the ones that came first (the curated ones) unless covered. Keep field codes and page refs when they matter.

Issue: ${item.title}
${item.triage ? `Context: ${item.triage.reason}` : ""}

QUESTIONS
${questions.map((q, i) => `${i + 1}. ${q}`).join("\n")}`;
}

/** Condenses every item whose questions run past MAX_QUESTIONS; a failed call falls back to the first MAX_QUESTIONS. */
export async function condenseQuestions(
  config: Pick<Config, "CLAUDE_MODEL">,
  items: Item[],
  cacheDir: string,
  generate: CondenseModel = claudeCondense(config),
): Promise<number> {
  const dir = path.join(cacheDir, "questions");
  fs.mkdirSync(dir, { recursive: true });
  const queue = items.filter((i) => (questionsOf(i)?.length ?? 0) > MAX_QUESTIONS);
  const total = queue.length;
  const worker = async () => {
    for (let item = queue.shift(); item; item = queue.shift()) {
      const questions = questionsOf(item)!;
      const prompt = condensePrompt(item, questions);
      const hash = createHash("sha256").update(`v${VERSION}\n${prompt}`).digest("hex");
      const file = path.join(dir, `${item.id.replace(/[^\w.-]/g, "_")}.json`);
      const cached = fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, "utf8")) as { hash: string; questions: string[] }) : null;
      if (cached?.hash === hash) {
        setQuestions(item, cached.questions);
        continue;
      }
      try {
        const condensed = (await generate(prompt)).slice(0, MAX_QUESTIONS);
        fs.writeFileSync(file, JSON.stringify({ hash, questions: condensed }));
        setQuestions(item, condensed);
      } catch (error) {
        console.warn(`[questions] ${item.id}: ${error instanceof Error ? error.message : error}`);
        setQuestions(item, questions.slice(0, MAX_QUESTIONS));
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker));
  return total;
}

/** Same Agent SDK call as the briefs: low effort, no tools, structured output. */
function claudeCondense(config: Pick<Config, "CLAUDE_MODEL">): CondenseModel {
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
        if (message.subtype !== "success" || !message.structured_output) throw new Error(`Condense stopped early (${message.subtype})`);
        return (message.structured_output as { questions: string[] }).questions;
      }
      throw new Error("Condense returned no result");
    } finally {
      clearTimeout(timer);
    }
  };
}
