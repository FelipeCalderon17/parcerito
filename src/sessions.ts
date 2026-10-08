import fs from "node:fs";
import path from "node:path";

/** Everything we remember about one Slack thread. */
export interface ThreadSession {
  /** Claude Agent SDK session, so follow-ups in the thread keep context. */
  claudeSessionId?: string;
  /** Codex thread per worktree path, so Claude can ask Codex for fixes in the same conversation. */
  codexThreads: Record<string, string>;
  createdAt: string;
}

/** Tiny JSON-file store. One user, a handful of threads: no database needed. */
export class SessionStore {
  private readonly file: string;
  private sessions: Record<string, ThreadSession>;

  constructor(dataDir: string) {
    this.file = path.join(dataDir, "sessions.json");
    this.sessions = fs.existsSync(this.file)
      ? JSON.parse(fs.readFileSync(this.file, "utf8"))
      : {};
  }

  has(threadKey: string): boolean {
    return threadKey in this.sessions;
  }

  get(threadKey: string): ThreadSession {
    this.sessions[threadKey] ??= { codexThreads: {}, createdAt: new Date().toISOString() };
    return this.sessions[threadKey];
  }

  save(): void {
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.sessions, null, 2));
    fs.renameSync(tmp, this.file);
  }
}
