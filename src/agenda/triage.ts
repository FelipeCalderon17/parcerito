import { query } from "@anthropic-ai/claude-agent-sdk";
import type { Config } from "../config.js";
import type { Conversation } from "./collect.js";
import type { LinkedIssue } from "./linear.js";

export const SECTIONS = {
  prompts: "Prompts & AI output quality",
  ehr: "EHR integrations & push",
  bugs: "Bugs & reliability",
  requests: "Requests & feedback",
  questions: "Open questions",
} as const;
export type Section = keyof typeof SECTIONS;

export interface TriageItem {
  id: string;
  section: Section;
  title: string;
  customers: string[];
  urgency: "high" | "medium" | "low";
  summary: string;
  proposal: string;
  conversationIds: string[];
  linear:
    | { action: "tracked" }
    | { action: "existing"; identifier: string }
    | { action: "create"; title: string; description: string };
}

/** A conversation that isn't an issue (thanks, status updates, already answered), with why. */
export interface SkippedConversation {
  conversationId: string;
  reason: string;
}

/** A pattern in the AI suggestions coders rejected, with what to change in the prompts. */
export interface RejectedPattern {
  title: string;
  fieldKeys: string[];
  finding: string;
  proposal: string;
  relatedIssue?: string;
}

export interface Triage {
  overview: string;
  items: TriageItem[];
  skipped: SkippedConversation[];
  rejectedPatterns: RejectedPattern[];
}

const schema = {
  type: "object",
  additionalProperties: false,
  required: ["overview", "items", "skipped", "rejectedPatterns"],
  properties: {
    overview: { type: "string", description: "2-4 sentences: the shape of the period, what stands out" },
    items: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "section", "title", "customers", "urgency", "summary", "proposal", "conversationIds", "linear"],
        properties: {
          id: { type: "string", description: "Short unique slug, e.g. mission-m1400-omitted" },
          section: { type: "string", enum: Object.keys(SECTIONS) },
          title: { type: "string" },
          customers: { type: "array", items: { type: "string" } },
          urgency: { type: "string", enum: ["high", "medium", "low"] },
          summary: { type: "string", description: "What was reported, by whom, how often. No patient details." },
          proposal: {
            type: "string",
            description: "Proposed solution or next step, and the decision Felipe and Nico need to make",
          },
          conversationIds: { type: "array", items: { type: "string" }, minItems: 1 },
          linear: {
            type: "object",
            additionalProperties: false,
            required: ["action"],
            properties: {
              action: { type: "string", enum: ["tracked", "existing", "create"] },
              identifier: { type: "string", description: "For existing: the issue to attach the messages to" },
              title: { type: "string", description: "For create" },
              description: { type: "string", description: "For create: markdown body" },
            },
          },
        },
      },
    },
    skipped: {
      type: "array",
      description: "Conversations that aren't issues",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["conversationId", "reason"],
        properties: {
          conversationId: { type: "string" },
          reason: { type: "string", description: "One short line, e.g. 'Thank-you after the fix'" },
        },
      },
    },
    rejectedPatterns: {
      type: "array",
      description: "Patterns in the rejected AI suggestions; empty when there are none",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title", "fieldKeys", "finding", "proposal"],
        properties: {
          title: { type: "string" },
          fieldKeys: { type: "array", items: { type: "string" } },
          finding: { type: "string", description: "What coders keep correcting, with counts and customers" },
          proposal: { type: "string", description: "The concrete prompt or source-policy change to discuss" },
          relatedIssue: { type: "string", description: "Linear identifier of an open issue about it, if any" },
        },
      },
    },
  },
} as const;

const READ_ONLY_LINEAR = [
  "list_issues",
  "get_issue",
  "list_comments",
  "list_projects",
  "get_project",
  "list_issue_labels",
  "list_teams",
  "list_issue_statuses",
  "list_users",
  "get_user",
  "list_cycles",
  "search_documentation",
].map((name) => `mcp__linear__${name}`);

export async function triageConversations(
  config: Config,
  input: {
    conversations: Conversation[];
    trackedIn: Map<string, LinkedIssue[]>;
    /** Rejected AI suggestions from production, already summarized (see describeRejected). */
    rejected?: string;
    since: Date;
    until: Date;
  },
  opts: { cwd: string; signal: AbortSignal },
): Promise<Triage> {
  const payload = input.conversations.map((c) => ({
    id: c.id,
    channel: c.channelName,
    alreadyTrackedIn: (input.trackedIn.get(c.id) ?? []).map((i) => `${i.identifier} (${i.state}): ${i.title}`),
    messages: c.messages.map((m) => ({
      author: m.author,
      from: m.external ? "service team" : m.author === "bot" ? "bot" : "internal",
      new: m.inWindow,
      at: new Date(Number(m.ts) * 1000).toISOString(),
      text: m.text,
    })),
  }));

  const prompt = `
You prepare the daily sync between Felipe (engineer, owns prompts and AI output quality) and Nico (his boss).
Below are Slack conversations from customer and EHR channels between ${input.since.toISOString()} and
${input.until.toISOString()}. Each has at least one new message from the service team (clinicians, coders,
agency staff). Internal messages and bot replies (Dotterino is Nico's triage bot) are context only.

First decide, for each conversation, whether it's really an issue: something the team has to fix, decide,
build or answer. Not issues: thanks, greetings, "ok/will check", status updates, scheduling, praise, a question
the team already answered in the thread, or a report the thread shows is already resolved. Put those in
skipped with a one-line reason. When in doubt, it's an issue: Felipe reviews the skipped list.

Turn the issues into agenda items:
- Group conversations about the same underlying problem into one item.
- Every conversation must appear exactly once: in one item or in skipped.
- Pick a section: prompts (AI-generated answers, wrong or missing form values, narrative quality, rejected
  suggestions), ehr (push/pull/sync with Axxess, Netsmart, Kantime, WellSky), bugs (app errors, outages,
  performance), requests (features, workflow changes), questions (customer questions still waiting for an
  answer or a decision).
- summary: what was reported and by whom. Never copy patient names, MRNs, dates of birth or clinical values.
- proposal: your best proposed solution or next step, phrased so Felipe and Nico can decide on it in the meeting.
- urgency: high if a customer is blocked or it affects many charts, low for nice-to-haves.

Linear (team ${config.LINEAR_TEAM_KEY}). Every agenda item must end up tracked in an issue:
- If every conversation in the item has alreadyTrackedIn entries, use action "tracked".
- Otherwise search Linear (read-only tools) for an open issue about the same problem. If one clearly matches,
  use "existing" with its identifier; the messages will be attached to it as a comment.
- Otherwise use "create" with a title and a markdown description in Dotterino's style: Report, Scope and
  evidence, Required validation. State what is reported vs. confirmed, no patient details, no speculation as fact.
  The Slack source links are appended automatically.
You can't create or edit anything in Linear yourself.

${
  input.rejected
    ? `
Rejected AI suggestions. These come from Lime production: form fields where a coder rejected the AI's value
(with a reason) or overwrote it. They're Felipe's main input for prompt work. In rejectedPatterns, group them
into patterns (same field, same kind of mistake, or the same source-policy complaint such as "transcript
only"), most impactful first, and propose the concrete prompt or source-policy change for each. Link a related
open Linear issue if you find one; don't turn these into agenda items or new issues. One-off rejections with no
pattern can be a single "Other rejections" entry. Don't copy clinical values into the text.

${input.rejected}
`
    : "There's no rejected-suggestions export today: return an empty rejectedPatterns."
}

Conversations:
${JSON.stringify(payload, null, 1)}
`.trim();

  const abortController = new AbortController();
  opts.signal.addEventListener("abort", () => abortController.abort(), { once: true });
  const conversation = query({
    prompt,
    options: {
      model: config.CLAUDE_MODEL,
      effort: config.CLAUDE_EFFORT,
      cwd: opts.cwd,
      mcpServers: config.LINEAR_API_KEY
        ? {
            linear: {
              type: "http",
              url: "https://mcp.linear.app/mcp",
              headers: { Authorization: `Bearer ${config.LINEAR_API_KEY}` },
            },
          }
        : {},
      tools: [],
      allowedTools: READ_ONLY_LINEAR,
      permissionMode: "dontAsk",
      settingSources: [],
      outputFormat: { type: "json_schema", schema },
      abortController,
    },
  });

  for await (const message of conversation) {
    if (message.type !== "result") continue;
    if (message.subtype !== "success" || !message.structured_output) {
      throw new Error(`Triage stopped early (${message.subtype})`);
    }
    return message.structured_output as Triage;
  }
  throw new Error("Triage returned no result");
}
