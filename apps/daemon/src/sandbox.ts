import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { configPath, type Config } from "./config.js";
import { Refused } from "./lanes/manager.js";
import type { Runner } from "./run.js";

/** Outside the data folder, so a sandboxed lane host can reach it. One per data folder, so fixtures never share a socket. */
export function socketPath(config: Config): string {
  const name = `contextlanes-${createHash("sha256").update(config.paths.data).digest("hex").slice(0, 12)}`;
  return join(process.env.XDG_RUNTIME_DIR ?? join(tmpdir(), `run-${process.getuid?.() ?? 0}`), name, "lanes.sock");
}

/**
 * Prefix for every command started for a lane. bubblewrap, not systemd's InaccessiblePaths=: on Ubuntu 24.04
 * AppArmor denies user units the mounts that setting needs and systemd ignores it silently. It also could not
 * hide the data folder while leaving the release inside it, which holds the lane host's own code.
 * Whole folders are hidden, not single files: a file that is later replaced would come back into view.
 */
export function sandbox(config: Config, opts: { socket?: boolean; ssh?: boolean } = {}): string[] {
  const { data } = config.paths;
  const tmux = `/tmp/tmux-${process.getuid?.() ?? 0}`;
  const resolver = existsSync("/etc/resolv.conf") ? dirname(realpathSync("/etc/resolv.conf")) : null;
  return ["bwrap", "--dev-bind", "/", "/",
    "--tmpfs", data, "--ro-bind-try", join(data, "releases"), join(data, "releases"), "--ro-bind-try", join(data, "app"), join(data, "app"),
    "--tmpfs", dirname(configPath()),
    // /run holds every way out of the sandbox: the systemd user bus, Docker and Tailscale.
    "--tmpfs", "/run", ...(resolver?.startsWith("/run/") ? ["--ro-bind-try", resolver, resolver] : []),
    ...(existsSync(tmux) ? ["--tmpfs", tmux] : []),
    ...(opts.socket ? ["--bind", dirname(socketPath(config)), dirname(socketPath(config))] : []),
    // The daemon's push may need the owner's SSH agent, which usually lives under /run.
    ...(opts.ssh && process.env.SSH_AUTH_SOCK && existsSync(process.env.SSH_AUTH_SOCK) ? ["--bind", dirname(process.env.SSH_AUTH_SOCK), dirname(process.env.SSH_AUTH_SOCK)] : []), "--"];
}

/** Proves the sandbox hides what it should on this machine. Exits 0 only when setup-token cannot be read. */
export async function checkSandbox(run: Runner, config: Config): Promise<boolean> {
  return run("systemd-run", ["--user", "--wait", "--pipe", "--collect", "--quiet", "--", ...sandbox(config), "/bin/sh", "-c", `! test -r '${join(config.paths.data, "setup-token").replaceAll("'", "'\\''")}'`.replaceAll("$", "$$$$")], { timeout: 15_000 }).then(() => true, () => false);
}

/** Lanes run agent code, so no lane starts on a machine where the sandbox is not working. */
export async function requireSandbox(run: Runner, config: Config): Promise<void> {
  if (!await checkSandbox(run, config)) throw new Refused("Lanes need bubblewrap to keep agents away from your sign-in tokens, and it is not working on this machine. Install it with sudo apt install bubblewrap, then try again.", 503);
}

/** Settings passed to every git the daemon runs, whatever the repository's own config says. */
export const GIT_GUARDS = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "protocol.ext.allow=never"];

/**
 * The daemon's own git and gh run in the same sandbox as the lanes. An agent can write a lane's
 * repository config, attributes and hooks, and git runs commands from all three (filters, diff and
 * merge drivers, fsmonitor, hooks, credential helpers). Checking the config first would race with
 * the agent, so instead anything git starts gets no more access than the agent already has. Hooks
 * and fsmonitor are also switched off, since the daemon never wants them.
 * If bubblewrap does not work here no lane can exist, so git runs with the guards alone.
 */
export function confineGit(run: Runner, config: Config, works: () => Promise<boolean> = () => checkSandbox(run, config)): Runner {
  let ready: Promise<boolean> | null = null;
  let checked = 0;
  const confined: Runner = async (cmd, args, opts) => {
    if (cmd !== "git" && cmd !== "gh") return run(cmd, args, opts);
    const full = cmd === "git" ? [...GIT_GUARDS, ...args] : args;
    // A working sandbox is remembered; a failed check is retried after a minute (bwrap installed meanwhile).
    if (!ready || (Date.now() - checked > 60_000 && !(await ready))) { checked = Date.now(); ready = works().catch(() => false); }
    if (!(await ready)) return run(cmd, full, opts);
    return run(sandbox(config, { ssh: true })[0]!, [...sandbox(config, { ssh: true }).slice(1), cmd, ...full], opts);
  };
  if (run.terminal) confined.terminal = run.terminal;
  return confined;
}
