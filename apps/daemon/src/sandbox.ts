import { createHash } from "node:crypto";
import { existsSync, realpathSync, statSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
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
 * Host files are read-only; writes are explicitly scoped to a checkout and its Git metadata. This
 * is local process/filesystem confinement, not a VM: networking and explicitly supplied credentials
 * are still available. Common Git metadata is necessarily shared between a repository's worktrees.
 */
export type SandboxOptions = {
  socket?: boolean; ssh?: boolean; laneData?: string; agentHome?: string;
  /** Generic ACP/probe adapters may read their host login; native agents use a private copy. */
  providerCredentials?: boolean;
  worktree?: string;
  /** Trusted owner checkout from the project store, never read from a lane's .git file. */
  repository?: string;
  /** Additional paths deliberately granted by daemon code, never agent arguments. */
  writable?: string[]; readable?: string[];
};

export function sandbox(config: Config, opts: SandboxOptions = {}): string[] {
  const { data } = config.paths;
  const home = homedir();
  const resolver = existsSync("/etc/resolv.conf") ? dirname(realpathSync("/etc/resolv.conf")) : null;
  const writable = [...new Set([...(opts.worktree ? [opts.worktree] : []), ...(opts.repository && opts.repository !== opts.worktree ? [join(opts.repository, ".git")] : []), ...(opts.writable ?? [])])];
  const dataSeal = ["--tmpfs", data, "--ro-bind-try", join(data, "releases"), join(data, "releases"), "--ro-bind-try", join(data, "app"), join(data, "app")];
  const insideGrant = (path: string) => writable.some((root) => resolve(path) === resolve(root) || resolve(path).startsWith(`${resolve(root)}/`));
  // Most package managers honor one of these. Their caches are ephemeral and cannot mutate a
  // cache in the owner's home or introduce hardlinks back into the owner's checkout.
  const caches = ["XDG_CACHE_HOME", "npm_config_cache", "PNPM_HOME", "YARN_CACHE_FOLDER", "UV_CACHE_DIR", "PIP_CACHE_DIR", "BUN_INSTALL_CACHE_DIR"];
  const gitCredentials = [".ssh", ".config/gh", ".git-credentials", ".netrc"];
  const secrets = [...(opts.ssh ? [] : gitCredentials), ".aws", ".docker", ".kube", ".gnupg", ".config/gcloud", ".azure", ".password-store"].map((p) => join(home, p));
  if (!opts.providerCredentials) secrets.push(join(process.env.CLAUDE_CONFIG_DIR ?? join(home, ".claude"), ".credentials.json"), join(home, ".claude.json"), join(process.env.CODEX_HOME ?? join(home, ".codex"), "auth.json"));
  return ["bwrap", "--ro-bind", "/", "/", "--unshare-pid", "--proc", "/proc", "--dev", "/dev",
    "--tmpfs", "/tmp", ...(existsSync("/var/tmp") && realpathSync("/var/tmp") !== "/tmp" ? ["--tmpfs", realpathSync("/var/tmp")] : []),
    // Host sockets and sibling process environments must not be available through /run or /proc.
    "--tmpfs", "/run", ...(resolver?.startsWith("/run/") ? ["--ro-bind-try", resolver, resolver] : []),
    // Development installs can themselves live in /tmp; keep only the application tree readable.
    "--ro-bind", fileURLToPath(new URL("../../../", import.meta.url)), fileURLToPath(new URL("../../../", import.meta.url)),
    "--tmpfs", config.paths.lanes,
    ...dataSeal,
    ...writable.flatMap((path) => ["--bind", path, path]),
    // A direct checkout can contain the configured data/lanes directories. A broad checkout grant
    // must not reveal those again. Daemon lifecycle commands have separately reviewed write grants.
    ...(!opts.ssh && insideGrant(config.paths.lanes) ? ["--tmpfs", config.paths.lanes] : []),
    ...(!opts.ssh && insideGrant(data) ? dataSeal : []),
    ...(opts.readable ?? []).flatMap((path) => ["--ro-bind", path, path]),
    // Mount these after writable grants, in case an owner deliberately runs a direct lane from home.
    "--tmpfs", dirname(configPath()),
    ...secrets.filter(existsSync).flatMap((path) => statSync(path).isDirectory() ? ["--tmpfs", path] : ["--ro-bind", "/dev/null", path]),
    ...(opts.socket ? ["--ro-bind", dirname(socketPath(config)), dirname(socketPath(config))] : []),
    ...(opts.laneData ? ["--ro-bind", opts.laneData, opts.laneData] : []),
    ...(opts.agentHome ? ["--bind", opts.agentHome, opts.agentHome] : []),
    // The daemon's push may need the owner's SSH agent, which usually lives under /run.
    ...(opts.ssh && process.env.SSH_AUTH_SOCK && existsSync(process.env.SSH_AUTH_SOCK) ? ["--ro-bind", process.env.SSH_AUTH_SOCK, process.env.SSH_AUTH_SOCK] : []),
    ...caches.flatMap((name) => ["--setenv", name, `/tmp/cl-cache/${name.toLowerCase()}`]),
    "--setenv", "TMPDIR", "/tmp", "--unsetenv", "DBUS_SESSION_BUS_ADDRESS", "--unsetenv", "DOCKER_HOST", "--"];
}

/** Checks that bubblewrap can start in a user unit and the daemon token is hidden. */
export async function checkSandbox(run: Runner, config: Config): Promise<boolean> {
  // A read-only root cannot create missing mount points. These are owner-configured directories,
  // and must exist before the first lane starts, not only after a checkout has been created.
  try { await Promise.all([config.paths.data, config.paths.lanes, dirname(configPath())].map((path) => mkdir(path, { recursive: true, mode: 0o700 }))); }
  catch { return false; }
  return run("systemd-run", ["--user", "--wait", "--pipe", "--collect", "--quiet", "--", ...sandbox(config), "/bin/sh", "-c", `! test -r '${join(config.paths.data, "setup-token").replaceAll("'", "'\\''")}'`.replaceAll("$", "$$$$")], { timeout: 15_000 }).then(() => true, () => false);
}

/** Lanes run agent code, so no lane starts on a machine where the sandbox is not working. */
export async function requireSandbox(run: Runner, config: Config): Promise<void> {
  if (!await checkSandbox(run, config)) throw new Refused("Lanes need a working bubblewrap sandbox. Install bubblewrap and check that user namespaces are enabled, then try again.", 503);
}

/** Settings passed to every git the daemon runs, whatever the repository's own config says. */
export const GIT_GUARDS = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "protocol.ext.allow=never"];

/**
 * The daemon's own git and gh use the same confinement primitives as the lanes. An agent can write a lane's
 * repository config, attributes and hooks, and git runs commands from all three (filters, diff and
 * merge drivers, fsmonitor, hooks, credential helpers). Checking the config first would race with
 * the agent, so subprocesses stay inside explicit filesystem grants. Git authentication and checkout
 * lifecycle operations need extra grants; this is not protection from every repository-controlled
 * Git helper. Hooks and fsmonitor are switched off. Existing projects fail closed if confinement is
 * unavailable; unregistered bootstrap repositories can still be inspected with the guards alone.
 */
export function confineGit(run: Runner, config: Config, works: () => Promise<boolean> = () => checkSandbox(run, config), repositoryFor: (cwd: string) => string | undefined = (cwd) => config.projects.find((p) => p.path === cwd)?.path): Runner {
  let ready: Promise<boolean> | null = null;
  let checked = 0;
  const confined: Runner = async (cmd, args, opts) => {
    if (cmd !== "git" && cmd !== "gh") return run(cmd, args, opts);
    const full = cmd === "git" ? [...GIT_GUARDS, ...args] : args;
    const cwd = opts?.cwd;
    const repository = cwd ? repositoryFor(cwd) : undefined;
    // A working sandbox is remembered; a failed check is retried after a minute (bwrap installed meanwhile).
    if (!ready || (Date.now() - checked > 60_000 && !(await ready))) { checked = Date.now(); ready = works().catch(() => false); }
    if (!(await ready)) {
      if (repository) throw new Refused("Git for an existing project needs a working bubblewrap sandbox.", 503);
      return run(cmd, full, opts);
    }
    // Lifecycle commands create/remove checkout roots, so their trusted destination parent needs
    // a temporary write grant. Ordinary git only gets its cwd and the configured repository metadata.
    const writable: string[] = [];
    if (cmd === "git" && args[0] === "worktree" && ["add", "remove"].includes(args[1] ?? "")) {
      const tail = args.slice(2); let target: string | undefined;
      for (let i = 0; i < tail.length; i++) { if (["-b", "-B"].includes(tail[i]!)) { i++; continue; } if (!tail[i]!.startsWith("-")) { target = tail[i]; break; } }
      if (target) writable.push(dirname(resolve(cwd ?? process.cwd(), target)));
    }
    if (cmd === "gh" && args[0] === "repo" && args[1] === "clone" && args[3]) writable.push(dirname(resolve(args[3])));
    const prefix = sandbox(config, { ssh: true, ...(cwd ? { worktree: cwd } : {}), ...(repository ? { repository } : {}), writable });
    return run(prefix[0]!, [...prefix.slice(1), cmd, ...full], opts);
  };
  if (run.terminal) confined.terminal = run.terminal;
  return confined;
}
