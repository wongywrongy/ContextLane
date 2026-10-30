import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Config, confineGit, GIT_GUARDS, runCommand, type Runner } from "@contextlanes/daemon";

const cleanups: string[] = [];
afterEach(async () => { for (const dir of cleanups.splice(0)) await rm(dir, { recursive: true, force: true }); });

describe("daemon git", () => {
  it("runs git and gh in the lane sandbox with hooks and fsmonitor off, and leaves other commands alone", async () => {
    const calls: string[][] = [];
    const inner: Runner = Object.assign(async (cmd: string, args: string[]) => { calls.push([cmd, ...args]); return { stdout: "" }; }, { terminal: () => { throw new Error("unused"); } });
    const config = Config.parse({ paths: { data: "/tmp/cl-data", lanes: "/tmp/cl-lanes" } });
    const run = confineGit(inner, config, async () => true);
    await run("git", ["status", "--porcelain"], { cwd: "/w" });
    await run("gh", ["pr", "view"]);
    await run("systemd-run", ["--user", "x"]);
    expect(calls[0]![0]).toBe("bwrap");
    expect(calls[0]).toEqual(expect.arrayContaining(["--tmpfs", "/tmp/cl-data"]));
    expect(calls[0]!.slice(calls[0]!.indexOf("--") + 1)).toEqual(["git", ...GIT_GUARDS, "status", "--porcelain"]);
    expect(calls[1]!.slice(calls[1]!.indexOf("--") + 1)).toEqual(["gh", "pr", "view"]);
    expect(calls[2]).toEqual(["systemd-run", "--user", "x"]);
    expect(run.terminal).toBe(inner.terminal);
  });

  it("falls back to the guards alone where the sandbox does not work", async () => {
    const calls: string[][] = [];
    const run = confineGit(async (cmd, args) => { calls.push([cmd, ...args]); return { stdout: "" }; }, Config.parse({}), async () => false);
    await run("git", ["diff"]);
    expect(calls[0]).toEqual(["git", ...GIT_GUARDS, "diff"]);
  });

  const bwrap = spawnSync("bwrap", ["--dev-bind", "/", "/", "--", "true"]).status === 0;
  it.skipIf(!bwrap)("code planted in a lane repository cannot reach the data folder or run as a hook", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "cl-confine-")));
    cleanups.push(root);
    const data = join(root, "data"); const repo = join(root, "repo"); const proof = join(root, "proof");
    await mkdir(data); await mkdir(repo); await mkdir(proof);
    await writeFile(join(data, "setup-token"), "secret-token");
    const git = (...args: string[]) => runCommand("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args], { cwd: repo });
    await git("init", "-q"); await writeFile(join(repo, "a.txt"), "one\n"); await git("add", "-A"); await git("commit", "-qm", "one");
    // What an agent could plant: a textconv driver, a hook, and fsmonitor.
    await writeFile(join(repo, ".gitattributes"), "*.txt diff=evil\n");
    await git("config", "diff.evil.textconv", `sh -c 'cat ${data}/setup-token > ${proof}/textconv 2>/dev/null; echo ran >> ${proof}/textconv-ran; cat "$0"'`);
    await writeFile(join(repo, ".git/hooks/post-checkout"), `#!/bin/sh\ntouch ${proof}/hook\n`, { mode: 0o755 });
    await writeFile(join(repo, "a.txt"), "two\n"); await git("commit", "-qam", "two");
    await git("config", "core.fsmonitor", `sh -c 'touch ${proof}/fsmonitor'`);
    await writeFile(join(repo, "a.txt"), "three\n");

    const run = confineGit(runCommand, Config.parse({ paths: { data, lanes: join(root, "lanes") } }), async () => true);
    await run("git", ["log", "-p", "-1"], { cwd: repo });
    await run("git", ["status", "--porcelain"], { cwd: repo });
    await run("git", ["checkout", "-q", "-b", "other"], { cwd: repo });
    await run("git", ["status"], { cwd: repo });

    expect(await readFile(join(proof, "textconv-ran"), "utf8")).toContain("ran"); // It ran, but sandboxed:
    expect(await readFile(join(proof, "textconv"), "utf8")).toBe("");
    await expect(access(join(proof, "hook"))).rejects.toThrow();
    await expect(access(join(proof, "fsmonitor"))).rejects.toThrow();
  });
});
