import { access, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { type CloneRequest, type GithubListing, type GithubRepo } from "@contextlanes/protocol";
import type { z } from "zod";
import { Refused } from "./lanes/manager.js";
import type { Runner } from "./run.js";

type GhRepo = { nameWithOwner: string; description: string | null; isPrivate: boolean; updatedAt: string };

/** Add repositories → GitHub: the owner's repositories through the GitHub CLI, cloned into the code folder. */
export class GitHub {
  constructor(private run: Runner, private folder: string) {}

  async list(): Promise<GithubListing> {
    const status = await this.run("gh", ["auth", "status", "--hostname", "github.com"], { timeout: 10_000 }).then(() => "ok" as const, (err: NodeJS.ErrnoException) => err.code === "ENOENT" ? "missing" as const : "signed-out" as const);
    if (status === "missing") return { available: false, reason: "The GitHub CLI (gh) is not installed on this machine. Install it, run gh auth login, then open this again." };
    if (status === "signed-out") return { available: false, reason: "The GitHub CLI is not signed in. Run gh auth login on this machine, then open this again." };
    const out = await this.run("gh", ["repo", "list", "--limit", "200", "--json", "nameWithOwner,description,isPrivate,updatedAt"], { timeout: 30_000 });
    const repos: GithubRepo[] = await Promise.all((JSON.parse(out.stdout) as GhRepo[]).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map(async (r) => {
      const path = this.target(r.nameWithOwner);
      return { name: r.nameWithOwner, description: r.description || null, private: r.isPrivate, updatedAt: r.updatedAt, path, cloned: await access(join(path, ".git")).then(() => true, () => false) };
    }));
    return { available: true, folder: this.folder, repos };
  }

  /** `<code folder>/<name>`; clone() refuses if a different repository already sits there. */
  target(repo: string): string { return join(this.folder, repo.split("/")[1]!); }

  /** Clones (or reuses an existing clone of the same repository) and returns its folder. */
  async clone(body: z.output<typeof CloneRequest>): Promise<string> {
    const path = this.target(body.repo);
    if (await access(join(path, ".git")).then(() => true, () => false)) {
      const remote = await this.run("git", ["remote", "get-url", "origin"], { cwd: path }).then((r) => r.stdout.trim(), () => "");
      if (!remote.toLowerCase().includes(`github.com/${body.repo.toLowerCase()}`) && !remote.toLowerCase().includes(`github.com:${body.repo.toLowerCase()}`)) throw new Refused(`${path} already holds a different repository. Move it, or add it with Choose a folder.`);
      return path;
    }
    if (await access(path).then(() => true, () => false)) throw new Refused(`${path} already exists and is not a repository. Move it, then try again.`);
    await mkdir(this.folder, { recursive: true });
    await this.run("gh", ["repo", "clone", body.repo, path, "--", "--quiet"], { timeout: 600_000 }).catch((err: { stderr?: string }) => {
      throw new Refused(`${body.repo} could not be cloned. ${String(err.stderr ?? "").trim().split("\n").at(-1) ?? ""}`);
    });
    return path;
  }
}
