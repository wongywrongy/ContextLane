import { createHash } from "node:crypto";
import { existsSync, realpathSync, statSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { configPath, type Config } from "./config.js";
import { Refused } from "./lanes/manager.js";
import type { Runner } from "./run.js";
import { supervisorFor } from "./supervisor/index.js";

// A masked worktree is not a missing worktree. Never let Git's automatic cleanup infer deletion
// from this namespace, including when Git is a child of gh, an agent, or a dependency script.
const GIT_MAINTENANCE = { "gc.auto": "0", "maintenance.auto": "false", "gc.worktreePruneExpire": "never" };
export const GIT_MAINTENANCE_GUARDS = Object.entries(GIT_MAINTENANCE).flatMap(([key, value]) => ["-c", `${key}=${value}`]);

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
  // The owner turned confinement off in config (machines without bubblewrap): commands run as they are.
  if (config.sandbox.mode === "off") return [];
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
    // Replace inherited command-scope Git overrides: they could enable cleanup, and copying their
    // possibly secret values into bwrap arguments would expose credentials in process listings.
    "--unsetenv", "GIT_CONFIG_PARAMETERS", "--setenv", "GIT_CONFIG_COUNT", String(Object.keys(GIT_MAINTENANCE).length),
    ...Object.entries(GIT_MAINTENANCE).flatMap(([key, value], index) => ["--setenv", `GIT_CONFIG_KEY_${index}`, key, "--setenv", `GIT_CONFIG_VALUE_${index}`, value]),
    "--setenv", "TMPDIR", "/tmp", "--unsetenv", "DBUS_SESSION_BUS_ADDRESS", "--unsetenv", "DOCKER_HOST", "--"];
}

/** A command inside the sandbox, as the program to run and its arguments. */
export function inSandbox(config: Config, argv: string[], opts: Parameters<typeof sandbox>[1] = {}): [string, string[]] {
  const all = [...sandbox(config, opts), ...argv];
  return [all[0]!, all.slice(1)];
}

/** Proves the sandbox hides what it should on this machine: true only when setup-token cannot be read from inside it. */
export async function checkSandbox(run: Runner, config: Config): Promise<boolean> {
  if (config.sandbox.mode === "off") return false;
  // A read-only root cannot create missing mount points; these owner-configured folders must exist first.
  try { await Promise.all([config.paths.data, config.paths.lanes, dirname(configPath())].map((path) => mkdir(path, { recursive: true, mode: 0o700 }))); }
  catch { return false; }
  const token = join(config.paths.data, "setup-token").replaceAll("'", "'\\''");
  const result = await supervisorFor(config, run).oneshot({ dir: "/", argv: [...sandbox(config), "/bin/sh", "-c", `! test -r '${token}'`], env: { PATH: process.env.PATH ?? "/usr/bin:/bin" }, timeoutSeconds: 15 }).catch(() => null);
  return !!result?.ok;
}

/**
 * Lanes run agent code, so no agent starts on a machine where the sandbox is not working, unless the
 * owner turned it off in config, which every lane then records.
 */
export async function requireSandbox(run: Runner, config: Config): Promise<void> {
  if (config.sandbox.mode === "off") return;
  if (!await checkSandbox(run, config)) throw new Refused(`Lanes need bubblewrap to keep agents away from your sign-in tokens, and it is not working on this machine. Install it (Debian and Ubuntu: sudo apt install bubblewrap), then try again. Where it cannot run, such as macOS, you can turn confinement off with [sandbox] mode = "off" in ${configPath()}; agents then run with your full access.`, 503, "sandbox_unavailable");
}

/** Settings passed to every git the daemon runs, whatever the repository's own config says. */
export const GIT_GUARDS = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "protocol.ext.allow=never", ...GIT_MAINTENANCE_GUARDS];

/** Locate the builtin after Git's global flags, without interpreting aliases or shell strings. */
function gitCommandIndex(args: string[]): number {
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (!arg.startsWith("-")) return index;
    if (arg === "--") return index + 1;
    if (["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--config-env"].includes(arg)) {
      if (args[++index] === undefined) throw new Refused("Git is missing a global option value.", 400);
      continue;
    }
    if (/^-(?:C|c).+|^--(?:git-dir|work-tree|namespace|config-env|exec-path|list-cmds)=/.test(arg)) continue;
    if (["--no-pager", "--paginate", "--bare", "--no-replace-objects", "--literal-pathspecs", "--glob-pathspecs", "--noglob-pathspecs", "--icase-pathspecs", "--no-optional-locks", "--no-lazy-fetch", "--no-advice", "--version", "-v", "--help", "-h", "--exec-path", "--html-path", "--man-path", "--info-path"].includes(arg)) continue;
    throw new Refused(`Unsupported Git global option: ${arg}`, 400);
  }
  return args.length;
}

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
    const commandIndex = cmd === "git" ? gitCommandIndex(args) : 0;
    const command = args.slice(commandIndex);
    if (cmd === "git" && (["gc", "maintenance", "prune"].includes(command[0] ?? "") || command[0] === "worktree" && command.slice(1).find((arg) => !arg.startsWith("-")) === "prune")) {
      throw new Refused("Repository-wide Git cleanup cannot run in a sandbox that hides other worktrees. Run intentional cleanup from the owner's full host view.", 409);
    }
    // Caller -c flags come first: these safety settings must win over caller/global/repository config.
    const full = cmd === "git" ? [...args.slice(0, commandIndex), ...GIT_GUARDS, ...command] : args;
    // In the Docker runtime git on a project runs in a helper container (docker/folders.ts), which is the
    // confinement: it sees only that folder, as its owner, with no network. There is no bubblewrap there.
    if (config.sandbox.mode === "off" || config.runtime.mode === "docker") return run(cmd, full, opts);
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
    if (cmd === "git" && command[0] === "worktree" && ["add", "remove"].includes(command[1] ?? "")) {
      const tail = command.slice(2); let target: string | undefined;
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
