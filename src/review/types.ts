/** Shared shapes of a review pack: the issue config, what Linear/Slack/prod return, and the pack itself. */
import type { Source } from "../agenda/render.js";

/** Runs one read-only SQL statement and returns psql's raw `-At` output. */
export type Query = (sql: string) => Promise<string>;

export type Verdict = "partial" | "not-in-manual";

export interface Issue {
  id: string;
  verdict: Verdict;
  /** What the CMS manual says, short. */
  manual: string;
  /** What to ask Megan. */
  ask: string[];
  /** SQL predicate on `fd` (field) picking the fields this issue is about. */
  fields: string;
  related?: string[];
  /** Meeting order: 1 ADLs (M1800s), 2 GG mobility, 3 other OASIS items, 4 agency form fields, 5 narratives. */
  group: 1 | 2 | 3 | 4 | 5;
}

/** Meeting order: 1 ADLs, 2 GG mobility, 3 other OASIS, 4 agency fields, 5 narratives, 6 other (bugs, EHR, requests). */
export type Group = 1 | 2 | 3 | 4 | 5 | 6;

/** A rejected-suggestion row an agenda card was built from. */
export type DbRow = Extract<Source, { kind: "db" }>["rows"][number];

/**
 * Where a review item comes from: Megan's clarification list, a daily agenda card (first seen / last seen), or a
 * Linear issue of the prompts & forms feedback loop (see issues.ts).
 */
export type Origin =
  | { kind: "megan" }
  | { kind: "agenda"; date: string; agenda: string; cardId: string }
  | { kind: "issue"; url: string; state: string; stateType?: string; updatedAt?: string };

/** Which Issues sub-view an issue belongs to (see classify in issues.ts). */
export type Classification = "needs-clarification" | "ready" | "unclassified";

/** What the issue classifier (classify.ts) says about an issue, against the CMS manual and the issue's evidence. */
export interface Triage {
  classification: "ready" | "needs-clarification";
  kind: "coding-rule" | "prompt-behaviour" | "ehr-push" | "app-bug" | "request" | "other";
  /** 1–2 sentences: what's happening and which rule settles it (with manual pages), or what's missing. */
  reason: string;
  manualVerdict: "covered" | "partial" | "not-in-manual" | "n/a";
  /** Needs clarification only: concrete questions for Megan. */
  questions: string[];
  /** Ready only: the concrete change. */
  nextStep?: string;
}

/** Anything reviewed in a pack, whatever its source: what the page shows and how its visits are queried. */
export interface Item {
  id: string;
  title: string;
  origin: Origin;
  group: Group;
  urgency?: "high" | "medium" | "low";
  customers?: string[];
  /** Linear issue ids, 0..n. */
  linear: string[];
  /** Slack threads named by the source itself (Linear text is scanned too, see gatherPack). */
  slack: SlackRef[];
  /** SQL predicate on `fd` (field) picking the fields this item is about. */
  fields: string;
  /** Pills next to the id, and the grey line under the title. */
  badges: { text: string; kind: string }[];
  meta: string[];
  /** Right panel: titled text blocks, checkable questions and the notes placeholder. */
  panel: { blocks: { cls: string; title: string; text: string }[]; questions?: { title: string; items: string[] }; placeholder: string };
  /** Rejected rows behind an agenda card, shown under Reports. */
  rows?: DbRow[];
  /** Free text the item came with, scanned for visit/case links. */
  text: string;
  verdict?: Verdict;
  /** Issue items only: the Issues sub-view, and why. */
  classification?: Classification;
  classificationReason?: string;
  /** Issue items only: the classifier's full answer, when it ran. */
  triage?: Triage;
  /** Issue items only: the agency-doc sections (`doc · heading`) the classifier was given. */
  agencySources?: string[];
}

export interface LinearComment {
  body: string;
  createdAt: string;
  user: { name: string } | null;
}

export interface LinearIssue {
  identifier: string;
  title: string;
  url: string;
  description: string;
  state: { name: string; type?: string };
  assignee: { name: string } | null;
  comments: { nodes: LinearComment[] };
  /** Only on issues from the feedback-loop query (see issues.ts). */
  labels?: { nodes: { name: string }[] };
  creator?: { name: string } | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface SlackRef {
  channel: string;
  ts: string;
}

export interface SlackMessage {
  author: string;
  ts: string;
  text: string;
  permalink: string;
  images: string[];
  files: string[];
}

export interface SlackThread {
  ref: SlackRef;
  link: string;
  messages: SlackMessage[];
  error?: string;
}

/** One visit's prod data for an issue, keyed by query name (see visitQueries); a failed query holds `{ error }`. */
export interface VisitData {
  task: string;
  data: Record<string, unknown>;
}

export type VisitStatus = "not-imported" | "no-linked-visit" | "linked-visit-not-found" | "loaded" | "partial" | "failed";

export interface Pack {
  visitStatus?: VisitStatus;
  item: Item;
  linear: LinearIssue[];
  /** Fetch failures (e.g. a Linear 404), shown inline instead of aborting the build. */
  errors: string[];
  threads: SlackThread[];
  visits: VisitData[];
}
