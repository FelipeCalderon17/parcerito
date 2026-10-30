/**
 * The "Agenda review — date" comment parcerito keeps on each agenda issue in Linear: what the review hub shows for it
 * (triage, classification, docs brief, questions, duplicates, Slack reports, rejected rows and the visits with the
 * AI's values and evidence) as compact markdown, newest first. The Railway agenda posts the triage-only version
 * (triageReview); the local `npm run agenda` replaces it with the full one (reviewMarkdown), same marker.
 */
import type { AgendaCard } from "../agenda/render.js";
import { isReviewComment, reviewHeading, reviewMarker, withRevision, type LinearClient } from "../agenda/linear.js";
import { pageRange, type CardCms } from "../manual/notes.js";
import type { DuplicatePair } from "./duplicates.js";
import { CLASSES, KINDS, VERDICTS } from "./hub.js";
import { topicOf } from "./queries.js";
import { MAX_THREADS, MAX_VISITS, newestFirst, newestThreads, newestVisits, stepStatus } from "./render.js";
import type { DbRow, Pack, VisitData } from "./types.js";

/** Comment size cap (chars), well under Linear's limits and still readable. */
export const MAX_COMMENT = 60_000;
const MAX_ROWS = 15;
const MAX_EVIDENCE = 3;
const MAX_SEEN = 3;
const CMS_VERDICT = { covered: "Covered by the manual", partial: "Manual: partial", "not-in-manual": "Not in manual" } as const;

/** What a triage section needs from an agenda card (or the Railway triage item). */
export type TriageCard = Pick<AgendaCard, "title" | "section" | "urgency" | "customers" | "summary" | "proposal" | "date" | "people"> & {
  cms?: Pick<CardCms, "verdict" | "answer"> & { codes: Pick<CardCms["codes"][number], "code" | "title" | "pages">[] };
};

type Row = Record<string, any>;
const rows = (v: unknown) => (Array.isArray(v) ? v : []) as Row[];

/** One line of text: whitespace collapsed, JSON for non-strings, clipped with an ellipsis; "—" when empty. */
export function inline(v: unknown, max = 200): string {
  if (v === null || v === undefined || v === "") return "—";
  const text = (typeof v === "string" ? v : JSON.stringify(v)).replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

const code = (v: unknown, max = 80) => `\`${inline(v, max).replace(/`/g, "'")}\``;
const cell = (v: unknown, max = 80) => inline(v, max).replace(/\|/g, "\\|");
const person = (v: unknown) => String(v ?? "").replace(/\s*<[^>]*>$/, "").trim();
const day = (v: unknown) => (v ? String(v).slice(0, 10) : "");
const slackDay = (ts: string) => new Date(Number(ts) * 1000).toISOString().slice(0, 10);
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

// ---------- Triage (Railway + local) ----------

/** The triage-side section of one agenda card: summary, proposal, CMS verdict/answer. */
export function triageSection(card: TriageCard, firstSeen?: string): string {
  const meta = [
    card.section,
    card.urgency && `${card.urgency} urgency`,
    card.customers?.length && card.customers.join(", "),
    card.date,
    firstSeen && `first on the agenda ${firstSeen}`,
    ...(card.people ?? []).filter((p) => p.names.length).map((p) => `${p.label}: ${p.names.join(", ")}`),
  ].filter(Boolean);
  const cms = card.cms;
  const cmsLine = cms?.verdict || cms?.answer
    ? `**CMS manual:** ${[cms.verdict && CMS_VERDICT[cms.verdict], cms.answer].filter(Boolean).join(" — ")}` +
      (cms.codes.length ? ` (${cms.codes.map((c) => `${c.code} ${pageRange(c.pages)}`).join(", ")})` : "")
    : "";
  return [
    `### Triage — ${inline(card.title, 160)}`,
    meta.length ? `_${meta.join(" · ")}_` : "",
    card.summary ? `**What happened:** ${clip(card.summary.trim(), 1_500)}` : "",
    card.proposal ? `**Proposal:** ${clip(card.proposal.trim(), 1_500)}` : "",
    cmsLine,
  ]
    .filter(Boolean)
    .join("\n\n");
}

const header = (date: string) => `${reviewHeading(date)}\n${reviewMarker(date)}`;

/** Closes the Railway (triage-only) version; a comment without it is the local full review. */
export const TRIAGE_ONLY_NOTE = "_The full review (classification, docs, visits) is added by the local agenda run._";
/** Whether a stored comment is the triage-only version (plain words, in case Linear reformats the italics). */
export const isTriageOnly = (body: string) => body.includes("is added by the local agenda run");

/** The Railway version of the review comment: the triage of each agenda card that points at the issue. */
export function triageReview(date: string, cards: TriageCard[]): string {
  return withRevision([header(date), ...cards.map((c) => triageSection(c)), TRIAGE_ONLY_NOTE].join("\n\n"));
}

// ---------- Full review (local) ----------

export interface ReviewContext {
  issueId: string;
  /** The agenda date the review is for. */
  date: string;
  /** The newest agenda's cards that point at the issue, with the date each was first on an agenda. */
  cards: { card: AgendaCard; firstSeen?: string }[];
  duplicates?: DuplicatePair[];
  /** Comment cap; defaults to MAX_COMMENT. */
  cap?: number;
}

/** The classifier's conclusion on the issue item: class, kind, manual verdict, reason, next step. */
function classification(issue: Pack | undefined): string {
  const item = issue?.item;
  if (!item?.classification) return "";
  const t = item.triage;
  const pills = [CLASSES[item.classification], t && KINDS[t.kind], t && VERDICTS[t.manualVerdict][0]].filter(Boolean).join(" · ");
  return [
    "### Classification",
    `**${pills}**`,
    item.classificationReason ? clip(item.classificationReason, 1_200) : "",
    t?.nextStep ? `**Next step:** ${clip(t.nextStep, 800)}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** "What the docs say": the brief (or manual block) with its manual pages and agency-pref sections. */
function docs(packs: Pack[]): string {
  const block = packs.map((p) => p.item.panel.blocks.find((b) => b.title.startsWith("📘"))).find(Boolean);
  if (!block) return "";
  return `### What the docs say\n\n${clip(block.text.trim(), 3_000)}`;
}

/** Questions to resolve (classifier/Megan/topics, ≤5 after condensing), else the agenda card's checklist. */
function questions(issue: Pack | undefined, agenda: Pack[]): string {
  const t = issue?.item.triage;
  const own = t?.classification === "needs-clarification" ? t.questions : issue?.item.panel.questions?.items;
  if (own?.length) return `### Questions to resolve\n\n${own.map((q, i) => `${i + 1}. ${inline(q, 500)}`).join("\n")}`;
  const checklist = [...new Set(agenda.flatMap((p) => p.item.panel.questions?.items ?? []))];
  return checklist.length ? `### Checklist\n\n${checklist.slice(0, 8).map((q) => `- ${inline(q, 300)}`).join("\n")}` : "";
}

function duplicates(issueId: string, pairs: DuplicatePair[] = []): string {
  const mine = pairs.filter((p) => p.a === issueId || p.b === issueId);
  if (!mine.length) return "";
  return `### Possible duplicates\n\n${mine.map((p) => `- ${p.a === issueId ? p.b : p.a} (${p.confidence}: ${inline(p.why, 240)})`).join("\n")}`;
}

/** Slack reports: newest thread first, each with its first author, date and permalink. */
function reports(packs: Pack[]): string {
  const threads = newestThreads([...new Map(packs.flatMap((p) => p.threads).map((t) => [t.link, t])).values()]);
  if (!threads.length) return "";
  const lines = threads.slice(0, MAX_THREADS).map((t) => {
    const first = [...t.messages].sort((a, b) => a.ts.localeCompare(b.ts))[0];
    if (!first) return `- [Slack thread](${t.link})${t.error ? ` — couldn't read it (${inline(t.error, 80)})` : ""}`;
    const replies = t.messages.length - 1;
    return `- [${slackDay(first.ts)} · ${inline(first.author, 60)}](${first.permalink}): ${inline(first.text, 220)}${replies ? ` _(+${replies} repl${replies === 1 ? "y" : "ies"})_` : ""}`;
  });
  const hidden = threads.length - MAX_THREADS;
  return `### Slack reports (${threads.length})\n\n${lines.join("\n")}${hidden > 0 ? `\n- +${hidden} older thread${hidden === 1 ? "" : "s"}` : ""}`;
}

/** The rejected-suggestion rows behind the agenda cards, newest first. */
function rejectedRows(list: DbRow[]): string {
  if (!list.length) return "";
  const sorted = newestFirst([...new Map(list.map((r) => [r.id, r])).values()], (r) => r.decidedAt);
  const body = sorted.slice(0, MAX_ROWS).map(
    (r) =>
      `| ${code(r.field, 60)} ${cell(r.form, 40)}${r.customer ? ` · ${cell(r.customer, 30)}` : ""} | ${cell(r.aiValue)} → ${cell(r.coderValue)} (${cell(r.how, 20)}) | ${r.reason ? cell(r.reason, 160) : "none"} | ${cell(r.decidedBy ?? "", 40)} ${day(r.decidedAt)} | ${r.appLink ? `[${day(r.visitDate) || "chart"}](${r.appLink})` : day(r.visitDate)} |`,
  );
  const hidden = sorted.length - MAX_ROWS;
  return [
    `### Rejected AI suggestions (${sorted.length})`,
    "",
    "| Field | AI → coder | Reason | Decided by | Visit |",
    "| --- | --- | --- | --- | --- |",
    ...body,
    ...(hidden > 0 ? ["", `+${hidden} older rows`] : []),
  ].join("\n");
}

/** One cited evidence passage: audio timestamp / document page, and the quote. */
function evidenceLine(e: Row): string {
  const src =
    e.type === "audio"
      ? `🎙 ${e.at ?? ""}${e.speaker ? ` ${e.speaker}` : ""}`
      : e.type === "document"
        ? `📄 ${e.document ?? "Document"}${e.page ? ` p.${e.page}` : ""}`
        : e.type === "photo"
          ? "📷 photo"
          : String(e.type ?? "source");
  return `  - ${inline(src, 80)}: "${inline(e.snippet || e.text, 240)}"`;
}

/** The passage around the first topic match of a "what the AI saw" unit. */
function seenExcerpt(text: string, pattern: string | undefined): string {
  const at = pattern ? text.search(new RegExp(pattern, "i")) : -1;
  if (at < 0) return inline(text, 240);
  const from = Math.max(0, at - 110);
  return `${from > 0 ? "…" : ""}${inline(text.slice(from, at + 130), 260)}`;
}

/** One AI suggestion: AI value → final answer, decision, decided by, reason, then its cited evidence. */
function fieldLines(f: Row): string[] {
  const answers = rows(f.answers);
  const final = answers.at(-1);
  const via = f.accepted_via ?? f.rejected_via;
  const by = person(f.decided_by);
  const head = [
    `- ${code(f.key, 60)} ${inline(f.label, 80)}: AI ${code(f.ai_value)} → final ${final ? code(final.value) : "blank"}`,
    `**${f.decision ?? "pending"}**${via ? ` (${via})` : ""}${by ? ` by ${by}` : ""}${f.decided_at ? ` ${day(f.decided_at)}` : ""}`,
    f.decision === "rejected" ? `reason: ${f.rejection_reason ? inline(f.rejection_reason, 200) : "none"}` : "",
    answers.some((a) => a.push_error) ? `push error: ${inline(answers.find((a) => a.push_error)!.push_error, 160)}` : "",
  ].filter(Boolean);
  const evidence = rows(f.evidence);
  return [
    head.join(" · "),
    ...rows(f.feedback).map((fb) => `  - 💬 ${person(fb.by)}: ${inline(fb.message, 240)}`),
    ...evidence.slice(0, MAX_EVIDENCE).map(evidenceLine),
    ...(evidence.length > MAX_EVIDENCE ? [`  - +${evidence.length - MAX_EVIDENCE} more citations`] : []),
    ...(!evidence.length ? ["  - no citations"] : []),
  ];
}

/** A field with no AI suggestion: why, the final answer, and the top passages on its topic the AI was shown. */
function noSuggestionLines(u: Row, steps: Row[], seen: Row[]): string[] {
  const [status] = stepStatus(steps.at(-1));
  const final = rows(u.answers).at(-1);
  const pattern = topicOf(String(u.key ?? ""));
  const hits = [...new Map(seen.map((s) => [String(s.text ?? "").trim(), s])).values()].filter((s) => !pattern || new RegExp(pattern, "i").test(s.text ?? ""));
  return [
    `- ${code(u.key, 60)} ${inline(u.label, 80)}: no AI suggestion (**${status}**, ${steps.length} prompt${steps.length === 1 ? "" : "s"}) → final ${final ? `${code(final.value)}${final.by ? ` by ${person(final.by)}` : ""}` : "blank"}`,
    ...rows(u.feedback).map((fb) => `  - 💬 ${person(fb.by)}: ${inline(fb.message, 240)}`),
    ...(steps.length && !hits.length ? ["  - the evidence the AI was given says nothing about this item"] : []),
    ...hits.slice(0, MAX_SEEN).map((s) => `  - saw ${s.type === "audio" ? `🎙 ${s.at ?? ""}` : `📄 ${inline(s.document ?? "document", 60)}${s.page ? ` p.${s.page}` : ""}`}: "${seenExcerpt(String(s.text ?? ""), pattern)}"`),
    ...(hits.length > MAX_SEEN ? [`  - +${hits.length - MAX_SEEN} more passages`] : []),
  ];
}

/** A visit as a heading plus one block (list of lines) per relevant field, newest suggestion first. */
export function visitBlocks(v: VisitData): { head: string; fields: string[][] } {
  const t = rows(v.data.task)[0] ?? {};
  const fields = rows(v.data.fields);
  const unanswered = rows(v.data.unanswered);
  const steps = rows(v.data.no_suggestion_steps);
  const seen = rows(v.data.seen_evidence);
  const other = rows(v.data.other_rejections);
  const tally = [
    `${fields.length} AI suggestion${fields.length === 1 ? "" : "s"}`,
    `${fields.filter((f) => f.decision === "rejected").length} rejected`,
    `${unanswered.length} with no suggestion`,
    other.length ? `${other.length} other rejection${other.length === 1 ? "" : "s"} on this visit` : "",
    ...["task", "fields", "unanswered"].filter((k) => (v.data[k] as { error?: string } | undefined)?.error).map((k) => `⚠️ ${k} query failed`),
  ].filter(Boolean);
  const title = [day(t.visit_date) || "no visit date", t.organization, t.form ?? t.task_name, person(t.clinician)].filter(Boolean).map((x) => inline(x, 80));
  return {
    head: `#### ${title.join(" · ")}${t.app_link ? ` — [chart](${t.app_link})` : ""}\n_${tally.join(" · ")}_`,
    fields: [
      ...newestFirst(fields, (f) => f.created_at).map(fieldLines),
      ...unanswered.map((u) => noSuggestionLines(u, steps.filter((s) => s.key === u.key), seen.filter((s) => s.key === u.key))),
    ],
  };
}

/**
 * The visits section within `budget` chars: newest visit first (max MAX_VISITS), fields added until the budget runs
 * out, then one "+N more" line for what didn't fit.
 */
export function visitsSection(visits: VisitData[], budget: number): string {
  const unique = newestVisits([...new Map(visits.map((v) => [v.task, v])).values()]);
  if (!unique.length) return "";
  const shown = unique.slice(0, MAX_VISITS);
  const out = [`### Visits (${unique.length}, newest first)`];
  let used = out[0]!.length;
  let hiddenFields = 0;
  let hiddenVisits = unique.length - shown.length;
  for (const [i, v] of shown.entries()) {
    const { head, fields } = visitBlocks(v);
    if (used + head.length + 2 > budget) {
      hiddenVisits += shown.length - i;
      break;
    }
    out.push(head);
    used += head.length + 2;
    for (const [j, lines] of fields.entries()) {
      const text = lines.join("\n");
      if (used + text.length + 1 > budget) {
        hiddenFields += fields.length - j;
        break;
      }
      out.push(text);
      used += text.length + 1;
    }
  }
  const more = [hiddenVisits && `${hiddenVisits} older visit${hiddenVisits === 1 ? "" : "s"}`, hiddenFields && `${hiddenFields} field${hiddenFields === 1 ? "" : "s"}`].filter(Boolean);
  if (more.length) out.push(`_+${more.join(" and ")} not shown (see the local review hub)._`);
  return out.join("\n\n").replace(/\n\n(  - |- )/g, "\n$1");
}

/**
 * The visits a review shows: the issue's own plus those of agenda items about it alone. An umbrella agenda item
 * (pointing at several issues) queried every issue's fields, so its visits only count when the issue has none.
 */
export function reviewVisits(agenda: Pack[], issue: Pack | undefined): VisitData[] {
  const own = [...(issue?.visits ?? []), ...agenda.filter((p) => p.item.linear.length <= 1).flatMap((p) => p.visits)];
  return own.length ? own : agenda.flatMap((p) => p.visits);
}

/**
 * The full review comment of one Linear issue on an agenda: `packs` are the agenda items pointing at it plus the
 * issue's own pack (classification, questions), when it has one. Stays under `ctx.cap` by trimming visits.
 */
export function reviewMarkdown(packs: Pack[], ctx: ReviewContext): string {
  const agenda = packs.filter((p) => p.item.origin.kind === "agenda");
  const issue = packs.find((p) => p.item.origin.kind === "issue" && p.item.id === ctx.issueId);
  const cap = ctx.cap ?? MAX_COMMENT;
  const fixed = [
    header(ctx.date),
    ...ctx.cards.map(({ card, firstSeen }) => triageSection(card, firstSeen)),
    classification(issue),
    docs([...(issue ? [issue] : []), ...agenda]),
    questions(issue, agenda),
    duplicates(ctx.issueId, ctx.duplicates),
    reports(packs),
    rejectedRows(agenda.flatMap((p) => p.item.rows ?? [])),
  ]
    .filter(Boolean)
    .join("\n\n");
  // The footer (rev stamp) and joins take ~60 chars; a too-long fixed part is cut rather than overflowing the cap.
  const head = clip(fixed, cap - 200);
  const visits = visitsSection(reviewVisits(agenda, issue), cap - head.length - 120);
  return withRevision([head, visits].filter(Boolean).join("\n\n"));
}

// ---------- Sync (local) ----------

/** One issue on the newest agenda: the packs about it (agenda items + its own) and the cards pointing at it. */
export interface ReviewTarget {
  issueId: string;
  packs: Pack[];
  cards: ReviewContext["cards"];
}

const CLOSED = /^(done|canceled|cancelled|duplicate)$/i;

/**
 * Every open Linear issue the newest agenda's items point at, with its packs. Issues Linear lists as closed are
 * left alone.
 */
export function reviewTargets(packs: Pack[], newest: string, cards: Map<string, AgendaCard>): ReviewTarget[] {
  const agenda = packs.filter((p) => p.item.origin.kind === "agenda" && p.item.origin.agenda === newest && p.item.linear.length);
  const ids = [...new Set(agenda.flatMap((p) => p.item.linear))];
  return ids.flatMap((issueId) => {
    const about = agenda.filter((p) => p.item.linear.includes(issueId));
    const own = packs.find((p) => p.item.origin.kind === "issue" && p.item.id === issueId);
    const linear = [...about, ...(own ? [own] : [])].flatMap((p) => p.linear).find((l) => l.identifier === issueId);
    if (linear && CLOSED.test(linear.state.name)) return [];
    return [
      {
        issueId,
        packs: [...about, ...(own ? [own] : [])],
        cards: about.flatMap((p) => {
          const card = cards.get(p.item.id);
          return card ? [{ card, firstSeen: p.item.origin.kind === "agenda" ? p.item.origin.date : undefined }] : [];
        }),
      },
    ];
  });
}

export type ReviewWriter = Pick<LinearClient, "ensureAgendaTitle" | "upsertComment" | "dryRun">;

/**
 * Puts the `[Agenda - date]` title and the full "Agenda review — date" comment on every target (replacing Railway's
 * triage-only one, same marker), printing one line per issue. `onBody` sees each rendered comment (dry-run files).
 */
export async function syncReviews(
  linear: ReviewWriter,
  targets: ReviewTarget[],
  opts: { date: string; duplicates?: DuplicatePair[]; log?: (line: string) => void; onBody?: (issueId: string, body: string) => void },
): Promise<{ renamed: number; written: number; unchanged: number; failed: number }> {
  const log = opts.log ?? console.log;
  const tally = { renamed: 0, written: 0, unchanged: 0, failed: 0 };
  const dry = linear.dryRun ? " (dry run)" : "";
  for (const t of targets) {
    try {
      const body = reviewMarkdown(t.packs, { issueId: t.issueId, date: opts.date, cards: t.cards, duplicates: opts.duplicates });
      opts.onBody?.(t.issueId, body);
      const { changed } = await linear.ensureAgendaTitle(t.issueId, opts.date);
      const result = await linear.upsertComment(t.issueId, body, (b) => isReviewComment(b, opts.date));
      if (changed) tally.renamed++;
      if (result === "unchanged") tally.unchanged++;
      else tally.written++;
      log(`✓ ${t.issueId}${changed ? " renamed +" : ""} review ${result}${dry} (${body.length.toLocaleString("en-US")} chars)`);
    } catch (error) {
      tally.failed++;
      log(`✗ ${t.issueId}: ${error instanceof Error ? error.message : error}`);
    }
  }
  return tally;
}
