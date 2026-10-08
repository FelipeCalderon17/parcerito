import { Codex, type ThreadItem } from "@openai/codex-sdk";
import type { Config } from "./config.js";

export interface CodexRunResult {
  threadId: string | null;
  summary: string;
  filesChanged: string[];
  commands: string[];
}

/** Runs the implementer (Codex) on one worktree. Claude stays the brain; Codex does the typing. */
export class CodexImplementer {
  private readonly codex = new Codex();

  constructor(private readonly config: Config) {}

  async run(params: {
    workingDirectory: string;
    task: string;
    resumeThreadId?: string;
    signal?: AbortSignal;
    onProgress?: (line: string) => void;
  }): Promise<CodexRunResult> {
    const options = {
      model: this.config.CODEX_MODEL,
      modelReasoningEffort: this.config.CODEX_EFFORT,
      sandboxMode: this.config.CODEX_SANDBOX,
      approvalPolicy: "never" as const,
      networkAccessEnabled: true,
      workingDirectory: params.workingDirectory,
    };
    const thread = params.resumeThreadId
      ? this.codex.resumeThread(params.resumeThreadId, options)
      : this.codex.startThread(options);

    const { events } = await thread.runStreamed(params.task, { signal: params.signal });

    const filesChanged = new Set<string>();
    const commands: string[] = [];
    let summary = "";
    let threadId: string | null = params.resumeThreadId ?? null;

    for await (const event of events) {
      if (event.type === "thread.started") threadId = event.thread_id;
      if (event.type === "turn.failed") throw new Error(`Codex failed: ${event.error.message}`);
      if (event.type === "error") throw new Error(`Codex error: ${event.message}`);
      if (event.type !== "item.completed") continue;

      const line = describe(event.item);
      if (line) params.onProgress?.(line);

      switch (event.item.type) {
        case "file_change":
          for (const change of event.item.changes) filesChanged.add(change.path);
          break;
        case "command_execution":
          commands.push(`${event.item.command} (exit ${event.item.exit_code ?? "?"})`);
          break;
        case "agent_message":
          summary = event.item.text;
          break;
      }
    }

    return { threadId: threadId ?? thread.id, summary, filesChanged: [...filesChanged], commands };
  }
}

function describe(item: ThreadItem): string | null {
  switch (item.type) {
    case "file_change":
      return `Codex edited ${item.changes.map((c) => c.path.split("/").pop()).join(", ")}`;
    case "command_execution":
      return `Codex ran \`${truncate(item.command, 80)}\``;
    default:
      return null;
  }
}

export function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
