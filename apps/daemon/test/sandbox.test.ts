import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Config, confineGit, runCommand, sandbox } from "@contextlanes/daemon";

const bwrap = spawnSync("bwrap", ["--ro-bind", "/", "/", "--unshare-pid", "--proc", "/proc", "--", "true"]).status === 0;
const roots: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

describe.skipIf(!bwrap)("sandbox filesystem and process boundary", () => {
  it("permits checkout and cache writes while sealing owner files, sibling lanes, credentials and host processes", async () => {
    // Outside /tmp: verify the read-only host mount, not just the private temporary directory.
    const root = await mkdtemp(join(process.cwd(), "node_modules/.sandbox-test-")); roots.push(root);
    const home = join(root, "home"); const worktree = join(root, "lanes/one"); const sibling = join(root, "lanes/two"); const data = join(root, "data");
    for (const dir of [join(home, ".ssh"), join(home, ".config/contextlanes"), worktree, sibling, data]) await mkdir(dir, { recursive: true });
    await writeFile(join(home, "keep"), "owner"); await writeFile(join(home, ".ssh/id_ed25519"), "key");
    await writeFile(join(sibling, "secret"), "other-lane"); await writeFile(join(data, "setup-token"), "owner-token");
    await symlink(join(home, "keep"), join(worktree, "outside"));
    vi.stubEnv("HOME", home);
    const config = Config.parse({ paths: { data, lanes: join(root, "lanes") } });
    const prefix = sandbox(config, { worktree });
    const script = [
      "set -eu", `echo ok > '${worktree}/result'`, 'mkdir -p "$npm_config_cache"', 'echo cached > "$npm_config_cache/item"',
      `test "$(cat '${home}/keep')" = owner`, `! echo changed > '${home}/keep'`, `! echo changed > '${worktree}/outside'`,
      `! test -r '${home}/.ssh/id_ed25519'`, `! test -r '${sibling}/secret'`, `! test -r '${data}/setup-token'`,
      `! test -r /proc/${process.pid}/environ`, "echo private > /tmp/cl-private-check", "echo sealed",
    ].join("\n");
    expect((await runCommand(prefix[0]!, [...prefix.slice(1), "/bin/sh", "-c", script], { cwd: worktree })).stdout.trim()).toBe("sealed");
    expect(await readFile(join(home, "keep"), "utf8")).toBe("owner");
    expect(await readFile(join(worktree, "result"), "utf8")).toBe("ok\n");
  });

  it("uses trusted project metadata for real worktree commits, fetch and merge", async () => {
    const root = await mkdtemp(join(process.cwd(), "node_modules/.sandbox-test-")); roots.push(root);
    const repo = join(root, "repo"); const worktree = join(root, "lanes/one"); const data = join(root, "data");
    await mkdir(repo); await mkdir(join(root, "lanes")); await mkdir(data);
    const git = (...args: string[]) => runCommand("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", ...args], { cwd: repo });
    await git("init", "-qb", "main"); await writeFile(join(repo, "a"), "base"); await git("add", "."); await git("commit", "-qm", "base");
    const config = Config.parse({ paths: { data, lanes: join(root, "lanes") } });
    // The store callback is authoritative even when config.projects does not contain this repository.
    const confined = confineGit(runCommand, config, async () => true, (cwd) => [repo, worktree].includes(cwd) ? repo : undefined);
    await confined("git", ["worktree", "add", "-b", "topic", worktree], { cwd: repo });
    const prefix = sandbox(config, { worktree, repository: repo });
    await runCommand(prefix[0]!, [...prefix.slice(1), "/bin/sh", "-c", "echo lane > b; git add b; git -c user.name=Test -c user.email=test@example.invalid commit -qm lane"], { cwd: worktree });
    await writeFile(join(repo, "c"), "main"); await git("add", "."); await git("commit", "-qm", "main");
    // Fetch from shared metadata exercises FETCH_HEAD writes without depending on the network.
    await confined("git", ["fetch", join(repo, ".git"), "main"], { cwd: worktree });
    await confined("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "merge", "--no-edit", "FETCH_HEAD"], { cwd: worktree });
    expect(await readFile(join(worktree, "c"), "utf8")).toBe("main");
    await confined("git", ["worktree", "remove", worktree], { cwd: repo });
  });

  it("keeps private data hidden when a direct checkout contains the data directory", async () => {
    const root = await mkdtemp(join(process.cwd(), "node_modules/.sandbox-test-")); roots.push(root);
    await mkdir(join(root, "data")); await mkdir(join(root, "lanes/two"), { recursive: true });
    await writeFile(join(root, "data/setup-token"), "owner"); await writeFile(join(root, "lanes/two/secret"), "sibling");
    const config = Config.parse({ paths: { data: join(root, "data"), lanes: join(root, "lanes") } });
    const prefix = sandbox(config, { worktree: root });
    const script = "set -eu; echo ok > result; ! test -r data/setup-token; ! test -r lanes/two/secret";
    await runCommand(prefix[0]!, [...prefix.slice(1), "/bin/sh", "-c", script], { cwd: root });
    expect(await readFile(join(root, "result"), "utf8")).toBe("ok\n");
  });
});

it("refuses existing-project git if confinement stops working", async () => {
  let called = false;
  const run = confineGit(async () => { called = true; return { stdout: "" }; }, Config.parse({}), async () => false, () => "/trusted/repo");
  await expect(run("git", ["status"], { cwd: "/trusted/lane" })).rejects.toThrow(/working bubblewrap/);
  expect(called).toBe(false);
});
