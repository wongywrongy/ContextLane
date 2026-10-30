import { copyFile, mkdir, open, readdir, readFile, rm, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { installService } from "./install.js";
import { BUILT_MARKER, MANAGED_MARKER, exists, linkTarget, runningRelease, setLink, shortSha, type Layout } from "./layout.js";
import type { Runner } from "./run.js";

export class UpdateError extends Error {}

export type UpdateDeps = {
  run: Runner;
  /** Health checks against the local daemon. */
  fetch: typeof fetch;
  log: (line: string) => void;
  sleep: (ms: number) => Promise<void>;
  /** Command lines of running processes, so a release a lane host still runs from is kept. */
  processes: () => Promise<string[]>;
  home: string;
  node: string;
  layout: Layout;
  /** Data folder and port from config.toml. */
  data: string;
  port: number;
  config?: string;
  /** Seconds to wait for the restarted daemon. */
  healthSeconds?: number;
};

type History = { from: string; to: string; fromPath: string; toPath: string; at: string; backup: string | null; userVersion: number | null };
type State = { branch?: string; history: History[] };

const SERVICE = "contextlanes.service";
const KEEP_RELEASES = 3;
const KEEP_BACKUPS = 5;
const OLD_REPO = /github\.com[/:]wongywrongy\/rootlane(\.git)?\/?$/i;
const NEW_REPO = "https://github.com/wongywrongy/contextlane.git";
const ACTIVE = ["setting_up", "working", "needs_you", "in_review"];

/**
 * contextlanes update: fetch, build the new version in its own folder, back up the database,
 * point current at it, restart, and switch back by itself if it does not come up healthy.
 * Lanes run as their own units, so agents and shells keep going through the restart.
 */
export class Updater {
  constructor(private deps: UpdateDeps) {}
  private get l() { return this.deps.layout; }
  private log(line: string) { this.deps.log(line); }
  private async git(cwd: string, args: string[], timeout = 120_000): Promise<string> {
    return (await this.deps.run("git", ["-C", cwd, ...args], { timeout })).stdout.trim();
  }

  async update(options: { check?: boolean; branch?: string } = {}): Promise<number> {
    if (!this.l.managed) return this.unmanaged();
    return this.locked(async () => {
      const running = await runningRelease(this.l);
      const from = await this.git(running, ["rev-parse", "HEAD"]);
      await this.followMovedRepo();
      this.log("Checking for updates…");
      await this.git(this.l.repo, ["fetch", "--prune", "--quiet", "origin", "+refs/heads/*:refs/remotes/origin/*"], 300_000)
        .catch((err) => { throw new UpdateError(`Could not reach the repository. ${lastLines(err)}`); });
      const state = await this.state();
      const branch = await this.branch(state, options.branch);
      const to = await this.git(this.l.repo, ["rev-parse", `refs/remotes/origin/${branch}`]);
      if (to === from) { this.log(`Already up to date (${shortSha(from)} on ${branch}).`); return 0; }
      if (await this.isAncestor(to, from)) { this.log(`This copy (${shortSha(from)}) is newer than ${branch} (${shortSha(to)}). Nothing to update.`); return 0; }
      const changes = (await this.git(this.l.repo, ["log", "--no-decorate", "--format=%h %s", `${from}..${to}`])).split("\n").filter(Boolean);
      this.log(`${changes.length} new ${changes.length === 1 ? "change" : "changes"} on ${branch}:`);
      for (const line of changes.slice(0, 20)) this.log(`  ${line}`);
      if (changes.length > 20) this.log(`  …and ${changes.length - 20} more`);
      if (options.check) { this.log("Run contextlanes update to install them."); return 0; }
      const dirty = await this.git(running, ["status", "--porcelain", "--untracked-files=no"]);
      if (dirty) throw new UpdateError(`Files in the running copy were changed by hand, so nothing was updated:\n${dirty}\nUndo or commit them in ${running}, then run contextlanes update again.`);
      const release = join(this.l.releases, shortSha(to));
      await this.build(release, to);
      if (options.branch || state.branch) { state.branch = branch; await this.saveState(state); }
      return this.switchTo(release, { from, fromPath: running, to });
    });
  }

  /** install.sh on an existing copy: the new release is already built. */
  /** Switch to a release install.sh already built; `branch` is the one the installer was told to follow. */
  async adopt(release: string, branch?: string): Promise<number> {
    if (!this.l.managed) return this.unmanaged();
    return this.locked(async () => {
      if (branch) { const state = await this.state(); state.branch = branch; await this.saveState(state); }
      const running = await runningRelease(this.l);
      const from = await this.git(running, ["rev-parse", "HEAD"]);
      const to = await this.git(release, ["rev-parse", "HEAD"]);
      if (!(await exists(join(release, BUILT_MARKER)))) throw new UpdateError(`${release} is not a finished build.`);
      if (to === from) { this.log(`Already running ${shortSha(to)}.`); return 0; }
      return this.switchTo(release, { from, fromPath: running, to });
    });
  }

  async rollback(options: { yes?: boolean } = {}): Promise<number> {
    if (!this.l.managed) return this.unmanaged();
    return this.locked(async () => {
      const running = await runningRelease(this.l);
      const from = await this.git(running, ["rev-parse", "HEAD"]);
      const state = await this.state();
      const last = state.history.at(-1);
      const target = await linkTarget(this.l.previous) ?? last?.fromPath ?? null;
      if (!target || target === running || !(await exists(join(target, "apps/daemon/dist/main.js")))) { this.log("There is no earlier version to go back to."); return 1; }
      const to = await this.git(target, ["rev-parse", "HEAD"]);
      const undoing = last && last.to === from ? last : null;
      const now = this.userVersion();
      const restore = undoing?.backup && now !== null && undoing.userVersion !== null && now > undoing.userVersion ? undoing : null;
      if (restore && !options.yes) {
        this.log(`Going back to ${shortSha(to)} also restores the database saved on ${restore.at}, because the newer version changed its format. Lane history recorded since then is lost.`);
        this.log("Run contextlanes update --rollback --yes to continue.");
        return 1;
      }
      this.log(`Going back from ${shortSha(from)} to ${shortSha(to)}…`);
      await this.service("stop");
      if (restore) await this.restore(restore.backup!);
      await setLink(this.l.current, target);
      await setLink(this.l.previous, running);
      await this.service("start");
      if (!(await this.healthy(to))) throw new UpdateError(`ContextLanes did not start on ${shortSha(to)}. Read: journalctl --user -u contextlanes -n 50`);
      if (undoing) state.history.pop();
      await this.saveState(state);
      this.log(`Back on ${shortSha(to)}.${restore ? " The database was restored." : ""}`);
      return 0;
    });
  }

  private unmanaged(): number {
    this.log("This copy runs from a source checkout, not an installed release, so update it yourself:");
    this.log("  git pull && pnpm install && pnpm build && systemctl --user restart contextlanes");
    return 1;
  }

  private async switchTo(release: string, v: { from: string; fromPath: string; to: string }): Promise<number> {
    await this.ensureLayout(v.fromPath);
    const before = await this.activeLanes();
    const backup = await this.backup(v.from);
    await setLink(this.l.previous, v.fromPath);
    await setLink(this.l.current, release);
    this.log(`Restarting ContextLanes on ${shortSha(v.to)}…`);
    const started = await this.service("restart").then(() => this.healthy(v.to), () => false);
    if (!started) {
      this.log(`The new version did not start, so ContextLanes is going back to ${shortSha(v.from)}.`);
      await this.service("stop").catch(() => {});
      const now = this.userVersion();
      if (backup && now !== null && backup.userVersion !== null && now > backup.userVersion) await this.restore(backup.file);
      await setLink(this.l.current, v.fromPath);
      await this.service("start").catch(() => {});
      const back = await this.healthy(v.from);
      throw new UpdateError(back ? `Back on ${shortSha(v.from)}. Nothing else changed. To see why ${shortSha(v.to)} failed: journalctl --user -u contextlanes -n 50`
        : `ContextLanes did not come back on ${shortSha(v.from)} either. Read: journalctl --user -u contextlanes -n 50`);
    }
    const state = await this.state();
    state.history.push({ from: v.from, to: v.to, fromPath: v.fromPath, toPath: release, at: new Date().toISOString(), backup: backup?.file ?? null, userVersion: backup?.userVersion ?? null });
    state.history = state.history.slice(-20);
    await this.saveState(state);
    await this.prune();
    const after = await this.activeLanes();
    const lanes = before !== null && after !== null ? ` ${after} of ${before} active ${before === 1 ? "lane" : "lanes"} kept running.` : "";
    this.log(`Updated ${shortSha(v.from)} → ${shortSha(v.to)}.${lanes} Undo with: contextlanes update --rollback`);
    return 0;
  }

  /** Before the first update: point the service and the commands at current instead of the clone. */
  private async ensureLayout(running: string): Promise<void> {
    if (await exists(this.l.current)) return;
    await writeFile(join(this.l.base, MANAGED_MARKER), "");
    await setLink(this.l.current, running);
    try {
      await installService({ root: this.l.current, home: this.deps.home, node: this.deps.node, run: this.deps.run, ...(this.deps.config ? { config: this.deps.config } : {}) });
    } catch (err) {
      await rm(this.l.current, { force: true });
      throw new UpdateError(`The service file could not be switched to the new layout, so nothing was updated. ${err instanceof Error ? err.message : ""}`);
    }
  }

  private async build(release: string, sha: string): Promise<void> {
    if (await exists(release)) {
      const built = await exists(join(release, BUILT_MARKER)) && (await this.git(release, ["rev-parse", "HEAD"]).catch(() => "")) === sha;
      if (built) { this.log(`Using the ${shortSha(sha)} build from an earlier attempt.`); return; }
      await this.git(this.l.repo, ["worktree", "remove", "--force", release]).catch(() => {});
      await rm(release, { recursive: true, force: true });
      await this.git(this.l.repo, ["worktree", "prune"]);
    }
    await mkdir(this.l.releases, { recursive: true });
    await this.git(this.l.repo, ["worktree", "add", "--detach", "--quiet", release, sha]);
    const manifest = JSON.parse(await readFile(join(release, "package.json"), "utf8")) as { packageManager?: string };
    const pnpm = /^pnpm@[\w.-]+$/.test(manifest.packageManager ?? "") ? manifest.packageManager! : "pnpm@10.28.0";
    const step = (args: string[]) => this.deps.run("npm", ["exec", "--yes", `--package=${pnpm}`, "--", "pnpm", ...args], { cwd: release, timeout: 900_000 });
    this.log(`Building ${shortSha(sha)}. This takes a minute or two…`);
    try {
      await step(["install", "--frozen-lockfile", "--ignore-scripts"]);
      await step(["-r", "rebuild", "esbuild"]);
      await step(["--filter", "@contextlanes/daemon", "rebuild", "node-pty"]).catch(() => this.log("The browser terminal's native module did not build; lanes still run. Install C++ build tools to get browser terminals back."));
      await step(["build"]);
    } catch (err) {
      throw new UpdateError(`${shortSha(sha)} did not build, so nothing changed and the running version keeps going.\n${lastLines(err)}`);
    }
    await writeFile(join(release, BUILT_MARKER), `${JSON.stringify({ sha, at: new Date().toISOString() })}\n`);
  }

  /**
   * The branch to follow: one chosen with --branch or CONTEXTLANES_BRANCH (saved in update.json), else
   * the repository's default branch. The clone's own upstream is ignored: it is whatever branch the
   * copy was first installed from, which may since have been retired.
   */
  private async branch(state: State, override?: string): Promise<string> {
    const has = (b: string) => this.git(this.l.repo, ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${b}`]).then(() => true, () => false);
    if (override) {
      if (!/^[\w./-]+$/.test(override) || override.startsWith("-") || !(await has(override))) throw new UpdateError(`There is no branch ${override} in the repository.`);
      return override;
    }
    const head = await this.git(this.l.repo, ["ls-remote", "--symref", "origin", "HEAD"]).catch(() => "");
    const fallback = /ref: refs\/heads\/(\S+)\s+HEAD/.exec(head)?.[1] ?? "main";
    const preferred = state.branch ?? fallback;
    if (await has(preferred)) return preferred;
    if (!(await has(fallback))) throw new UpdateError(`Neither ${preferred} nor ${fallback} exists in the repository.`);
    this.log(`The ${preferred} branch is gone; following ${fallback} from now on.`);
    return fallback;
  }

  private async followMovedRepo(): Promise<void> {
    const url = await this.git(this.l.repo, ["remote", "get-url", "origin"]).catch(() => "");
    if (!OLD_REPO.test(url)) return;
    await this.git(this.l.repo, ["remote", "set-url", "origin", NEW_REPO]);
    this.log("The repository moved to wongywrongy/contextlane; following it there.");
  }

  private async isAncestor(a: string, b: string): Promise<boolean> {
    return this.git(this.l.repo, ["merge-base", "--is-ancestor", a, b]).then(() => true, () => false);
  }

  private get database() { return join(this.deps.data, "contextlanes.sqlite"); }
  private userVersion(): number | null {
    let db: DatabaseSync | undefined;
    try {
      db = new DatabaseSync(this.database, { readOnly: true });
      return Number((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version);
    } catch { return null; } finally { db?.close(); }
  }
  /** A consistent copy taken while the daemon keeps running (VACUUM INTO). The newest five are kept. */
  private async backup(sha: string): Promise<{ file: string; userVersion: number | null } | null> {
    if (!(await exists(this.database))) return null;
    const dir = join(this.deps.data, "backups");
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const file = join(dir, `${new Date().toISOString().replace(/[:.]/g, "-")}-${shortSha(sha)}.sqlite`);
    const db = new DatabaseSync(this.database, { readOnly: true });
    let userVersion: number | null;
    try {
      userVersion = Number((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version);
      db.prepare("VACUUM INTO ?").run(file);
    } finally { db.close(); }
    const old = (await readdir(dir)).filter((f) => f.endsWith(".sqlite")).sort();
    for (const f of old.slice(0, Math.max(0, old.length - KEEP_BACKUPS))) await unlink(join(dir, f)).catch(() => {});
    this.log("Saved a copy of the database.");
    return { file, userVersion };
  }
  private async restore(file: string): Promise<void> {
    for (const suffix of ["-wal", "-shm"]) await unlink(`${this.database}${suffix}`).catch(() => {});
    await copyFile(file, this.database);
    this.log("Restored the database from before the update.");
  }

  private async service(action: "restart" | "start" | "stop"): Promise<void> {
    await this.deps.run("systemctl", ["--user", action, SERVICE], { timeout: 60_000 });
  }
  private async healthy(sha: string): Promise<boolean> {
    const deadline = (this.deps.healthSeconds ?? 30) * 2;
    for (let i = 0; i < deadline; i++) {
      try {
        const res = await this.deps.fetch(`http://127.0.0.1:${this.deps.port}/api/health`);
        if (res.ok && ((await res.json()) as { version?: string }).version === shortSha(sha)) return true;
      } catch { /* not up yet */ }
      await this.deps.sleep(500);
    }
    return false;
  }
  private async activeLanes(): Promise<number | null> {
    try {
      const res = await this.deps.fetch(`http://127.0.0.1:${this.deps.port}/api/lanes`);
      if (!res.ok) return null;
      return ((await res.json()) as { state: string }[]).filter((l) => ACTIVE.includes(l.state)).length;
    } catch { return null; }
  }

  /** Keep current, previous, the newest few and any release a running process still uses. */
  private async prune(): Promise<void> {
    if (!(await exists(this.l.releases))) return;
    const keep = new Set([await linkTarget(this.l.current), await linkTarget(this.l.previous)].filter(Boolean));
    const lines = await this.deps.processes().catch(() => []);
    const entries = await Promise.all((await readdir(this.l.releases)).map(async (name) => {
      const path = join(this.l.releases, name);
      return { path, mtime: (await stat(path).catch(() => null))?.mtimeMs ?? 0 };
    }));
    entries.sort((a, b) => b.mtime - a.mtime);
    for (const [i, entry] of entries.entries()) {
      const inUse = lines.some((line) => line.includes(`${entry.path}/`));
      if (i < KEEP_RELEASES || keep.has(entry.path) || inUse) continue;
      await this.git(this.l.repo, ["worktree", "remove", "--force", entry.path]).catch(() => rm(entry.path, { recursive: true, force: true }));
    }
    await this.git(this.l.repo, ["worktree", "prune"]).catch(() => {});
  }

  private async state(): Promise<State> {
    try { return { history: [], ...JSON.parse(await readFile(join(this.l.base, "update.json"), "utf8")) as Partial<State> }; } catch { return { history: [] }; }
  }
  private async saveState(state: State): Promise<void> {
    await writeFile(join(this.l.base, "update.json"), `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  }

  /** One update at a time; a lock left by a process that died is taken over. */
  private async locked(fn: () => Promise<number>): Promise<number> {
    const lock = join(this.l.base, "update.lock");
    try {
      const handle = await open(lock, "wx", 0o600);
      await handle.writeFile(String(process.pid)); await handle.close();
    } catch {
      const pid = Number(await readFile(lock, "utf8").catch(() => ""));
      if (pid && pid !== process.pid && alive(pid)) throw new UpdateError(`Another update is running (process ${pid}).`);
      await writeFile(lock, String(process.pid), { mode: 0o600 });
    }
    try { return await fn(); } finally { await unlink(lock).catch(() => {}); }
  }
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** The end of a failed command's output: enough to see what broke. */
function lastLines(err: unknown): string {
  const text = err instanceof Error ? `${err.message}\n${(err as { stderr?: string }).stderr ?? ""}` : String(err);
  return text.trim().split("\n").filter(Boolean).slice(-12).join("\n");
}
