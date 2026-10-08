import {
  createSdkMcpServer,
  query,
  tool,
  type McpServerConfig,
  type SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { CodexImplementer, truncate } from "./codex.js";
import type { Config } from "./config.js";
import type { SessionStore } from "./sessions.js";
import type { Workspace } from "./workspace.js";

export interface RunRequest {
  threadKey: string;
  prompt: string;
  signal: AbortSignal;
  onProgress: (line: string) => void;
}

export interface RunResult {
  text: string;
  isError: boolean;
}

function systemPrompt(config: Config, repos: string[]): string {
  const integrations = [
    config.LINEAR_API_KEY && "Linear (issues)",
    config.SENTRY_ACCESS_TOKEN && "Sentry (errors)",
  ].filter(Boolean);
  return `
# You are ${config.BOT_NAME}

You are ${config.BOT_NAME}, a personal engineering assistant that lives in Slack. You work for one person and talk
to them in Slack threads, which teammates and managers may also read. Your personality: a warm Colombian
parcero (buddy). Be friendly and upbeat, and drop the occasional "parce" or "parcero" naturally, but stay
focused and professional, and keep the flavor light: one touch per message at most.
Write in English. Only switch language if the user writes to you in another one, and never comment on which
languages you speak. Anything that lands in a repo (code, comments, commit messages, PR titles and
descriptions) is always in English.

## How you work: you are the brain, Codex is the hands
- You (Claude) investigate, plan, review and decide. You do NOT write large amounts of code yourself.
- Implementation goes to Codex through the \`delegate_to_codex\` tool. Codex runs on a separate subscription,
  so delegating keeps your own usage low. Small fixes (a typo, a one-line change) you may do yourself.
- Call \`open_repo\` first to get a worktree for a repo. Each Slack thread has its own branch.

## For a coding task
1. Understand: read the referenced issue or error if you have access to it, then explore the relevant code.
   Read the repo's CLAUDE.md / AGENTS.md / README for conventions.
2. Plan: decide exactly what should change and why.
3. Delegate: give Codex a precise spec (files, behavior, edge cases, how to verify, tests to add or run).
   Tell it not to commit.
4. Review: inspect \`git diff\` yourself. Run the tests, linter or type checker if the repo has them. If anything
   is wrong or missing, call \`delegate_to_codex\` again with \`continue_previous: true\` and concrete feedback.
5. Ship: once you are satisfied, commit with a clear message, \`git push -u origin HEAD\`, and open a draft PR with
   \`gh pr create --draft\`. Put a short summary and the testing you did in the PR body. Never push to the
   default branch and never force-push.

## For questions
Investigate the code (and any connected tools) and answer. Don't change code unless asked.

## Replying
- Your final message is posted to Slack. Keep it short: what you found or did, and the PR link if any.
- Use simple formatting: short paragraphs, bullet lists, \`code\`. No tables, no headings.
- If the request is ambiguous or risky (data migrations, deleting things, infra), ask before acting.

Repos you can work on: ${repos.join(", ")}
Connected tools: ${integrations.length ? integrations.join(", ") : "none besides GitHub"}. Don't offer anything
that needs a tool that isn't connected.
`.trim();
}

export class Orchestrator {
  private readonly codex: CodexImplementer;

  constructor(
    private readonly config: Config,
    private readonly sessions: SessionStore,
    private readonly workspace: Workspace,
  ) {
    this.codex = new CodexImplementer(config);
  }

  private tools(req: RunRequest, repos: string[]) {
    const session = this.sessions.get(req.threadKey);

    return createSdkMcpServer({
      name: "parcerito",
      version: "0.1.0",
      tools: [
        tool(
          "open_repo",
          "Get (or create) this Slack thread's git worktree for a repo. Returns its path, branch and base branch.",
          { repo: z.string().describe(`owner/name, one of: ${repos.join(", ")}`) },
          async ({ repo }) => {
            req.onProgress(`Opening ${repo}`);
            const result = await this.workspace.openRepo(req.threadKey, repo);
            return { content: [{ type: "text", text: JSON.stringify(result) }] };
          },
        ),
        tool(
          "delegate_to_codex",
          "Hand an implementation task to Codex (the implementer). It edits files in the worktree and can run commands. " +
            "Returns its summary, the files it changed and the commands it ran. Review the diff afterwards.",
          {
            repo_path: z.string().describe("Worktree path returned by open_repo"),
            task: z.string().describe("A precise spec: what to change, where, constraints, and how to verify"),
            continue_previous: z
              .boolean()
              .default(false)
              .describe("Continue the previous Codex conversation for this worktree (use for review feedback)"),
          },
          async ({ repo_path, task, continue_previous }) => {
            req.onProgress("Handing the implementation to Codex");
            const previous = session.codexThreads[repo_path];
            const result = await this.codex.run({
              workingDirectory: repo_path,
              task,
              resumeThreadId: continue_previous ? previous : undefined,
              signal: req.signal,
              onProgress: req.onProgress,
            });
            if (result.threadId) {
              session.codexThreads[repo_path] = result.threadId;
              this.sessions.save();
            }
            const text = [
              `Codex summary:\n${result.summary || "(no summary)"}`,
              `Files changed: ${result.filesChanged.join(", ") || "none"}`,
              `Commands run:\n${result.commands.map((c) => `- ${truncate(c, 200)}`).join("\n") || "none"}`,
            ].join("\n\n");
            return { content: [{ type: "text", text }] };
          },
        ),
      ],
    });
  }

  private mcpServers(req: RunRequest, repos: string[]): Record<string, McpServerConfig> {
    const servers: Record<string, McpServerConfig> = { parcerito: this.tools(req, repos) };
    if (this.config.LINEAR_API_KEY) {
      servers.linear = {
        type: "http",
        url: "https://mcp.linear.app/mcp",
        headers: { Authorization: `Bearer ${this.config.LINEAR_API_KEY}` },
      };
    }
    if (this.config.SENTRY_ACCESS_TOKEN) {
      servers.sentry = {
        type: "stdio",
        command: "npx",
        args: ["-y", "@sentry/mcp-server@latest"],
        env: {
          SENTRY_ACCESS_TOKEN: this.config.SENTRY_ACCESS_TOKEN,
          ...(this.config.SENTRY_HOST ? { SENTRY_HOST: this.config.SENTRY_HOST } : {}),
          PATH: process.env.PATH ?? "",
        },
      };
    }
    return servers;
  }

  async run(req: RunRequest): Promise<RunResult> {
    const session = this.sessions.get(req.threadKey);
    const abortController = new AbortController();
    req.signal.addEventListener("abort", () => abortController.abort(), { once: true });
    const repos = await this.workspace.listRepos();

    const conversation = query({
      prompt: req.prompt,
      options: {
        model: this.config.CLAUDE_MODEL,
        effort: this.config.CLAUDE_EFFORT,
        cwd: this.workspace.threadDir(req.threadKey),
        systemPrompt: { type: "preset", preset: "claude_code", append: systemPrompt(this.config, repos) },
        mcpServers: this.mcpServers(req, repos),
        // The container is the sandbox and only the allowlisted user can trigger runs.
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        settingSources: [],
        resume: session.claudeSessionId,
        abortController,
      },
    });

    let result: RunResult = { text: "I finished but had nothing to say 🤔", isError: true };
    for await (const message of conversation) {
      if ("session_id" in message && message.session_id && session.claudeSessionId !== message.session_id) {
        session.claudeSessionId = message.session_id;
        this.sessions.save();
      }
      const line = progressLine(message);
      if (line) req.onProgress(line);
      if (message.type === "result") {
        result =
          message.subtype === "success"
            ? { text: message.result, isError: message.is_error }
            : { text: `I stopped early (${message.subtype}).`, isError: true };
      }
    }
    return result;
  }
}

/** Turns Claude's tool calls into short human-readable status lines. */
function progressLine(message: SDKMessage): string | null {
  if (message.type !== "assistant" || message.parent_tool_use_id) return null;
  for (const block of message.message.content) {
    if (block.type !== "tool_use") continue;
    const input = block.input as Record<string, unknown>;
    switch (block.name) {
      case "Read":
        return `Reading ${String(input.file_path ?? "").split("/").pop()}`;
      case "Grep":
      case "Glob":
        return `Searching for \`${truncate(String(input.pattern ?? ""), 60)}\``;
      case "Bash":
        return `Running \`${truncate(String(input.command ?? ""), 80)}\``;
      case "Edit":
      case "Write":
        return `Editing ${String(input.file_path ?? "").split("/").pop()}`;
      case "WebFetch":
      case "WebSearch":
        return "Searching the web";
      default:
        if (block.name.startsWith("mcp__linear__")) return "Checking Linear";
        if (block.name.startsWith("mcp__sentry__")) return "Checking Sentry";
        if (block.name.startsWith("mcp__parcerito__")) return null; // the tool reports its own progress
        return `Using ${block.name}`;
    }
  }
  return null;
}
