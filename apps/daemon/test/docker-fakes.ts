import type { Runner } from "@contextlanes/daemon";
import type { ControlInfo } from "../src/docker/control.js";

/** The control container as docker inspect describes a healthy stack. */
export const CONTROL: ControlInfo = {
  id: "c0ffee", name: "contextlanes", image: "sha256:image", data: "/opt/stacks/contextlanes/data", socket: "/var/run/docker.sock",
  mounts: [{ type: "bind", source: "/opt/stacks/contextlanes/data", destination: "/data" }, { type: "bind", source: "/var/run/docker.sock", destination: "/var/run/docker.sock" }, { type: "volume", source: "contextlanes-tools", destination: "/var/lib/contextlanes-tools" }],
  published: [{ port: "4601/tcp", host: "127.0.0.1:4601" }], networks: ["contextlanes"],
};

/** A fake Docker: answers the stat and git helpers, and records every argv. */
export function fakeDocker(opts: { owner?: string; top?: string; gitDir?: string; branches?: string; fail?: RegExp } = {}) {
  const calls: { cmd: string; args: string[]; timeout?: number }[] = [];
  const run: Runner = async (cmd, args, o) => {
    calls.push({ cmd, args, ...(o?.timeout !== undefined ? { timeout: o.timeout } : {}) });
    if (cmd !== "docker") throw Object.assign(new Error(`${cmd} is not installed`), { code: "ENOENT" });
    const line = args.join(" ");
    if (opts.fail?.test(line)) throw new Error(`docker run failed (exit 125): ${line.includes("stat") ? "invalid mount config for type \"bind\": bind source path does not exist" : "fatal: not a git repository"}`);
    const entry = args[args.indexOf("--entrypoint") + 1];
    const after = args.slice(args.indexOf("--entrypoint") + 3);
    if (entry === "stat") return { stdout: `${opts.owner ?? "1000:1000"}\n` };
    if (entry === "git") {
      const sub = after.filter((a, i) => !(a === "-c" || after[i - 1] === "-c"));
      const cwd = args[args.indexOf("-w") + 1]!;
      if (sub[0] === "rev-parse" && sub.includes("--absolute-git-dir")) return { stdout: `${opts.top ?? cwd}\n${opts.gitDir ?? `${opts.top ?? cwd}/.git`}\n` };
      if (sub[0] === "rev-parse") return { stdout: `${cwd}\n` };
      if (sub[0] === "for-each-ref") return { stdout: sub.at(-1) === "refs/heads" ? (opts.branches ?? "main\nfeature\n") : "" };
      if (sub[0] === "branch") return { stdout: "main\n" };
      return { stdout: "" };
    }
    return { stdout: "" };
  };
  return { run, calls };
}


/**
 * A fake Docker for the supervisor contract: `docker exec [-d] [-i] [-t] [-u U] [-w DIR] [-e K[=V]]… C argv…`
 * runs argv on this machine, in DIR, with those variables (a bare -e K takes K from the Runner's env, as
 * the docker CLI does). -u is ignored: the test runs as one user. Real processes, so the contract's checks
 * (pids alive, process groups, listening sockets in /proc) mean what they say. Anything else is refused.
 */
export function localDocker(): { run: Runner; calls: string[][] } {
  const calls: string[][] = [];
  const run: Runner = async (cmd, args, opts = {}) => {
    calls.push([cmd, ...args]);
    if (cmd !== "docker" || args[0] !== "exec") throw new Error(`the fake docker only runs exec: ${cmd} ${args.join(" ")}`);
    let i = 1, detach = false, dir = "/";
    const env: Record<string, string> = {};
    for (; i < args.length; i++) {
      const a = args[i]!;
      if (a === "-d") detach = true;
      else if (a === "-i" || a === "-t") continue;
      else if (a === "-u") i++;
      else if (a === "-w") dir = args[++i]!;
      else if (a === "-e") { const kv = args[++i]!; const eq = kv.indexOf("="); if (eq < 0) env[kv] = opts.env?.[kv] ?? process.env[kv] ?? ""; else env[kv.slice(0, eq)] = kv.slice(eq + 1); }
      else break;
    }
    const argv = args.slice(i + 1);
    if (detach) {
      const { spawn } = await import("node:child_process");
      const child = spawn(argv[0]!, argv.slice(1), { cwd: dir, env: { ...process.env, ...env }, detached: true, stdio: "ignore" });
      await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
      child.unref();
      return { stdout: "" };
    }
    const { runCommand } = await import("../src/run.js");
    return runCommand(argv[0]!, argv.slice(1), { cwd: dir, env, ...(opts.timeout !== undefined ? { timeout: opts.timeout } : {}), ...(opts.input !== undefined ? { input: opts.input } : {}) });
  };
  return { run, calls };
}

/** One call the lane fake saw: argv, the Runner's env (secrets) and stdin. */
export type DockerCall = { args: string[]; env?: Record<string, string>; input?: string; timeout?: number };

/**
 * A fake Docker for lane containers: answers the git helpers, the lanes-folder helper, the look helper,
 * the Dev Container CLI helper (read-configuration and up), inspect, exec, network and rm, and records
 * every call. `fail` makes the first call whose argv matches throw, as the docker CLI would.
 */
export function laneDocker(opts: { owner?: string; uid?: string; found?: string; configuration?: Record<string, unknown>; extraMounts?: { Type: string; Source: string; Destination: string; RW?: boolean }[]; privileged?: boolean;
  names?: string; ps?: string; worktrees?: string; status?: string | null; fail?: RegExp; image?: string } = {}) {
  const calls: DockerCall[] = [];
  let up: { worktree: string; git: string; home: string } | null = null;
  let failed = false;
  const run: Runner = async (cmd, args, o) => {
    calls.push({ args, ...(o?.env ? { env: o.env } : {}), ...(o?.input !== undefined ? { input: o.input } : {}), ...(o?.timeout !== undefined ? { timeout: o.timeout } : {}) });
    if (cmd !== "docker") throw Object.assign(new Error(`${cmd} is not installed`), { code: "ENOENT" });
    const line = args.join(" ");
    if (opts.fail && !failed && opts.fail.test(line)) {
      failed = true;
      throw Object.assign(new Error(`docker ${args[0]} failed (exit 1): fake failure`), { stdout: args.includes("up") ? '{"outcome":"error","message":"image pull failed","description":"no registry"}\n' : "" });
    }
    const after = (flag: string) => args[args.indexOf(flag) + 1]!;
    switch (args[0]) {
      case "ps": return { stdout: args.includes("--filter") ? opts.ps ?? "" : opts.names ?? "contextlanes\n" };
      case "network": case "rm": case "image": case "stop": case "volume": return { stdout: "" };
      case "inspect": {
        const u = up ?? { worktree: "/w", git: "/p/.git", home: "contextlanes-agent-home-1000" };
        return { stdout: JSON.stringify([{ Id: "f00dfeed1234", Name: "/cl-shop-01", Config: { Image: opts.image ?? "vsc-01-fix-login-0123abcd-uid", Env: ["PATH=/usr/local/bin:/usr/bin:/bin", "LANG=C.UTF-8"], Labels: { "contextlanes.lane": "shop/01" } },
          HostConfig: { Privileged: !!opts.privileged },
          Mounts: [{ Type: "bind", Source: u.worktree, Destination: u.worktree, RW: true }, { Type: "bind", Source: u.git, Destination: u.git, RW: true },
            { Type: "volume", Name: "contextlanes-tools", Source: "/var/lib/docker/volumes/contextlanes-tools/_data", Destination: "/opt/contextlanes", RW: false },
            { Type: "volume", Name: u.home, Source: `/var/lib/docker/volumes/${u.home}/_data`, Destination: "/opt/contextlanes-home", RW: true }, ...(opts.extraMounts ?? [])],
          State: { Running: true, Status: "running" } }]) };
      }
      case "exec": {
        if (line.includes("id -u && id -g")) { const [u, g] = (opts.uid ?? opts.owner ?? "1000:1000").split(":"); return { stdout: `${u}\n${g}\n` }; }
        return { stdout: "" };
      }
      case "run": {
        const entry = after("--entrypoint");
        const rest = args.slice(args.indexOf("--entrypoint") + 3);
        if (entry === "stat") return { stdout: `${opts.owner ?? "1000:1000"}\n` };
        if (entry === "git") {
          const sub = rest.filter((a, i) => !(a === "-c" || rest[i - 1] === "-c" || a === "-C" || rest[i - 1] === "-C"));
          if (sub[0] === "worktree" && sub[1] === "list") return { stdout: opts.worktrees ?? "" };
          if (sub[0] === "status") { if (opts.status === null) throw new Error("fatal: cannot change to the checkout"); return { stdout: opts.status ?? "" }; }
          if (sub[0] === "rev-list") return { stdout: "2\n" };
          if (sub[0] === "rev-parse" && sub.includes("--absolute-git-dir")) { const cwd = after("-w"); return { stdout: `${cwd}\n${cwd}/.git\n` }; }
          if (sub[0] === "rev-parse" && sub.some((a) => a.startsWith("refs/remotes/"))) throw new Error("not a ref");
          if (sub[0] === "for-each-ref") return { stdout: "main\n" };
          return { stdout: "" };
        }
        if (entry === "sh" && args.includes("-v") && !args.includes("devcontainer")) return { stdout: `${opts.owner ?? "1000:1000"}\n` };
        if (entry === "sh" && rest.includes("devcontainer")) {
          if (rest.includes("read-configuration")) return { stdout: `${JSON.stringify({ configuration: opts.configuration ?? { image: "node:24", remoteUser: "node" } })}\n` };
          const wt = rest[rest.indexOf("--workspace-folder") + 1]!;
          const mounts = rest.filter((_, i) => rest[i - 1] === "--mount");
          const git = /target=([^,]+)$/.exec(mounts.find((m) => m.includes(".git"))!)![1]!;
          const home = /source=([^,]+),/.exec(mounts.find((m) => m.includes("contextlanes-home"))!)![1]!;
          up = { worktree: wt, git, home };
          return { stdout: `[1 ms] Start: Run: docker build\n${JSON.stringify({ outcome: "success", containerId: "f00dfeed1234", remoteUser: "vscode", remoteWorkspaceFolder: wt })}\n` };
        }
        if (entry === "sh") return { stdout: opts.found ? `${opts.found}\n` : "" };
        return { stdout: "" };
      }
      default: return { stdout: "" };
    }
  };
  return { run, calls };
}
