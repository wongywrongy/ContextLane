import { opendir, realpath, stat, lstat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import type { FolderListing, ProjectBranches, RepositoryScan } from "@contextlanes/protocol";
import type { Runner } from "./run.js";

export class ProjectError extends Error { readonly statusCode = 400; }
export function expandPath(path: string, home: string): string {
  if (path === "~") return home;
  if (path.startsWith("~/")) return resolve(home, path.slice(2));
  if (!isAbsolute(path)) throw new ProjectError("Choose a folder or enter a path starting with ~ or /.");
  return resolve(path);
}

/** All traversal is confined by canonical paths, including symlink targets. */
export class ProjectDiscovery {
  constructor(private home: string, private run: Runner) {}
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
        try { const canonical = await this.inside(join(target, entry.name)); folders.push({ name: entry.name, path: canonical }); }
        catch { /* Inaccessible folders and links outside home are not browsable. */ }
      }
    } catch { throw new ProjectError("This folder cannot be opened; choose another folder."); }
    folders.sort((a, b) => a.name.localeCompare(b.name));
    return { path: target, parent: target === root ? null : dirname(target), folders };
  }
  async scan(): Promise<RepositoryScan> {
    const root = await this.inside("~");
    const queue = [{ path: root, depth: 0 }];
    const repositories: RepositoryScan["repositories"] = [];
    let scanned = 0;
    for (let index = 0; index < queue.length && scanned < 2000; index++) {
      const { path, depth } = queue[index]!;
      scanned++;
      try {
        const marker = await lstat(join(path, ".git"));
        if (marker.isFile() || marker.isDirectory()) {
          try {
            const branch = (await this.run("git", ["branch", "--show-current"], { cwd: path, timeout: 5000 })).stdout.trim();
            repositories.push({ name: basename(path), path, branch: branch || null });
          } catch { /* A broken or inaccessible repository is not offered. */ }
        }
      } catch { /* Most folders are not repositories. */ }
      if (depth === 4) continue;
      try {
        for await (const entry of await opendir(path)) {
          if (entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "node_modules") {
            queue.push({ path: join(path, entry.name), depth: depth + 1 });
            if (queue.length >= 2001) break;
          }
        }
      } catch { /* Skip unreadable folders while scanning the rest of home. */ }
    }
    return { repositories: repositories.sort((a, b) => a.path.localeCompare(b.path)), scanned, limited: queue.length > scanned };
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
