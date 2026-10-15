import type { WebClient } from "@slack/web-api";

/** One Slack message, flattened to what the agenda needs. */
export interface AgendaMessage {
  ts: string;
  author: string;
  /** Someone outside the internal team (and not a bot). */
  external: boolean;
  /** Posted inside the agenda window. */
  inWindow: boolean;
  text: string;
  url: string;
}

/** A thread, or a standalone message, with at least one external message in the window. */
export interface Conversation {
  id: string;
  channelId: string;
  channelName: string;
  rootTs: string;
  url: string;
  messages: AgendaMessage[];
}

export interface CollectResult {
  conversations: Conversation[];
  /** Configured channels the bot can't read (not a member, or misspelled). */
  missingChannels: string[];
}

interface SlackMessage {
  ts?: string;
  user?: string;
  bot_id?: string;
  subtype?: string;
  text?: string;
  reply_count?: number;
  latest_reply?: string;
  files?: { name?: string }[];
}

// A thread that started a while ago can still get new replies inside the window.
const THREAD_LOOKBACK_SECONDS = 7 * 24 * 3600;
const MAX_TEXT = 1500;
const MAX_THREAD_MESSAGES = 40;
const READABLE_SUBTYPES = new Set([undefined, "file_share", "thread_broadcast"]);

export async function collectConversations(
  client: WebClient,
  opts: { channels: string[]; internalUserIds: string[]; since: Date; until: Date },
): Promise<CollectResult> {
  const sinceTs = opts.since.getTime() / 1000;
  const untilTs = opts.until.getTime() / 1000;
  const workspaceUrl = (await client.auth.test()).url ?? "https://slack.com/";
  const channelIds = await memberChannels(client);
  const names = new UserNames(client);

  const conversations: Conversation[] = [];
  const missingChannels: string[] = [];
  for (const channelName of opts.channels) {
    const channelId = channelIds.get(channelName);
    if (!channelId) {
      missingChannels.push(channelName);
      continue;
    }
    const link = (ts: string, rootTs?: string) =>
      `${workspaceUrl}archives/${channelId}/p${ts.replace(".", "")}` +
      (rootTs && rootTs !== ts ? `?thread_ts=${rootTs}&cid=${channelId}` : "");

    const toMessage = async (m: SlackMessage, rootTs: string): Promise<AgendaMessage> => {
      const ts = Number(m.ts);
      const isBot = Boolean(m.bot_id) || !m.user;
      const files = (m.files ?? []).map((f) => `[attached: ${f.name ?? "file"}]`).join(" ");
      return {
        ts: m.ts!,
        author: isBot ? "bot" : await names.get(m.user!),
        external: !isBot && !opts.internalUserIds.includes(m.user!),
        inWindow: ts >= sinceTs && ts < untilTs,
        text: truncate([m.text ?? "", files].filter(Boolean).join(" "), MAX_TEXT),
        url: link(m.ts!, rootTs),
      };
    };

    for (const root of await history(client, channelId, sinceTs - THREAD_LOOKBACK_SECONDS, untilTs)) {
      if (!root.ts || !READABLE_SUBTYPES.has(root.subtype)) continue;
      const rootInWindow = Number(root.ts) >= sinceTs;
      const hasNewReplies = Boolean(root.reply_count) && Number(root.latest_reply ?? 0) >= sinceTs;
      if (!rootInWindow && !hasNewReplies) continue;

      const raw = root.reply_count ? await replies(client, channelId, root.ts) : [root];
      const messages = await Promise.all(
        raw
          .filter((m) => m.ts && READABLE_SUBTYPES.has(m.subtype) && Number(m.ts) < untilTs)
          .slice(-MAX_THREAD_MESSAGES)
          .map((m) => toMessage(m, root.ts!)),
      );
      if (!messages.some((m) => m.external && m.inWindow)) continue;
      conversations.push({
        id: `${channelId}-${root.ts}`,
        channelId,
        channelName,
        rootTs: root.ts,
        url: link(root.ts),
        messages,
      });
    }
  }
  return { conversations, missingChannels };
}

/** Channels the bot is a member of, by name. */
async function memberChannels(client: WebClient): Promise<Map<string, string>> {
  const byName = new Map<string, string>();
  let cursor: string | undefined;
  do {
    const page = await client.users.conversations({
      types: "public_channel,private_channel",
      exclude_archived: true,
      limit: 200,
      cursor,
    });
    for (const c of page.channels ?? []) if (c.id && c.name) byName.set(c.name, c.id);
    cursor = page.response_metadata?.next_cursor || undefined;
  } while (cursor);
  return byName;
}

async function history(client: WebClient, channel: string, oldest: number, latest: number) {
  const messages: SlackMessage[] = [];
  let cursor: string | undefined;
  do {
    const page = await client.conversations.history({
      channel,
      oldest: String(oldest),
      latest: String(latest),
      limit: 200,
      cursor,
    });
    messages.push(...((page.messages ?? []) as SlackMessage[]));
    cursor = page.response_metadata?.next_cursor || undefined;
  } while (cursor);
  return messages.reverse();
}

async function replies(client: WebClient, channel: string, ts: string) {
  const messages: SlackMessage[] = [];
  let cursor: string | undefined;
  do {
    const page = await client.conversations.replies({ channel, ts, limit: 200, cursor });
    messages.push(...((page.messages ?? []) as SlackMessage[]));
    cursor = page.response_metadata?.next_cursor || undefined;
  } while (cursor);
  return messages;
}

class UserNames {
  private readonly cache = new Map<string, Promise<string>>();
  constructor(private readonly client: WebClient) {}

  get(userId: string): Promise<string> {
    let name = this.cache.get(userId);
    if (!name) {
      name = this.client.users
        .info({ user: userId })
        .then((r) => r.user?.real_name || r.user?.profile?.display_name || r.user?.name || userId)
        .catch(() => userId);
      this.cache.set(userId, name);
    }
    return name;
  }
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
