import fs from "node:fs";
import { App, LogLevel } from "@slack/bolt";
import type { WebClient } from "@slack/web-api";
import path from "node:path";
import { Orchestrator } from "./agent.js";
import { saveAttachments, slackFiles, type SlackFile } from "./attachments.js";
import { loadConfig } from "./config.js";
import { SessionStore } from "./sessions.js";
import { chunkMessage, toSlackMrkdwn } from "./slack-format.js";
import { Workspace } from "./workspace.js";

const config = loadConfig();
fs.mkdirSync(config.DATA_DIR, { recursive: true });

const sessions = new SessionStore(config.DATA_DIR);
const workspace = new Workspace(config.DATA_DIR, config.GITHUB_REPOS);
const orchestrator = new Orchestrator(config, sessions, workspace);

const app = new App({
  token: config.SLACK_BOT_TOKEN,
  appToken: config.SLACK_APP_TOKEN,
  socketMode: true,
  logLevel: LogLevel.INFO,
});

interface ActiveRun {
  controller: AbortController;
  done: Promise<void>;
}
const activeRuns = new Map<string, ActiveRun>();
const STOP_WORDS = /^(stop|para|pare|cancel|cancela)[.!]*$/i;

interface IncomingMessage {
  user: string;
  text: string;
  channel: string;
  ts: string;
  threadTs?: string;
  files: SlackFile[];
}

let botUserId = "";

/** Stable id for a Slack thread; also used in branch and folder names. */
function toThreadKey(channel: string, threadTs: string): string {
  return `${channel}-${threadTs}`.replace(/[^A-Za-z0-9-]/g, "").toLowerCase();
}

async function handle(client: WebClient, msg: IncomingMessage): Promise<void> {
  const threadTs = msg.threadTs ?? msg.ts;
  const reply = (text: string) => client.chat.postMessage({ channel: msg.channel, thread_ts: threadTs, text });

  if (!config.ALLOWED_SLACK_USER_IDS.includes(msg.user)) {
    await reply(`Hi! I'm ${config.BOT_NAME}, a personal assistant, so I only take requests from my human 🙏`);
    return;
  }

  const threadKey = toThreadKey(msg.channel, threadTs);
  const prompt = msg.text.replaceAll(`<@${botUserId}>`, "").trim();
  const active = activeRuns.get(threadKey);

  if (STOP_WORDS.test(prompt)) {
    if (active) {
      active.controller.abort();
      await reply("Stopped 🛑");
    } else {
      await reply("I'm not working on anything in this thread.");
    }
    return;
  }
  if (!prompt && msg.files.length === 0) {
    await reply("What do you need, parce? 🙂");
    return;
  }

  // One run per thread at a time; new messages wait for the current one.
  const previous = active?.done ?? Promise.resolve();
  if (active) await reply("Got it, I'll get to that as soon as I finish the current task ⏳");

  const controller = new AbortController();
  const done = previous
    .catch(() => {})
    .then(() => runInThread(client, msg, threadTs, threadKey, prompt, controller));
  activeRuns.set(threadKey, { controller, done });
  done.finally(() => {
    if (activeRuns.get(threadKey)?.done === done) activeRuns.delete(threadKey);
  });
}

async function runInThread(
  client: WebClient,
  msg: IncomingMessage,
  threadTs: string,
  threadKey: string,
  prompt: string,
  controller: AbortController,
): Promise<void> {
  if (controller.signal.aborted) return;
  const started = Date.now();
  const react = (name: string) =>
    client.reactions.add({ channel: msg.channel, timestamp: msg.ts, name }).catch(() => {});
  await react("eyes");

  const status = await client.chat.postMessage({
    channel: msg.channel,
    thread_ts: threadTs,
    text: "🫡 On it, parce…",
  });
  // Steps stay hidden while working ("On it, parce…"); they're only shown if the run fails or is stopped.
  const steps: string[] = [];
  const renderStatus = (header: string) =>
    client.chat
      .update({
        channel: msg.channel,
        ts: status.ts!,
        text: [header, ...steps.slice(-6).map((s) => `• ${s}`)].join("\n"),
      })
      .catch(() => {});
  const onProgress = (line: string) => {
    if (steps.at(-1) !== line) steps.push(line);
  };

  try {
    const attachments = await saveAttachments(
      msg.files,
      path.join(workspace.threadDir(threadKey), ".attachments"),
      config.SLACK_BOT_TOKEN,
    );
    const fullPrompt = (await withThreadContext(client, msg, threadKey, prompt)) + attachments;
    const result = await orchestrator.run({ threadKey, prompt: fullPrompt, signal: controller.signal, onProgress });
    // The live progress message is only useful while working: drop it on success, keep it as a trail on errors.
    if (result.isError) {
      await renderStatus(`⚠️ Finished with problems after ${formatDuration(Date.now() - started)}`);
    } else {
      await client.chat.delete({ channel: msg.channel, ts: status.ts! }).catch(() => renderStatus("✅ Done"));
    }
    for (const chunk of chunkMessage(toSlackMrkdwn(result.text))) {
      await client.chat.postMessage({ channel: msg.channel, thread_ts: threadTs, text: chunk });
    }
    await react(result.isError ? "warning" : "white_check_mark");
  } catch (error) {
    if (controller.signal.aborted) {
      await renderStatus("🛑 Stopped");
      return;
    }
    console.error(`[${threadKey}] run failed`, error);
    await renderStatus("💥 Something broke");
    await client.chat.postMessage({
      channel: msg.channel,
      thread_ts: threadTs,
      text: `Something went wrong: \`${error instanceof Error ? error.message : String(error)}\``,
    });
    await react("x");
  }
}

/** First time we're called into an existing thread (e.g. a Sentry alert), include what was said before. */
async function withThreadContext(
  client: WebClient,
  msg: IncomingMessage,
  threadKey: string,
  prompt: string,
): Promise<string> {
  if (!msg.threadTs || sessions.get(threadKey).claudeSessionId) return prompt;
  const replies = await client.conversations.replies({ channel: msg.channel, ts: msg.threadTs, limit: 50 });
  const history = (replies.messages ?? [])
    .filter((m) => m.ts !== msg.ts)
    .map((m) => `${m.user ? `<@${m.user}>` : (m.bot_profile?.name ?? "bot")}: ${m.text ?? ""}`)
    .join("\n");
  return history ? `Earlier messages in this Slack thread:\n${history}\n\nMy request: ${prompt}` : prompt;
}

function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

// @mentions in channels.
app.event("app_mention", async ({ event, client }) => {
  if (!event.user) return;
  await handle(client, {
    user: event.user,
    text: event.text,
    channel: event.channel,
    ts: event.ts,
    threadTs: event.thread_ts,
    files: slackFiles("files" in event ? event.files : undefined),
  });
});

// DMs only. In channels the bot answers only when @mentioned (app_mention above), even in threads it's working in.
app.message(async ({ message, client }) => {
  // Plain messages, plus messages with attachments (screenshots, logs).
  if ((message.subtype !== undefined && message.subtype !== "file_share") || !("user" in message) || !message.user) return;
  if (message.user === botUserId || ("bot_id" in message && message.bot_id)) return;
  const text = message.text ?? "";
  const isDm = message.channel_type === "im";
  const threadTs = "thread_ts" in message ? message.thread_ts : undefined;
  if (!isDm) return;
  const files = slackFiles("files" in message ? message.files : undefined);
  await handle(client, { user: message.user, text, channel: message.channel, ts: message.ts, threadTs, files });
});

const auth = await app.client.auth.test();
botUserId = auth.user_id ?? "";
await app.start();
console.log(`⚡ ${config.BOT_NAME} is running as @${auth.user} (Claude: ${config.CLAUDE_MODEL}, Codex: ${config.CODEX_MODEL})`);
