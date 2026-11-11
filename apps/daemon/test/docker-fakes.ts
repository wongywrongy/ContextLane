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

