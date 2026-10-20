import fs from "node:fs";
import path from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { WebClient } from "@slack/web-api";
import type { Config } from "../config.js";

export const ACK_TEXT = "Noted 📝 I'm Felipe's agent: I added this to his plate and he'll follow up.";

// People often report in a burst of messages; wait for the burst to end before deciding.
const QUIET_MS = 3 * 60_000;
const CHANNEL_REFRESH_MS = 60 * 60_000;
const MAX_TEXT = 1500;

export interface ThreadMessage {
  user?: string;
  bot_id?: string;
  text?: string;
  files?: { name?: string }[];
}

/**
 * Live replies in the agenda channels: when someone from the service team reports a prompt or form issue
 * (Felipe's area) that nobody on the team has answered yet, say in the thread that it's on Felipe's plate.
 * Once per thread; the daily agenda still does the Linear work.
 */
export class IssueAcknowledger {
  private readonly ackedFile: string;
  private readonly acked: Set<string>;
  private readonly pending = new Map<string, NodeJS.Timeout>();
  private channels = new Map<string, string>();
  private channelsLoadedAt = 0;

  constructor(
    private readonly config: Config,
    private readonly client: WebClient,
    private readonly botUserId: () => string,
  ) {
    this.ackedFile = path.join(config.DATA_DIR, "agenda", "acked-threads.json");
    this.acked = new Set(fs.existsSync(this.ackedFile) ? JSON.parse(fs.readFileSync(this.ackedFile, "utf8")) : []);
  }

  get enabled(): boolean {
    return this.config.AGENDA_CHANNELS.length > 0;
  }

  /** Called for every channel message; cheap until a thread goes quiet. */
  async onMessage(msg: { channel: string; user: string; ts: string; threadTs?: string }): Promise<void> {
    if (!this.enabled || this.config.AGENDA_INTERNAL_USER_IDS.includes(msg.user)) return;
    const channelName = await this.channelName(msg.channel);
    if (!channelName) return;
    const rootTs = msg.threadTs ?? msg.ts;
    const key = `${msg.channel}-${rootTs}`;
    if (this.acked.has(key)) return;

    clearTimeout(this.pending.get(key));
    this.pending.set(
      key,
      setTimeout(() => {
        this.pending.delete(key);
        this.review(msg.channel, channelName, rootTs, key).catch((error) =>
          console.error(`[ack] ${key} failed`, error),
        );
      }, QUIET_MS),
    );
  }

  private async review(channel: string, channelName: string, rootTs: string, key: string): Promise<void> {
    const thread = ((await this.client.conversations.replies({ channel, ts: rootTs, limit: 100 })).messages ??
      []) as ThreadMessage[];
    const teamIds = [...this.config.ALLOWED_SLACK_USER_IDS, ...this.config.AGENDA_INTERNAL_USER_IDS];
    if (!needsAck(thread, { teamIds, botUserId: this.botUserId() })) {
      this.markAcked(key);
      return;
    }
    const verdict = await classify(this.config, channelName, thread, this.config.AGENDA_INTERNAL_USER_IDS);
    console.log(`[ack] ${key}: ${verdict.kind} (${verdict.reason})`);
    if (verdict.kind !== "prompts_or_forms") return;
    await this.client.chat.postMessage({ channel, thread_ts: rootTs, text: ACK_TEXT });
    this.markAcked(key);
  }

  private markAcked(key: string): void {
    this.acked.add(key);
    fs.mkdirSync(path.dirname(this.ackedFile), { recursive: true });
    fs.writeFileSync(this.ackedFile, JSON.stringify([...this.acked]));
  }

  /** Name of a watched channel, or undefined for any other channel. */
  private async channelName(channelId: string): Promise<string | undefined> {
    if (Date.now() - this.channelsLoadedAt > CHANNEL_REFRESH_MS) {
      const byId = new Map<string, string>();
      let cursor: string | undefined;
      do {
        const page = await this.client.users.conversations({
          types: "public_channel,private_channel",
          exclude_archived: true,
          limit: 200,
          cursor,
        });
        for (const c of page.channels ?? []) {
          if (c.id && c.name && this.config.AGENDA_CHANNELS.includes(c.name)) byId.set(c.id, c.name);
        }
        cursor = page.response_metadata?.next_cursor || undefined;
      } while (cursor);
      this.channels = byId;
      this.channelsLoadedAt = Date.now();
    }
    return this.channels.get(channelId);
  }
}

/** False when someone on the team (or this bot) already answered in the thread: it's being handled. */
export function needsAck(thread: ThreadMessage[], opts: { teamIds: string[]; botUserId: string }): boolean {
  return !thread.some((m) => (m.user && opts.teamIds.includes(m.user)) || m.user === opts.botUserId);
}

type Verdict = { kind: "prompts_or_forms" | "other_issue" | "not_an_issue"; reason: string };

export async function classify(
  config: Config,
  channelName: string,
  thread: ThreadMessage[],
  internalUserIds: string[],
): Promise<Verdict> {
  const messages = thread.map((m) => ({
    from: m.bot_id || !m.user ? "bot" : internalUserIds.includes(m.user) ? "internal" : "service team",
    text: [m.text ?? "", ...(m.files ?? []).map((f) => `[attached: ${f.name ?? "file"}]`)].join(" ").slice(0, MAX_TEXT),
  }));
  const prompt = `
A Slack thread from #${channelName}, a channel shared with home-health agencies using Lime. "service team" are
clinicians, coders and agency staff; "internal" is the Lime team; bots (e.g. Dotterino) are context only.

Classify the latest service-team message:
- prompts_or_forms: a problem with what Lime puts in a form or note. AI-generated answers that are wrong,
  missing, contradictory or ignore the recording/transcript; narrative or summary quality; a form field,
  option, section or skip pattern in Lime that's missing, wrong or doesn't match the EHR form; values that
  land in the wrong field.
- other_issue: something the team has to fix, decide or answer that isn't about the form content itself.
  Turning a feature (e.g. auto push) on or off for an agency or clinician, account and login problems,
  app crashes or outages, EHR connection or sync failures, recordings that won't upload, billing, feature
  requests, general questions. A request to change a setting is other_issue even when it mentions form values.
- not_an_issue: thanks, greetings, "ok/will check", status updates, scheduling, praise, or something the
  thread already shows as answered or resolved.

Thread:
${JSON.stringify(messages, null, 1)}
`.trim();

  const conversation = query({
    prompt,
    options: {
      model: config.CLAUDE_MODEL,
      effort: "low",
      tools: [],
      permissionMode: "dontAsk",
      settingSources: [],
      outputFormat: {
        type: "json_schema",
        schema: {
          type: "object",
          additionalProperties: false,
          required: ["kind", "reason"],
          properties: {
            kind: { type: "string", enum: ["prompts_or_forms", "other_issue", "not_an_issue"] },
            reason: { type: "string", description: "One short line" },
          },
        },
      },
      abortController: abortAfter(5 * 60_000),
    },
  });
  for await (const message of conversation) {
    if (message.type !== "result") continue;
    if (message.subtype !== "success" || !message.structured_output) {
      throw new Error(`Classification stopped early (${message.subtype})`);
    }
    return message.structured_output as Verdict;
  }
  throw new Error("Classification returned no result");
}

function abortAfter(ms: number): AbortController {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), ms).unref();
  return controller;
}
