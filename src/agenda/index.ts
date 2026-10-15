import fs from "node:fs";
import path from "node:path";
import type { WebClient } from "@slack/web-api";
import type { Config } from "../config.js";
import { collectConversations, type Conversation } from "./collect.js";
import { issuesFor, LinearClient, sourceFooter, type LinkedIssue } from "./linear.js";
import { describeRejected, loadRejectedFields, type RejectedExport } from "./rejected.js";
import { renderAgenda, type AgendaItem } from "./render.js";
import { triageConversations } from "./triage.js";

// Same lookback the collector uses for threads that get new replies; issues citing them are at least this recent.
const LINEAR_LOOKBACK_MS = 8 * 24 * 3600 * 1000;
// A missed slot (the bot was down) is still worth running shortly after, but not late in the day:
// running in the evening would eat the window that the next morning's agenda needs.
const LATE_RUN_GRACE_MINUTES = 3 * 60;
const DEFAULT_WINDOW_MS = 24 * 3600 * 1000;

interface AgendaState {
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
    const tick = () => this.tick().catch((error) => console.error("[agenda] scheduler tick failed", error));
    setInterval(tick, 60_000);
    void tick();
    console.log(`[agenda] scheduled weekdays at ${this.config.AGENDA_TIME} ${this.config.AGENDA_TIMEZONE}`);
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
    const since = this.windowStart(state, until);
    try {
      await this.run({ since, until });
      // Only a successful run moves the window, so a failed day is picked up by the next one.
      this.writeState({ lastAttemptDate: now.date, lastUntil: until.toISOString() });
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

  private windowStart(state: AgendaState, until: Date): Date {
    if (state.lastUntil) return new Date(state.lastUntil);
    if (this.config.AGENDA_BACKFILL_SINCE) return new Date(this.config.AGENDA_BACKFILL_SINCE);
    return new Date(until.getTime() - DEFAULT_WINDOW_MS);
  }

  /**
   * Builds the agenda on demand (DM `agenda`), over the same window the next scheduled run will use.
   * It files missing Linear issues but doesn't move the window, so the scheduled agenda stays complete.
   */
  runNow(): Promise<AgendaResult> {
    const until = new Date();
    return this.run({ since: this.windowStart(this.readState(), until), until });
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
    const rejected = await loadRejectedFields(this.client, {
      dmChannel,
      token: this.config.SLACK_BOT_TOKEN,
      since,
      until,
    }).catch((error): RejectedExport | null => {
      console.error("[agenda] couldn't load the rejected-fields export", error);
      return null;
    });

    const triage =
      conversations.length || rejected?.total
        ? await triageConversations(
            this.config,
            {
              conversations,
              trackedIn,
              rejected: rejected?.total ? describeRejected(rejected.groups) : undefined,
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
    for (const { linear, ...item } of triage.items) {
      const sources = item.conversationIds.map((id) => byId.get(id)).filter((c): c is Conversation => Boolean(c));
      const untracked = sources.filter((c) => !trackedIn.get(c.id)?.length);
      const issues = new Map<string, AgendaItem["issues"][number]>();
      for (const c of sources) for (const i of trackedIn.get(c.id) ?? []) issues.set(i.identifier, i);
      let linearNote: string | undefined;

      try {
        if (linear.action === "create" && untracked.length) {
          const issue = await this.linear.createTriageIssue(
            linear.title,
            `${linear.description}\n\n${sourceFooter(untracked)}`,
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
      items.push({ ...item, issues: [...issues.values()], linearNote });
    }

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
      rejectedPatterns: triage.rejectedPatterns,
      warnings,
    });
    const file = path.join(dir, `nico-sync-${date}.html`);
    fs.writeFileSync(file, html);
    if (!rejected) warnings.push("No rejected-fields export yet: run `rejected-fields` in your terminal, then DM me `agenda`.");
    await this.deliver(dmChannel, file, date, items.length, skipped.length, created, warnings);
    return { file, items: items.length, created };
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
