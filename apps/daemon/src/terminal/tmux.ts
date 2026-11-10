import { SystemdSupervisor, type Supervisor } from "../supervisor/index.js";
import type { Runner } from "../run.js";

/**
 * Your own shell for a lane: one tmux session in the lane's worktree. It is not the agent's;
 * agents run commands through ACP. Closing a browser tab or SSH session only detaches.
 */
export class Terminals {
  /** supervisor runs tmux so its server outlives the daemon: a systemd scope, or plainly where tmux daemonizes itself. */
  constructor(private readonly run: Runner, private readonly supervisor: Pick<Supervisor, "detached"> = new SystemdSupervisor(run)) {}

  async create(session: string, cwd: string, env: Record<string, string> = {}, independent = false): Promise<void> {
    const envArgs = Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
    const args = ["new-session", "-d", "-s", session, "-c", cwd, ...envArgs];
    // A newly created tmux server must outlive the daemon's cgroup, even on a fresh machine.
    if (independent) await this.supervisor.detached(`contextlanes-terminal-${session}`, ["tmux", ...args]);
    else await this.run("tmux", args);
    await this.wheel(session);
  }

  /**
   * Mouse on, for this session only. Without it a terminal turns the scroll wheel into arrow keys while
   * a full-screen program such as an agent is open, so scrolling walks through its input history. With
   * it the wheel scrolls back through output, and programs that read the mouse still get it. Selecting
   * text to copy then takes Shift-drag. Best effort: a session without it still works.
   */
  async wheel(session: string): Promise<void> {
    await this.run("tmux", ["set-option", "-t", `=${session}:`, "mouse", "on"]).catch(() => {});
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

/** What `cl sh <lane>` execs on the machine. */
export function attachArgs(session: string, opts: { watch?: boolean } = {}): string[] {
  // "=" matches the exact session name; plain names also prefix-match cl-shop-010 for cl-shop-01.
  // -r: a client that can look but not type, and whose size does not resize the session for the agent.
  return ["attach-session", ...(opts.watch ? ["-r", "-f", "ignore-size"] : []), "-t", `=${session}`];
}
