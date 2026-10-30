import { open, opendir, readdir, realpath, stat, lstat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import type { FolderListing, ProjectBranches, Repository, RepositoryScan } from "@contextlanes/protocol";
import type { Runner } from "./run.js";

export class ProjectError extends Error { readonly statusCode = 400; }
export function expandPath(path: string, home: string): string {
  if (path === "~") return home;
  if (path.startsWith("~/")) return resolve(home, path.slice(2));
  if (!isAbsolute(path)) throw new ProjectError("Choose a folder or enter a path starting with ~ or /.");
  return resolve(path);
}

/** Folders that hold installed packages or data, never your own repositories. */
const SKIP = new Set(["node_modules", "__pycache__", "site-packages", "venv", "Library", "snap", "miniconda3", "anaconda3"]);

export type ScanLimits = {
  /** Folders visited before the walk stops. */
  folders: number;
  /** Time budget for the walk, in milliseconds. */
  ms: number;
  /** A folder with more subfolders than this is treated as data and not walked into. */
  wide: number;
  /** Deepest level below home that is checked for a repository. */
  depth: number;
};
const LIMITS: ScanLimits = { folders: 6000, ms: 3000, wide: 300, depth: 5 };

type Seen = { usedBy: Set<Repository["usedBy"][number]>; lastUsed: number };

/** All traversal is confined by canonical paths, including symlink targets. */
export class ProjectDiscovery {
  private limits: ScanLimits;
  constructor(private home: string, private run: Runner, private options: { exclude?: string[]; limits?: Partial<ScanLimits> } = {}) {
    this.limits = { ...LIMITS, ...options.limits };
  }
  private async inside(path: string): Promise<string> {
    try {
      const root = await realpath(this.home);
      const target = await realpath(expandPath(path, root));
      if (target !== root && !target.startsWith(root + sep)) throw new ProjectError("Choose a folder inside your home folder.");
      if (!(await stat(target)).isDirectory()) throw new ProjectError("Choose a folder, then try again.");
      return target;
    } catch (error) { if (error instanceof ProjectError) throw error; throw new ProjectError("This folder cannot be opened; choose another folder."); }
  }
  async folders(path: string): Promise<FolderListing> {
    const target = await this.inside(path);
    const root = await realpath(this.home);
    const folders: FolderListing["folders"] = [];
    try {
      for await (const entry of await opendir(target)) {
        if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
        if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
        try {
          const canonical = await this.inside(join(target, entry.name));
          folders.push({ name: entry.name, path: canonical, repo: await isRepo(canonical) });
        } catch { /* Inaccessible folders and links outside home are not browsable. */ }
      }
    } catch { throw new ProjectError("This folder cannot be opened; choose another folder."); }
    folders.sort((a, b) => a.name.localeCompare(b.name));
    return { path: target, parent: target === root ? null : dirname(target), repo: await isRepo(target), folders };
  }

  /**
   * Finds repositories two ways: folders your agents have worked in (Claude Code and Codex
   * session history), then a bounded walk of home that stops at each repository and does not
   * walk into folders that look like data.
   */
  async scan(): Promise<RepositoryScan> {
    const root = await this.inside("~");
    const found = new Map<string, Seen>();
    for (const [cwd, use] of await this.agentFolders()) {
      const top = await this.topLevel(cwd);
      if (!top || this.excluded(top)) continue;
      const seen = found.get(top) ?? { usedBy: new Set(), lastUsed: 0 };
      for (const agent of use.usedBy) seen.usedBy.add(agent);
      seen.lastUsed = Math.max(seen.lastUsed, use.lastUsed);
      found.set(top, seen);
    }
    const walk = await this.walk(root);
    for (const path of walk.repositories) if (!found.has(path) && !this.excluded(path)) found.set(path, { usedBy: new Set(), lastUsed: 0 });
    const repositories: Repository[] = [];
    const entries = [...found];
    for (let i = 0; i < entries.length; i += 8) {
      const described = await Promise.all(entries.slice(i, i + 8).map(([path, seen]) => this.describe(path, seen)));
      for (const repo of described) if (repo) repositories.push(repo);
    }
    repositories.sort((a, b) => (b.lastUsed ?? "").localeCompare(a.lastUsed ?? "") || a.path.localeCompare(b.path));
    return { repositories, scanned: walk.scanned, limited: walk.limited, skipped: walk.skipped.slice(0, 10) };
  }

  private excluded(path: string): boolean {
    return (this.options.exclude ?? []).some((root) => path === root || path.startsWith(root + sep));
  }

  private async walk(root: string): Promise<{ repositories: string[]; scanned: number; limited: boolean; skipped: string[] }> {
    const started = Date.now();
    const queue = [{ path: root, depth: 0 }];
    const repositories: string[] = [];
    const skipped: string[] = [];
    let scanned = 0;
    let index = 0;
    for (; index < queue.length; index++) {
      if (scanned >= this.limits.folders || Date.now() - started > this.limits.ms) break;
      const { path, depth } = queue[index]!;
      scanned++;
      if (depth > 0 && await isRepo(path)) { repositories.push(path); continue; }
      if (depth >= this.limits.depth) continue;
      const children: string[] = [];
      try {
        for await (const entry of await opendir(path)) {
          if (entry.isDirectory() && !entry.name.startsWith(".") && !SKIP.has(entry.name)) children.push(join(path, entry.name));
        }
      } catch { continue; /* Skip unreadable folders while scanning the rest of home. */ }
      if (depth > 0 && children.length > this.limits.wide) { skipped.push(path); continue; }
      children.sort();
      for (const child of children) queue.push({ path: child, depth: depth + 1 });
    }
    return { repositories, scanned, limited: index < queue.length, skipped };
  }

  private async describe(path: string, seen: Seen): Promise<Repository | null> {
    const base = { name: basename(path), path, usedBy: [...seen.usedBy].sort(), lastUsed: seen.lastUsed ? new Date(seen.lastUsed).toISOString() : null };
    let branch: string;
    try { branch = (await this.run("git", ["branch", "--show-current"], { cwd: path, timeout: 5000 })).stdout.trim(); }
    catch (error) {
      if (/dubious ownership/.test(String(error))) return { ...base, branch: null, note: `Owned by another user. Git will not open it until you run: git config --global --add safe.directory ${path}` };
      return null;
    }
    try { await this.run("git", ["rev-parse", "--verify", "--quiet", "HEAD"], { cwd: path, timeout: 5000 }); }
    catch { return { ...base, branch: branch || null, note: "No commits yet. Make a first commit before starting a lane here." }; }
    return { ...base, branch: branch || null, note: null };
  }

  private async topLevel(cwd: string): Promise<string | null> {
    try {
      if (!(await stat(cwd)).isDirectory()) return null;
      const top = (await this.run("git", ["rev-parse", "--show-toplevel"], { cwd, timeout: 5000 })).stdout.trim();
      return top ? await realpath(top) : null;
    } catch { return null; }
  }

  /** Working folders from Claude Code and Codex session files, newest first. Reads only the start of each file. */
  private async agentFolders(): Promise<Map<string, Seen>> {
    const folders = new Map<string, Seen>();
    const note = (cwd: string, agent: Repository["usedBy"][number], at: number) => {
      const seen = folders.get(cwd) ?? { usedBy: new Set(), lastUsed: 0 };
      seen.usedBy.add(agent); seen.lastUsed = Math.max(seen.lastUsed, at); folders.set(cwd, seen);
    };
    const claude = join(this.home, ".claude", "projects");
    for (const dir of (await newest(claude, 300)).filter((d) => d.dir)) {
      const files = (await newest(dir.path, 50)).filter((f) => !f.dir && f.path.endsWith(".jsonl"));
      const file = files[0];
      if (!file) continue;
      const cwd = await cwdFrom(file.path, 64 * 1024);
      if (cwd) note(cwd, "claude-code", file.mtime);
    }
    const codex = join(this.home, ".codex", "sessions");
    let read = 0;
    for (const year of (await newest(codex, 5)).filter((d) => d.dir)) {
      for (const month of (await newest(year.path, 12)).filter((d) => d.dir)) {
        for (const day of (await newest(month.path, 31)).filter((d) => d.dir)) {
          for (const file of (await newest(day.path, 50)).filter((f) => !f.dir && f.path.endsWith(".jsonl"))) {
            if (read++ >= 400) return folders;
            const cwd = await cwdFrom(file.path, 16 * 1024);
            if (cwd) note(cwd, "codex", file.mtime);
          }
        }
      }
    }
    return folders;
  }

  async branches(path: string): Promise<ProjectBranches> {
    try {
      const branches = (await this.run("git", ["for-each-ref", "--format=%(refname:short)", "refs/heads"], { cwd: path, timeout: 5000 })).stdout.trim().split("\n").filter(Boolean);
      let preferred: string | undefined;
      try { preferred = (await this.run("git", ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], { cwd: path, timeout: 5000 })).stdout.trim().replace(/^origin\//, ""); } catch { /* A local-only repository has no remote HEAD. */ }
      const defaultBranch = [preferred, "main", "master", branches[0]].find((branch) => branch && branches.includes(branch)) ?? null;
      return { branches, defaultBranch };
    } catch { throw new ProjectError("Branches could not be read; check this repository and try again."); }
  }
}

async function isRepo(path: string): Promise<boolean> {
  try { const marker = await lstat(join(path, ".git")); return marker.isFile() || marker.isDirectory(); } catch { return false; }
}

/** Entries of a folder, newest first by modification time; empty when the folder is missing. */
async function newest(path: string, limit: number): Promise<{ path: string; dir: boolean; mtime: number }[]> {
  try {
    const entries = await readdir(path, { withFileTypes: true });
    const timed = await Promise.all(entries.slice(0, 2000).map(async (entry) => {
      const full = join(path, entry.name);
      try { return { path: full, dir: entry.isDirectory(), mtime: (await stat(full)).mtimeMs }; } catch { return null; }
    }));
    return timed.filter((e): e is NonNullable<typeof e> => !!e).sort((a, b) => b.mtime - a.mtime).slice(0, limit);
  } catch { return []; }
}

async function cwdFrom(file: string, bytes: number): Promise<string | null> {
  let handle;
  try {
    handle = await open(file, "r");
    const buffer = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
    const match = /"cwd"\s*:\s*"((?:[^"\\]|\\.)+)"/.exec(buffer.subarray(0, bytesRead).toString("utf8"));
    if (!match) return null;
    const cwd = JSON.parse(`"${match[1]}"`) as string;
    return isAbsolute(cwd) ? cwd : null;
  } catch { return null; } finally { await handle?.close(); }
}
