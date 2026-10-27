/**
 * Linear issues of the prompts & forms feedback loop as review items: the scope query and rule, Megan's clarification
 * data merged onto her issues, and the Needs clarification / Ready to work / Unclassified split.
 */
import { loadManual, type ManualIndex } from "../manual/lookup.js";
import { cached, slackRefs } from "./gather.js";
import { fieldKeys, fieldPredicate, groupOf, manualBlock } from "./items.js";
import { meganItem } from "./megan-issues.js";
import type { Classification, Issue, Item, LinearIssue } from "./types.js";

/** Labels that put an issue in the loop, and the one that keeps it out. */
export const LOOP_LABELS = ["parcerito", "Felipe · Nico sync"];
export const EXCLUDED_LABEL = "Infra / Sentry";
const ACTIVE = ["triage", "backlog", "unstarted", "started"];
/** Dotterino (Nico's triage bot) writes the checkpoint; parcerito writes "Filed by parcerito on Dotterino's behalf". */
const CHECKPOINT = /Source checkpoint:/;
const BEHALF = /on Dotterino.s behalf/i;

const labelsOf = (issue: LinearIssue) => (issue.labels?.nodes ?? []).map((l) => l.name);

/**
 * Whether an issue is part of the feedback loop: active state, not Infra / Sentry, and filed by Dotterino or
 * parcerito, labelled for the loop, or `referenced` (named by an agenda card or Megan's list).
 */
export function inScope(issue: LinearIssue, referenced: Set<string>): boolean {
  const labels = labelsOf(issue);
  if (labels.includes(EXCLUDED_LABEL) || (issue.state.type && !ACTIVE.includes(issue.state.type))) return false;
  const text = issue.description ?? "";
  return CHECKPOINT.test(text) || BEHALF.test(text) || labels.some((l) => LOOP_LABELS.includes(l)) || referenced.has(issue.identifier);
}

const QUERY = `query($after: String, $numbers: [Float!]) {
  issues(first: 50, after: $after, filter: {
    team: { key: { eq: "ENG" } }, state: { type: { in: ${JSON.stringify(ACTIVE)} } },
    or: [{ description: { contains: "Source checkpoint:" } }, { description: { containsIgnoreCase: "behalf" } },
      { labels: { some: { name: { in: ${JSON.stringify(LOOP_LABELS)} } } } }, { number: { in: $numbers } }] }) {
    pageInfo { hasNextPage endCursor }
    nodes { identifier title url description createdAt updatedAt state { name type } labels { nodes { name } }
      assignee { name } creator { name } comments(first: 100) { nodes { body createdAt user { name } } } } } }`;

/**
 * The loop's issues, every page of a server-side prefilter narrowed by `inScope`. Refetched each run; the last good
 * list (cache/linear-loop.json) is used when Linear fails.
 */
export async function loopIssues(referenced: Set<string>, cacheDir: string): Promise<LinearIssue[]> {
  const numbers = [...referenced].flatMap((id) => (/^ENG-\d+$/.test(id) ? [Number(id.slice(4))] : []));
  const all = await cached(
    cacheDir,
    "linear-loop",
    async () => {
      const out: LinearIssue[] = [];
      let after: string | null = null;
      do {
        const res = await fetch("https://api.linear.app/graphql", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: process.env.LINEAR_API_KEY! },
          body: JSON.stringify({ query: QUERY, variables: { after, numbers } }),
        });
        const json = (await res.json()) as {
          data?: { issues: { pageInfo: { hasNextPage: boolean; endCursor: string }; nodes: LinearIssue[] } };
          errors?: unknown;
        };
        if (!json.data) throw new Error(`Linear issues: ${JSON.stringify(json.errors)}`);
        out.push(...json.data.issues.nodes);
        after = json.data.issues.pageInfo.hasNextPage ? json.data.issues.pageInfo.endCursor : null;
      } while (after);
      return out;
    },
    true,
  );
  return all.filter((i) => inScope(i, referenced));
}

const PLANNED = /^(todo|in progress|in review)$/i;

/**
 * The placeholder Issues sub-view of an issue, kept when the classifier (classify.ts) is skipped or fails: Megan's
 * list → needs clarification (her verdict), planned or started work → ready, everything else unclassified.
 */
export function classify(
  state: { name: string; type?: string },
  megan?: Pick<Issue, "verdict">,
): { classification: Classification; classificationReason?: string } {
  if (megan)
    return { classification: "needs-clarification", classificationReason: megan.verdict === "partial" ? "Manual: partial" : "Not in manual" };
  if (state.type === "unstarted" || state.type === "started" || PLANNED.test(state.name))
    return { classification: "ready", classificationReason: "already planned" };
  return { classification: "unclassified" };
}

const day = (v?: string) => (v ? v.slice(0, 10) : "");

/** A loop issue as a review item: fields and Slack refs from its title, description and comments; group from the first two. */
export function issueItem(issue: LinearIssue, manual: ManualIndex | null = loadManual()): Item {
  const description = issue.description ?? "";
  const text = [issue.title, description, ...issue.comments.nodes.map((c) => c.body)].join("\n");
  const keys = fieldKeys(text);
  return {
    id: issue.identifier,
    title: issue.title,
    origin: { kind: "issue", url: issue.url, state: issue.state.name, stateType: issue.state.type, updatedAt: issue.updatedAt },
    // Comments mention codes in passing; the issue's own title and description say what it's about.
    group: groupOf(fieldKeys(`${issue.title}\n${description}`), issue.title),
    linear: [issue.identifier],
    slack: slackRefs(text),
    fields: fieldPredicate(keys),
    badges: [{ text: issue.state.name, kind: "info" }, ...labelsOf(issue).map((l) => ({ text: l, kind: "muted" }))],
    meta: [
      issue.assignee?.name ?? "unassigned",
      ...(issue.creator ? [`by ${issue.creator.name}`] : []),
      ...(issue.createdAt ? [`created ${day(issue.createdAt)}`] : []),
      ...(issue.updatedAt ? [`updated ${day(issue.updatedAt)}`] : []),
    ],
    panel: {
      blocks: [
        ...manualBlock(`${issue.title}\n${description}`, [], manual),
        ...(description ? [{ cls: "what", title: "📄 Issue", text: description.length > 600 ? `${description.slice(0, 600)}…` : description }] : []),
      ],
      placeholder: "Why this classification, next step, owner…",
    },
    text,
    ...classify(issue.state),
  };
}

/** Megan's data on her issue's item: manual summary, questions, verdict, curated SQL predicate and group. */
export function withMegan(item: Item, issue: Issue): Item {
  const megan = meganItem(issue);
  return {
    ...item,
    group: issue.group,
    fields: issue.fields,
    verdict: issue.verdict,
    badges: [...megan.badges, ...item.badges],
    meta: [...item.meta, ...(issue.related ? [`related ${issue.related.join(", ")}`] : [])],
    panel: {
      blocks: [...megan.panel.blocks, ...item.panel.blocks.filter((b) => b.cls !== "manual")],
      questions: megan.panel.questions,
      placeholder: megan.panel.placeholder,
    },
    ...classify({ name: "" }, issue),
  };
}

/**
 * The Issues tab's items: one per loop issue, Megan's merged onto hers. Her issues the query didn't return (e.g.
 * done) come from `meganLinear` (loaded by id); one Linear couldn't load at all keeps her own page.
 */
export function issueItems(
  loop: LinearIssue[],
  megan: Issue[],
  meganLinear: Map<string, LinearIssue | undefined>,
  manual: ManualIndex | null = loadManual(),
): Item[] {
  const byId = new Map(megan.map((m) => [m.id, m]));
  const items = loop.map((l) => issueItem(l, manual));
  const have = new Set(items.map((i) => i.id));
  for (const m of megan) {
    if (have.has(m.id)) continue;
    const linear = meganLinear.get(m.id);
    items.push(
      linear
        ? issueItem(linear, manual)
        : { ...meganItem(m), origin: { kind: "issue", url: "", state: "unknown" }, badges: [], panel: { blocks: [], placeholder: "" } },
    );
  }
  return items.map((i) => (byId.has(i.id) ? withMegan(i, byId.get(i.id)!) : i));
}

/**
 * Whether an issue's Slack threads and visits are refetched this run: it's on an agenda since the last meeting, or
 * Linear changed it since the copy we gathered last (`seen`: id → updatedAt).
 */
export function issueFresh(item: Pick<Item, "id" | "origin">, seen: Record<string, string>, onAgenda: Set<string>): boolean {
  if (item.origin.kind !== "issue") return false;
  return onAgenda.has(item.id) || (!!item.origin.updatedAt && seen[item.id] !== item.origin.updatedAt);
}
