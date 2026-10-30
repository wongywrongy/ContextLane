import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, readlink, realpath, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Updater, layoutOf, runCommand, type Runner } from "@contextlanes/daemon";
import { installService } from "../src/install.js";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const clean of cleanups.splice(0).reverse()) await clean(); });
const git = (cwd: string, ...args: string[]) => runCommand("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "init.defaultBranch=main", ...args], { cwd }).then((r) => r.stdout.trim());

async function commit(work: string, message: string, file = "CHANGES.md") {
  await writeFile(join(work, file), `${message}\n`, { flag: "a" });
  await git(work, "add", "-A"); await git(work, "commit", "-q", "-m", message); await git(work, "push", "-q", "origin", "HEAD:main");
  return git(work, "rev-parse", "HEAD");
}
const userVersion = (file: string) => { const db = new DatabaseSync(file); try { return Number((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version); } finally { db.close(); } };
const setUserVersion = (file: string, v: number) => { const db = new DatabaseSync(file); try { db.exec(`PRAGMA user_version = ${v}`); } finally { db.close(); } };

/** An installed copy: a bare remote, the clone install.sh made in ~/.local/share/contextlanes/app, a database and a service. */
async function fixture(options: { migrateOnStart?: boolean; neverHealthy?: boolean; base?: string; publicUrl?: string } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "cl-update-")));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const base = options.base ? join(root, options.base) : join(home, ".local/share/contextlanes");
  const remote = join(root, "remote.git"); const work = join(root, "work"); const app = join(base, "app");
  await mkdir(base, { recursive: true }); await mkdir(work);
  await git(root, "init", "-q", "--bare", remote);
  await git(work, "init", "-q"); await git(work, "remote", "add", "origin", remote);
  await writeFile(join(work, ".gitignore"), "node_modules/\ndist/\n");
  await writeFile(join(work, "package.json"), JSON.stringify({ name: "contextlanes", packageManager: "pnpm@10.28.0" }));
  const first = await commit(work, "First version");
  await git(root, "clone", "-q", "--branch", "main", remote, app);
  await mkdir(join(app, "apps/daemon/dist"), { recursive: true }); await writeFile(join(app, "apps/daemon/dist/main.js"), "// built");
  const data = join(root, "data"); await mkdir(data);
  const database = join(data, "contextlanes.sqlite");
  { const db = new DatabaseSync(database); db.exec("CREATE TABLE lane (id TEXT); INSERT INTO lane VALUES ('shop/01'); PRAGMA user_version = 3;"); db.close(); }
  const calls: string[] = [];
  let running: string | null = app;
  const versionOf = async (dir: string) => (await git(dir, "rev-parse", "HEAD")).slice(0, 12);
  const run: Runner = async (cmd, args, opts) => {
    if (cmd === "git") return runCommand(cmd, args, opts);
    calls.push([cmd, ...args].join(" "));
    if (cmd === "npm" && args.at(-1) === "build") { await mkdir(join(opts!.cwd!, "apps/daemon/dist"), { recursive: true }); await writeFile(join(opts!.cwd!, "apps/daemon/dist/main.js"), "// built"); }
    if (cmd === "systemctl" && args[1] === "stop") running = null;
    if (cmd === "systemctl" && ["restart", "start"].includes(args[1]!)) {
      running = await realpath(join(base, "current")).catch(() => app);
      if (options.migrateOnStart && running !== app) setUserVersion(database, 4);
    }
    return { stdout: "" };
  };
  const health = async (url: string | URL | Request) => {
    if (!running) throw new Error("down");
    if (String(url).endsWith("/api/lanes")) return Response.json([{ state: "working" }, { state: "needs_you" }, { state: "merged" }]);
    const version = options.neverHealthy && running !== app ? "crashed" : await versionOf(running);
    return Response.json({ ok: true, version, host: "neo" });
  };
  await installService({ root: app, home, node: process.execPath, run });
  calls.length = 0;
  const logs: string[] = [];
  let processes: string[] = [];
  const updater = async () => new Updater({ run, fetch: health as typeof fetch, log: (l) => logs.push(l), sleep: async () => {}, processes: async () => processes, home, node: process.execPath,
    layout: await layoutOf(app, home), data, port: 4600, healthSeconds: 1, publicUrl: options.publicUrl ?? null });
  return { root, home, base, app, work, remote, data, database, first, calls, logs, updater, setProcesses: (p: string[]) => { processes = p; } };
}

describe("contextlanes update", () => {
  it("builds the new version beside the running one, backs up the database, switches and restarts", async () => {
    const f = await fixture();
    const second = await commit(f.work, "Second version");
    expect(await (await f.updater()).update()).toBe(0);
    const release = join(f.base, "releases", second.slice(0, 12));
    expect(await realpath(join(f.base, "current"))).toBe(release);
    expect(await realpath(join(f.base, "previous"))).toBe(f.app);
    expect(f.calls.filter((c) => c.startsWith("npm")).map((c) => c.split(" -- pnpm ")[1])).toEqual(["install --frozen-lockfile --ignore-scripts", "-r rebuild esbuild", "build"]);
    expect(f.calls).toContain("systemctl --user restart contextlanes.service");
    const unit = await readFile(join(f.home, ".config/systemd/user/contextlanes.service"), "utf8");
    expect(unit).toContain(`WorkingDirectory=${join(f.base, "current")}`);
    expect(await readFile(join(f.home, ".local/bin/contextlanes"), "utf8")).toContain(join(f.base, "current/apps/cli/dist/main.js"));
    const backups = await (await import("node:fs/promises")).readdir(join(f.data, "backups"));
    expect(backups).toHaveLength(1);
    expect(userVersion(join(f.data, "backups", backups[0]!))).toBe(3);
    expect(JSON.parse(await readFile(join(f.base, "update.json"), "utf8")).history).toHaveLength(1);
    expect(f.logs).toContain("1 new change on main:");
    expect(f.logs.at(-3)).toBe(`Updated ${f.first.slice(0, 12)} → ${second.slice(0, 12)}. 2 of 2 active lanes kept running.`);
    expect(f.logs.at(-2)).toBe("Open ContextLanes: http://127.0.0.1:4600 (this machine only; run contextlanes setup to reach it over Tailscale)");
    expect(f.logs.at(-1)).toBe("Undo with: contextlanes update --rollback");

    f.calls.length = 0; f.logs.length = 0;
    expect(await (await f.updater()).update()).toBe(0);
    expect(f.logs.at(-2)).toBe(`Already up to date (${second.slice(0, 12)} on main).`);
    expect(f.calls).toEqual([]);
  });

  it("--check lists what is new and changes nothing", async () => {
    const f = await fixture();
    await commit(f.work, "Faster lanes");
    expect(await (await f.updater()).update({ check: true })).toBe(0);
    expect(f.logs.join("\n")).toMatch(/1 new change on main:\n {2}\w+ Faster lanes\nRun contextlanes update to install them\./);
    expect(f.calls).toEqual([]);
    await expect(readlink(join(f.base, "current"))).rejects.toThrow();
  });

  it("refuses when files in the running copy were edited by hand", async () => {
    const f = await fixture();
    await commit(f.work, "Second version");
    await writeFile(join(f.app, "package.json"), "{}");
    await expect((await f.updater()).update()).rejects.toThrow(/changed by hand[\s\S]*package\.json/);
    expect(f.calls.filter((c) => c.startsWith("npm"))).toEqual([]);
  });

  it("keeps the running version when the new one does not build", async () => {
    const f = await fixture();
    await commit(f.work, "Broken build");
    const u = await f.updater();
    (u as unknown as { deps: { run: Runner } }).deps.run = async (cmd, args, opts) => {
      if (cmd === "npm" && args.at(-1) === "build") throw Object.assign(new Error("Command failed: pnpm build"), { stderr: "src/x.ts(1,1): error TS1005" });
      return cmd === "git" ? runCommand(cmd, args, opts) : { stdout: "" };
    };
    await expect(u.update()).rejects.toThrow(/did not build, so nothing changed[\s\S]*TS1005/);
    await expect(readlink(join(f.base, "current"))).rejects.toThrow();
  });

  it("switches back by itself, restoring the database, when the new version does not come up", async () => {
    const f = await fixture({ migrateOnStart: true, neverHealthy: true });
    await commit(f.work, "Second version");
    await expect((await f.updater()).update()).rejects.toThrow(`Back on ${f.first.slice(0, 12)}`);
    expect(await realpath(join(f.base, "current"))).toBe(f.app);
    expect(userVersion(f.database)).toBe(3);
    expect(f.calls.slice(-3)).toEqual(["systemctl --user restart contextlanes.service", "systemctl --user stop contextlanes.service", "systemctl --user start contextlanes.service"]);
  });

  it("rolls back one version, asking first when the database format changed", async () => {
    const f = await fixture({ migrateOnStart: true, publicUrl: "https://neo.tail1234.ts.net" });
    await commit(f.work, "Second version");
    expect(await (await f.updater()).update()).toBe(0);
    expect(userVersion(f.database)).toBe(4);
    expect(await (await f.updater()).rollback()).toBe(1);
    expect(f.logs.at(-1)).toBe("Run contextlanes update --rollback --yes to continue.");
    expect(await (await f.updater()).rollback({ yes: true })).toBe(0);
    expect(await realpath(join(f.base, "current"))).toBe(f.app);
    expect(userVersion(f.database)).toBe(3);
    expect(f.logs.at(-2)).toBe(`Back on ${f.first.slice(0, 12)}. The database was restored.`);
    expect(f.logs.at(-1)).toBe("Open ContextLanes: https://neo.tail1234.ts.net (on this machine: http://127.0.0.1:4600)");
  });

  it("follows the default branch when the branch it tracked is gone", async () => {
    const f = await fixture();
    await writeFile(join(f.base, "update.json"), JSON.stringify({ branch: "contextlanes", history: [] }));
    await commit(f.work, "Promoted to main");
    await (await f.updater()).update({ check: true });
    expect(f.logs).toContain("The contextlanes branch is gone; following main from now on.");
  });

  it("follows the repository's default branch, not the branch the copy was cloned from", async () => {
    const f = await fixture();
    await git(f.work, "push", "-q", "origin", "HEAD:contextlanes");
    await git(f.app, "fetch", "-q", "origin");
    await git(f.app, "branch", "-q", "--set-upstream-to=origin/contextlanes");
    await commit(f.work, "Only on main");
    expect(await (await f.updater()).update({ check: true })).toBe(0);
    expect(f.logs).toContain("1 new change on main:");
  });

  it("keeps following a branch chosen at install time", async () => {
    const f = await fixture();
    await commit(f.work, "Second version");
    const release = join(f.base, "releases", "chosen");
    await git(f.app, "fetch", "-q", "origin");
    await git(f.app, "worktree", "add", "-q", "--detach", release, "origin/main");
    await writeFile(join(release, ".contextlanes-built"), "{}");
    await mkdir(join(release, "apps/daemon/dist"), { recursive: true }); await writeFile(join(release, "apps/daemon/dist/main.js"), "// built");
    await git(f.work, "push", "-q", "origin", "HEAD:next");
    expect(await (await f.updater()).adopt(release, "next")).toBe(0);
    expect(JSON.parse(await readFile(join(f.base, "update.json"), "utf8")).branch).toBe("next");
    await writeFile(join(f.work, "NEXT.md"), "next\n");
    await git(f.work, "add", "-A"); await git(f.work, "commit", "-q", "-m", "Only on next"); await git(f.work, "push", "-q", "origin", "HEAD:next");
    f.logs.length = 0;
    await (await f.updater()).update({ check: true });
    expect(f.logs).toContain("1 new change on next:");
  });

  it("follows the repository to its new name", async () => {
    const f = await fixture();
    await git(f.app, "remote", "set-url", "origin", "https://github.com/wongywrongy/rootlane");
    // Keep the test offline: the new address resolves to the fixture's remote.
    await git(f.app, "config", `url.${f.remote}.insteadOf`, "https://github.com/wongywrongy/contextlane.git");
    await commit(f.work, "Renamed");
    expect(await (await f.updater()).update({ check: true })).toBe(0);
    expect(f.logs[0]).toBe("The repository moved to wongywrongy/contextlane; following it there.");
    expect(await git(f.app, "config", "--get", "remote.origin.url")).toBe("https://github.com/wongywrongy/contextlane.git");
  });

  it("keeps current, previous, the newest releases and any a running lane still uses", async () => {
    const f = await fixture();
    const old = ["aaaaaaaaaaaa", "bbbbbbbbbbbb", "cccccccccccc", "dddddddddddd"];
    for (const [i, name] of old.entries()) { await mkdir(join(f.base, "releases", name), { recursive: true }); await utimes(join(f.base, "releases", name), 1000 + i, 1000 + i); }
    f.setProcesses([`node ${join(f.base, "releases", "aaaaaaaaaaaa")}/apps/lanehost/dist/main.js --lane shop/01`]);
    const second = await commit(f.work, "Second version");
    await (await f.updater()).update();
    const left = await (await import("node:fs/promises")).readdir(join(f.base, "releases"));
    expect(left.sort()).toEqual(["aaaaaaaaaaaa", "cccccccccccc", "dddddddddddd", second.slice(0, 12)].sort());
  });

  it("leaves a source checkout to git", async () => {
    const f = await fixture({ base: "code" });
    expect(await (await f.updater()).update()).toBe(1);
    expect(f.logs[0]).toMatch(/source checkout/);
  });

  it("refuses to run twice at once", async () => {
    const f = await fixture();
    await writeFile(join(f.base, "update.lock"), String(process.ppid));
    await expect((await f.updater()).update()).rejects.toThrow(/Another update is running/);
  });
});
