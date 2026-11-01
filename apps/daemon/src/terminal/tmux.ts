import type { Runner } from "../run.js";

/**
 * Your own shell for a lane: one tmux session in the lane's worktree. It is not the agent's;
 * agents run commands through ACP. Closing a browser tab or SSH session only detaches.
 */
export class Terminals {
  constructor(private readonly run: Runner) {}

  async create(session: string, cwd: string, env: Record<string, string> = {}, independent = false): Promise<void> {
    const envArgs = Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
    const args = ["new-session", "-d", "-s", session, "-c", cwd, ...envArgs];
    // A newly created tmux server must outlive the daemon's cgroup, even on a fresh machine.
    if (independent) await this.run("systemd-run", ["--user", "--scope", `--unit=contextlanes-terminal-${session}`, "--collect", "--quiet", "tmux", ...args]);
    else await this.run("tmux", args);
  }

  /** = asks for this exact name; tmux would otherwise match cl-shop-01 to cl-shop-01-2, another lane's shell. */
  async exists(session: string): Promise<boolean> {
    try {
      await this.run("tmux", ["has-session", "-t", `=${session}`]);
      return true;
    } catch {
      return false;
    }
  }

  async kill(session: string): Promise<void> {
    if (await this.exists(session)) await this.run("tmux", ["kill-session", "-t", `=${session}`]);
  }
}

/** What `contextlanes term <lane>` execs on the machine. */
export function attachArgs(session: string): string[] {
  // "=" matches the exact session name; plain names also prefix-match cl-shop-010 for cl-shop-01.
  return ["attach-session", "-t", `=${session}`];
}
