import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await exec("git", args, { cwd, maxBuffer: 32 * 1024 * 1024 });
  return stdout.trim();
}

/**
 * Layout on the volume:
 *   <data>/repos/<owner>/<name>   one shared clone per repo
 *   <data>/work/<thread>/<name>   one git worktree per Slack thread, on its own branch
 */
export class Workspace {
  constructor(
    private readonly dataDir: string,
    private readonly allowedRepos: string[],
  ) {}

  threadDir(threadKey: string): string {
    const dir = path.join(this.dataDir, "work", threadKey);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  /** Returns a worktree for `repo` in this thread, creating it from the latest default branch if needed. */
  async openRepo(threadKey: string, repo: string): Promise<{ path: string; branch: string; base: string }> {
    const fullName = this.allowedRepos.find((r) => r.toLowerCase() === repo.toLowerCase());
    if (!fullName) {
      throw new Error(`Repo "${repo}" is not in GITHUB_REPOS (${this.allowedRepos.join(", ")}).`);
    }
    const [owner, name] = fullName.split("/");
    const clone = path.join(this.dataDir, "repos", owner, name);
    const worktree = path.join(this.threadDir(threadKey), name);
    const branch = `parcerito/${threadKey}`;

    if (!fs.existsSync(path.join(clone, ".git"))) {
      fs.mkdirSync(path.dirname(clone), { recursive: true });
      await exec("gh", ["repo", "clone", fullName, clone, "--", "--filter=blob:none"]);
    }
    await git(clone, "fetch", "origin", "--prune");
    const base = (await git(clone, "symbolic-ref", "--short", "refs/remotes/origin/HEAD")).replace(/^origin\//, "");

    if (!fs.existsSync(worktree)) {
      await git(clone, "worktree", "prune");
      const branchExists = await git(clone, "branch", "--list", branch);
      if (branchExists) {
        await git(clone, "worktree", "add", worktree, branch);
      } else {
        await git(clone, "worktree", "add", "-b", branch, worktree, `origin/${base}`);
      }
    }
    return { path: worktree, branch, base };
  }
}
