import path from "node:path";
import { z } from "zod";

const list = z
  .string()
  .default("")
  .transform((value) =>
    value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
  );

const schema = z.object({
  SLACK_BOT_TOKEN: z.string().startsWith("xoxb-"),
  SLACK_APP_TOKEN: z.string().startsWith("xapp-"),
  // Only these Slack user IDs can talk to the bot. It runs on your personal subscriptions.
  ALLOWED_SLACK_USER_IDS: list.refine((ids) => ids.length > 0, "Set at least one Slack user ID"),

  // Repos the bot may work on, e.g. "acme/api,acme/web".
  GITHUB_REPOS: list.refine((repos) => repos.length > 0, "Set at least one owner/repo"),
  GH_TOKEN: z.string().min(1),
  GIT_AUTHOR_NAME: z.string().default("parcerito"),
  GIT_AUTHOR_EMAIL: z.string().default("parcerito@users.noreply.github.com"),

  CLAUDE_MODEL: z.string().default("claude-opus-5-5"),
  CLAUDE_EFFORT: z.enum(["low", "medium", "high", "xhigh", "max"]).default("high"),
  CODEX_MODEL: z.string().default("gpt-6.1-sol"),
  CODEX_EFFORT: z
    .enum(["minimal", "low", "medium", "high", "xhigh", "max", "ultra"])
    .default("medium"),
  // The container is the sandbox, so Codex gets full access inside it by default.
  CODEX_SANDBOX: z
    .enum(["read-only", "workspace-write", "danger-full-access"])
    .default("danger-full-access"),

  LINEAR_API_KEY: z.string().optional(),
  SENTRY_ACCESS_TOKEN: z.string().optional(),
  SENTRY_HOST: z.string().optional(),

  // Daily meeting agenda: scans these channels (names, no #) for messages from people outside the team,
  // makes sure each one is tracked in Linear, and DMs an HTML agenda. Off when no channels are set.
  AGENDA_CHANNELS: list,
  // Slack user IDs of the internal team. Their messages (and bots') are context, not agenda items.
  AGENDA_INTERNAL_USER_IDS: list,
  // Who gets the agenda. Defaults to the first allowed user.
  AGENDA_RECIPIENT_ID: z.string().optional(),
  AGENDA_TIME: z
    .string()
    .regex(/^\d{2}:\d{2}$/, "Use HH:MM")
    .default("10:00"),
  AGENDA_TIMEZONE: z.string().default("America/Bogota"),
  // Start of the very first window (ISO date-time). Later runs pick up where the previous one ended.
  AGENDA_BACKFILL_SINCE: z.string().datetime({ offset: true }).optional(),
  // Where `npm run agenda` saves the agenda on your machine; only used to print its file:// link.
  AGENDA_LOCAL_DIR: z.string().optional(),
  // Linear team whose Triage receives issues created on Dotterino's behalf.
  LINEAR_TEAM_KEY: z.string().default("ENG"),

  DATA_DIR: z.string().default(path.resolve("data")),
  BOT_NAME: z.string().default("Parcerito"),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`)
      .join("\n");
    throw new Error(`Invalid configuration:\n${problems}\nSee .env.example.`);
  }
  return parsed.data;
}
