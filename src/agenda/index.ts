import { processReviewBuild, queueReviewBuild } from "../review/daily.js";
import { decisionContext, flushReviewOutbox, loadReviewDecisions, loadReviewRejections, reviewConfigured, publishReview, publishedPack } from "../review/publish.js";
import { agendaItem, hubId, parseAgendaHtml } from "../review/items.js";
import fs from "node:fs";
import path from "node:path";
import type { WebClient } from "@slack/web-api";
import type { Config } from "../config.js";
import { manualItems, oasisCodes } from "../manual/codes.js";
import { loadManual } from "../manual/lookup.js";
import { cardCms, describeNotes, manualNotes, type ManualNote } from "../manual/notes.js";
import { collectConversations, type Conversation } from "./collect.js";
import { isTriageOnly, triageReview, triageSection, type TriageCard } from "../review/linear-review.js";
import { agendaTitle, isReviewComment, issuesFor, LinearClient, sourceFooter, type LinkedIssue } from "./linear.js";
import { describeRejected, loadRejectedFields, type RejectedExport } from "./rejected.js";
import { renderAgenda, type AgendaItem } from "./render.js";
import {
  loadAgendaCards,
  loadCarryover,
  loadLastNotes,
  saveCarryover,
  type CarriedCard,
  type SyncPayload,
} from "./sync.js";
import { SECTIONS, triageConversations, type TriageItem } from "./triage.js";

// Same lookback the collector uses for threads that get new replies; issues citing them are at least this recent.
const LINEAR_LOOKBACK_MS = 8 * 24 * 3600 * 1000;
// A missed slot (the bot was down) is still worth running shortly after, but not late in the day:
// running in the evening would eat the window that the next morning's agenda needs.
const LATE_RUN_GRACE_MINUTES = 3 * 60;
const DEFAULT_WINDOW_MS = 24 * 3600 * 1000;
// Manual items summarized for one triage (each note is ~0.5–1k chars, see describeNotes for the size cap).
const MAX_MANUAL_ITEMS = 25;

export interface AgendaState {
  /** Start of the last scheduled window, so a manual rebuild later that day can cover it again. */
  lastSince?: string;
  /** End of the last scheduled window; the next one starts here. */
  lastUntil?: string;
  /** Local date (YYYY-MM-DD) of the last scheduled attempt, successful or not. */
  lastAttemptDate?: string;
}

export interface AgendaResult {
  file: string;
  items: number;
  created: LinkedIssue[];
}

export class DailyAgenda {
  private readonly stateFile: string;
  private readonly linear: LinearClient;
  private running?: Promise<AgendaResult>;

  constructor(
    private readonly config: Config,
    private readonly client: WebClient,
    private readonly triage: typeof triageConversations = triageConversations,
  ) {
    this.stateFile = path.join(config.DATA_DIR, "agenda", "state.json");
    this.linear = new LinearClient(config.LINEAR_API_KEY ?? "", config.LINEAR_TEAM_KEY);
  }

  get enabled(): boolean {
    return this.config.AGENDA_CHANNELS.length > 0 && Boolean(this.config.LINEAR_API_KEY);
  }

  private get recipient(): string {
    return this.config.AGENDA_RECIPIENT_ID ?? this.config.ALLOWED_SLACK_USER_IDS[0]!;
  }

  /** Checks once a minute; runs on weekdays at AGENDA_TIME (local), once per day. */
  start(): void {
    if (!this.enabled) return;
    const flushReviews = () => { void flushReviewOutbox(this.config).catch(() => console.warn('[review] publish pending; will retry in five minutes')); };
    flushReviews();
    setInterval(flushReviews,5 * 60_000);
    const resumeReview = () => { void processReviewBuild(this.config).catch(() => console.warn('[review] build pending; will retry')); };
    resumeReview();setInterval(resumeReview,5 * 60_000);
    const tick = () => this.tick().catch((error) => console.error("[agenda] scheduler tick failed", error));
    setInterval(tick, 60_000);
    void tick();
    console.log(`[agenda] scheduled weekdays at ${this.config.AGENDA_TIME} ${this.config.AGENDA_TIMEZONE}${this.linear.dryRun ? " (Linear dry run: no writes)" : ""}`);
  }

  private async tick(): Promise<void> {
    const now = localParts(new Date(), this.config.AGENDA_TIMEZONE);
    const [hour, minute] = this.config.AGENDA_TIME.split(":").map(Number);
    const minutesLate = now.hour * 60 + now.minute - (hour! * 60 + minute!);
    const state = this.readState();
    if (now.weekday === 0 || now.weekday === 6) return;
    if (minutesLate < 0 || minutesLate > LATE_RUN_GRACE_MINUTES) return;
    if (state.lastAttemptDate === now.date || this.running) return;

    this.writeState({ ...state, lastAttemptDate: now.date });
    const until = new Date();
    const since = nextWindowStart(state, until, this.config.AGENDA_BACKFILL_SINCE);
    try {
      await this.run({ since, until });
      // Only a successful run moves the window, so a failed day is picked up by the next one.
      this.writeState({ lastAttemptDate: now.date, lastSince: since.toISOString(), lastUntil: until.toISOString() });
    } catch (error) {
      console.error("[agenda] scheduled run failed", error);
      await this.client.chat
        .postMessage({
          channel: this.recipient,
          text: `I couldn't build today's agenda: \`${error instanceof Error ? error.message : String(error)}\`. DM me \`agenda\` to retry.`,
        })
        .catch(() => {});
    }
  }

  /**
   * Builds the agenda on demand (DM `agenda`), over the window manualWindow picks.
   * It files missing Linear issues but doesn't move the window, so the scheduled agenda stays complete.
   */
  runNow(window?: { since: Date; until: Date }): Promise<AgendaResult> {
    const { AGENDA_TIMEZONE, AGENDA_BACKFILL_SINCE } = this.config;
    return this.run(window ?? manualWindow(this.readState(), new Date(), AGENDA_TIMEZONE, AGENDA_BACKFILL_SINCE));
  }

  private run(window: { since: Date; until: Date }): Promise<AgendaResult> {
    this.running ??= this.build(window).finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  private async build({ since, until }: { since: Date; until: Date }): Promise<AgendaResult> {
    const date = localParts(until, this.config.AGENDA_TIMEZONE).date;
    const dir = path.join(this.config.DATA_DIR, "agenda", date);
    fs.mkdirSync(dir, { recursive: true });
    console.log(`[agenda] building ${date}: ${since.toISOString()} → ${until.toISOString()}`);

    const { conversations, missingChannels } = await collectConversations(this.client, {
      channels: this.config.AGENDA_CHANNELS,
      internalUserIds: this.config.AGENDA_INTERNAL_USER_IDS,
      since,
      until,
    });
    const tracked = await this.linear.trackedSlackMessages(new Date(since.getTime() - LINEAR_LOOKBACK_MS));
    const trackedIn = new Map(conversations.map((c) => [c.id, issuesFor(c, tracked)]));
    const byId = new Map(conversations.map((c) => [c.id, c]));
    const dmChannel = (await this.client.conversations.open({ users: this.recipient })).channel!.id!;
    const liveRejected = reviewConfigured(this.config) ? await loadReviewRejections(this.config,since,until).catch(() => null) : null;
    const rejected = liveRejected ?? await loadRejectedFields(this.client, {
      dmChannel,
      token: this.config.SLACK_BOT_TOKEN,
      since,
      until,
    }).catch((error): RejectedExport | null => {
      console.error("[agenda] couldn't load the rejected-fields export", error);
      return null;
    });

    const reviewWarnings: string[] = [];
    const decisions = await loadReviewDecisions(this.config).catch(() => {
      reviewWarnings.push("Couldn't load saved Lime review decisions; this run has no decision context.");
      return [];
    });
    const manual = loadManual();
    const notes = await this.manualNotes(conversations, rejected);
    const lastNotes = loadLastNotes(this.config.DATA_DIR, date);
    const carried = await this.refreshCarried(loadCarryover(this.config.DATA_DIR, date));

    const triage =
      conversations.length || rejected?.total
        ? await this.triage(
            this.config,
            {
              conversations,
              trackedIn,
              rejected: rejected?.total ? describeRejected(rejected.groups) : undefined,
              manual: notes.length ? describeNotes(notes) : undefined,
              lastNotes: lastNotes?.text,
              approvedDecisions: decisionContext(decisions),
              since,
              until,
            },
            { cwd: dir, signal: AbortSignal.timeout(45 * 60_000) },
          )
        : {
            overview: "No new messages from the service team in this window.",
            items: [],
            skipped: [],
            rejectedPatterns: [],
          };
    fs.writeFileSync(path.join(dir, "triage.json"), JSON.stringify(triage, null, 2));

    const created: LinkedIssue[] = [];
    const items: AgendaItem[] = [];
    const reviews: { issue: AgendaItem["issues"][number]; card: TriageCard }[] = [];
    for (const { linear, ...item } of triage.items) {
      const sources = item.conversationIds.map((id) => byId.get(id)).filter((c): c is Conversation => Boolean(c));
      const untracked = sources.filter((c) => !trackedIn.get(c.id)?.length);
      const issues = new Map<string, AgendaItem["issues"][number]>();
      for (const c of sources) for (const i of trackedIn.get(c.id) ?? []) issues.set(i.identifier, i);
      let linearNote: string | undefined;
      const cms = cardCms(item.cms, notes, manual);
      const card = triageCard(item, cms);

      try {
        if (linear.action === "create" && untracked.length) {
          const issue = await this.linear.createTriageIssue(
            agendaTitle(linear.title, date),
            `${linear.description}\n\n${triageSection(card)}\n\n${sourceFooter(untracked)}`,
          );
          issues.set(issue.identifier, { ...issue, isNew: true });
          created.push(issue);
        } else if (linear.action === "existing" && untracked.length) {
          await this.linear.comment(
            linear.identifier,
            `More reports of this from Slack:\n\n${sourceFooter(untracked)}`,
          );
          const issue = await this.linear.getIssue(linear.identifier);
          if (issue) issues.set(issue.identifier, issue);
        }
      } catch (error) {
        console.error(`[agenda] Linear update failed for ${item.id}`, error);
        linearNote = `⚠️ Couldn't update Linear: ${error instanceof Error ? error.message : String(error)}`;
      }
      for (const issue of issues.values()) reviews.push({ issue, card });
      items.push({ ...item, issues: [...issues.values()], linearNote, cms });
    }
    // Existing issues get the `[Agenda - date]` title and the triage review comment (new ones have both already).
    const titles = await reviewIssues(this.linear, date, reviews);
    for (const item of items) item.issues = item.issues.map((i) => ({ ...i, title: titles.get(i.identifier) ?? i.title }));

    // Anything Claude left out of both lists is shown as skipped, so a dropped conversation is still visible.
    const classified = new Set([
      ...triage.items.flatMap((i) => i.conversationIds),
      ...triage.skipped.map((s) => s.conversationId),
    ]);
    const skipped = [
      ...triage.skipped,
      ...conversations
        .filter((c) => !classified.has(c.id))
        .map((c) => ({ conversationId: c.id, reason: "⚠️ Not classified by the triage, please check" })),
    ].filter((s) => byId.has(s.conversationId));

    const warnings = missingChannels.length
      ? [`I'm not in these channels (add me or fix the name): ${missingChannels.map((c) => `#${c}`).join(", ")}`]
      : [];
    warnings.push(...reviewWarnings);
    const html = renderAgenda({
      date,
      since,
      until,
      timeZone: this.config.AGENDA_TIMEZONE,
      overview: triage.overview,
      items,
      skipped,
      conversations: byId,
      rejected,
      rejectedPatterns: triage.rejectedPatterns.map((p) => ({ ...p, cms: cardCms(p.cms, notes, manual) })),
      carried,
      lastNotes,
      warnings,
    });
    const file = path.join(dir, `nico-sync-${date}.html`);
    fs.writeFileSync(file, html);
    if (!rejected) warnings.push("No rejected-fields export yet: run `rejected-fields` in your terminal, then DM me `agenda`.");
    const parsed = parseAgendaHtml(html);
    const published = (parsed?.items ?? []).map(card => {
      const item = agendaItem(hubId(card.id,date), { card, first: card.carriedFrom ?? date, last: date });
      const record = publishedPack({ item, linear: [], threads: [], visits: [], errors: [] });
      // The scheduled bot has report text; production visit enrichment comes from the hub.
      delete record.evidence;
      record.detail.blocks.push({ title: 'Source reports', text: card.sources.map(s =>
        s.kind === 'slack' ? `${s.url}\n${s.messages.map(m => `${m.author}: ${m.text}`).join('\n')}` : JSON.stringify(s)).join('\n\n') });
      return record;
    });
    await publishReview(this.config, {
      id: `agenda:${date}:${since.toISOString()}:${until.toISOString()}`,
      observedAt: new Date().toISOString(), since: since.toISOString(), until: until.toISOString(),
      warnings: [...warnings, 'Visit evidence is enriched separately; see each item for its evidence timestamp.'], items: published,
    }).catch(() => warnings.push("Couldn't publish to Lime; saved to the local review outbox for retry."));
    await this.deliver(dmChannel, file, date, items.length, skipped.length, created, warnings);
    queueReviewBuild(this.config);
    return { file, items: items.length, created };
  }

  /** Manual notes for the OASIS items the conversations and rejections name; never fails the agenda. */
  private async manualNotes(conversations: Conversation[], rejected: RejectedExport | null): Promise<ManualNote[]> {
    try {
      const manual = loadManual();
      if (!manual) return [];
      const items = manualItems(manual, mentionedCodes(conversations, rejected)).slice(0, MAX_MANUAL_ITEMS);
      return await manualNotes(this.config, items.map((i) => i.code), { manual });
    } catch (error) {
      console.error("[agenda] couldn't load the manual notes", error);
      return [];
    }
  }

  /** Re-reads the carried items' Linear issues and drops items whose issues have all been closed since. */
  private async refreshCarried(items: CarriedCard[]) {
    const refreshed = await Promise.all(
      items.map(async (item) => ({
        ...item,
        issueDetails: (await Promise.all(item.issues.map((id) => this.linear.getIssue(id)))).filter(
          (i): i is LinkedIssue => Boolean(i),
        ),
      })),
    );
    const closed = (i: LinkedIssue) => i.stateType === "completed" || i.stateType === "canceled";
    return refreshed.filter((item) => !item.issueDetails.length || !item.issueDetails.every(closed));
  }

  /**
   * Stores the decisions pasted after a sync (the open items carry over to the next agenda) and returns the
   * instructions for Claude to turn them, plus the meeting notes, into Linear updates.
   */
  recordSync(payload: SyncPayload, message: string): { decided: number; carried: CarriedCard[]; prompt: string } {
    const carried = saveCarryover(this.config.DATA_DIR, payload);
    const cards = loadAgendaCards(this.config.DATA_DIR, payload.agenda);
    for (const card of payload.cards) if (!cards.has(card.id)) cards.set(card.id, card);
    const decided = payload.decided.map(({ id, note }) => {
      const card = cards.get(id);
      return {
        item: card?.title ?? id,
        decision: note || "(ticked as decided, no notes)",
        linearIssues: card?.issues ?? [],
        summary: card?.summary,
        proposalOnTheAgenda: card?.proposal,
      };
    });
    const prompt = `
Felipe just had his sync with Nico (agenda ${payload.agenda}). Below are the decisions he exported from the agenda.
The ${carried.length} undecided items are already saved and will carry over to the next agenda; nothing to do there.

Your job: turn the decisions into Linear updates.
1. If this message doesn't include the meeting notes yet (e.g. a Granola summary), ask Felipe to paste them in this
   thread, or say "skip". Wait for that before proposing anything.
2. When you have the notes (or he skips), call save_meeting_notes with agenda_date "${payload.agenda}" and a clean
   markdown version of the notes plus the decisions. They're shown on the next agenda and used as context.
3. Read each decided item's Linear issues, then propose the changes per issue in one short list: move it out of
   Triage (to which state), team/project, priority, assignee, labels, and a comment that records the decision
   ("Decided in the Nico sync on ${payload.agenda}: …" with the relevant context from the notes). Only propose what
   the decision or the notes support; if something is unclear, say so instead of guessing.
4. Change nothing in Linear until Felipe confirms. Then apply exactly what he approved and report what you did,
   with links. Never close or delete issues unless he explicitly says so.

Decided items:
${JSON.stringify(decided, null, 1)}

Felipe's message:
${message}
`.trim();
    return { decided: payload.decided.length, carried, prompt };
  }

  private async deliver(
    dmChannel: string,
    file: string,
    date: string,
    items: number,
    skipped: number,
    created: LinkedIssue[],
    warnings: string[],
  ) {
    const localFile = this.config.AGENDA_LOCAL_DIR
      ? ` It saves and opens file://${path.posix.join(this.config.AGENDA_LOCAL_DIR, path.basename(file))}`
      : "";
    const lines = [
      `📋 Agenda for today's sync with Nico: ${items} item${items === 1 ? "" : "s"}` +
        (skipped ? ` (${skipped} message${skipped === 1 ? "" : "s"} skipped as not issues).` : "."),
      created.length
        ? `Filed on Dotterino's behalf (Triage): ${created.map((i) => `<${i.url}|${i.identifier}>`).join(", ")}`
        : "Everything was already tracked in Linear 👌",
      ...warnings.map((w) => `⚠️ ${w}`),
      ...(this.config.LIME_REVIEW_WEB_URL ? [`Review and save decisions in Lime: ${this.config.LIME_REVIEW_WEB_URL}`] : []),
      `To open it, run \`agenda\` in your terminal (or download the file below).${localFile} Tick items as decided, then hit *Copy decisions for parcerito* and paste them here.`,
    ];
    await this.client.files.uploadV2({
      channel_id: dmChannel,
      file: fs.readFileSync(file),
      filename: path.basename(file),
      title: `Nico sync · ${date}`,
      initial_comment: lines.join("\n"),
    });
  }

  private readState(): AgendaState {
    return fs.existsSync(this.stateFile) ? JSON.parse(fs.readFileSync(this.stateFile, "utf8")) : {};
  }

  private writeState(state: AgendaState): void {
    fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
    fs.writeFileSync(this.stateFile, JSON.stringify(state, null, 2));
  }
}

/** What the triage review shows of a triage item. */
export function triageCard(item: Omit<TriageItem, "linear" | "cms">, cms?: TriageCard["cms"]): TriageCard {
  const { title, urgency, customers, summary, proposal } = item;
  return { title, section: SECTIONS[item.section], urgency, customers, summary, proposal, cms };
}

export type ReviewLinear = Pick<LinearClient, "ensureAgendaTitle" | "upsertComment">;

/**
 * For every open, already existing issue of the agenda's items: the `[Agenda - date]` title and ONE "Agenda review —
 * date" comment with the triage of every item pointing at it (updated in place; the local full review is kept).
 * New issues and closed ones are skipped; a failure is logged per issue. Returns the titles it ended up with.
 */
export async function reviewIssues(
  linear: ReviewLinear,
  date: string,
  reviews: { issue: LinkedIssue & { isNew?: boolean }; card: TriageCard }[],
): Promise<Map<string, string>> {
  const byIssue = new Map<string, { issue: LinkedIssue & { isNew?: boolean }; cards: TriageCard[] }>();
  for (const { issue, card } of reviews) {
    const entry = byIssue.get(issue.identifier) ?? { issue, cards: [] };
    if (!entry.cards.includes(card)) entry.cards.push(card);
    byIssue.set(issue.identifier, entry);
  }
  const titles = new Map<string, string>();
  for (const [id, { issue, cards }] of byIssue) {
    if (issue.isNew || ["completed", "canceled", "duplicate"].includes(issue.stateType ?? "")) continue;
    try {
      titles.set(id, (await linear.ensureAgendaTitle(id, date)).title);
      await linear.upsertComment(id, triageReview(date, cards), (b) => isReviewComment(b, date), (b) => !isTriageOnly(b));
    } catch (error) {
      console.error(`[agenda] couldn't add the agenda review to ${id}`, error);
    }
  }
  return titles;
}

/** OASIS codes and form keys the conversations and rejected rows name, most mentioned first. */
export function mentionedCodes(conversations: Conversation[], rejected: RejectedExport | null): string[] {
  const counts = new Map<string, number>();
  const add = (key: string, n = 1) => counts.set(key, (counts.get(key) ?? 0) + n);
  for (const c of conversations) for (const m of c.messages) for (const code of oasisCodes(m.text)) add(code);
  for (const g of rejected?.groups ?? []) add(g.fieldKey, g.rows.length);
  return [...counts].sort((a, b) => b[1] - a[1]).map(([key]) => key);
}

function nextWindowStart(state: AgendaState, until: Date, backfillSince?: string): Date {
  if (state.lastUntil) return new Date(state.lastUntil);
  if (backfillSince) return new Date(backfillSince);
  return new Date(until.getTime() - DEFAULT_WINDOW_MS);
}

/**
 * The window a manual `agenda` covers. Once today's scheduled agenda has run, it rebuilds that same window, so a
 * late input (the rejected-fields export usually arrives after the scheduled run) lands in today's agenda instead
 * of a near-empty window starting at the scheduled time. Before that, it previews the next scheduled window.
 */
export function manualWindow(state: AgendaState, now: Date, timeZone: string, backfillSince?: string) {
  if (state.lastUntil) {
    const until = new Date(state.lastUntil);
    if (localParts(until, timeZone).date === localParts(now, timeZone).date) {
      // State written before lastSince existed: assume the default window.
      const since = state.lastSince ? new Date(state.lastSince) : new Date(until.getTime() - DEFAULT_WINDOW_MS);
      return { since, until };
    }
  }
  return { since: nextWindowStart(state, now, backfillSince), until: now };
}

/** Wall-clock date, weekday (0 = Sunday) and time in a time zone. */
export function localParts(date: Date, timeZone: string) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(date)
      .map((p) => [p.type, p.value]),
  );
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    weekday: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(parts.weekday!),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
  };
}
