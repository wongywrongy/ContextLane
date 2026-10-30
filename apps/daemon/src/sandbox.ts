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
export function sandbox(config: Config, opts: { socket?: boolean } = {}): string[] {
  const { data } = config.paths;
  const tmux = `/tmp/tmux-${process.getuid?.() ?? 0}`;
  const resolver = existsSync("/etc/resolv.conf") ? dirname(realpathSync("/etc/resolv.conf")) : null;
  return ["bwrap", "--dev-bind", "/", "/",
    "--tmpfs", data, "--ro-bind-try", join(data, "releases"), join(data, "releases"), "--ro-bind-try", join(data, "app"), join(data, "app"),
    "--tmpfs", dirname(configPath()),
    // /run holds every way out of the sandbox: the systemd user bus, Docker and Tailscale.
    "--tmpfs", "/run", ...(resolver?.startsWith("/run/") ? ["--ro-bind-try", resolver, resolver] : []),
    ...(existsSync(tmux) ? ["--tmpfs", tmux] : []),
    ...(opts.socket ? ["--bind", dirname(socketPath(config)), dirname(socketPath(config))] : []), "--"];
}

/** Proves the sandbox hides what it should on this machine. Exits 0 only when setup-token cannot be read. */
export async function checkSandbox(run: Runner, config: Config): Promise<boolean> {
  return run("systemd-run", ["--user", "--wait", "--pipe", "--collect", "--quiet", "--", ...sandbox(config), "/bin/sh", "-c", `! test -r '${join(config.paths.data, "setup-token").replaceAll("'", "'\\''")}'`.replaceAll("$", "$$$$")], { timeout: 15_000 }).then(() => true, () => false);
}

/** Lanes run agent code, so no lane starts on a machine where the sandbox is not working. */
export async function requireSandbox(run: Runner, config: Config): Promise<void> {
  if (!await checkSandbox(run, config)) throw new Refused("Lanes need bubblewrap to keep agents away from your sign-in tokens, and it is not working on this machine. Install it with sudo apt install bubblewrap, then try again.", 503);
}
