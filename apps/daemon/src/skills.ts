import { appendFile, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { ProjectSkill, type Lane, type ProjectId } from "@contextlanes/protocol";
import type { Config } from "./config.js";
import type { Store } from "./db/store.js";
import { NotFound } from "./lanes/manager.js";
import { writeInside } from "./safefs.js";
import type { Runner } from "./run.js";

/**
 * Where each agent reads project skills (SKILL.md folders), checked against their docs on 2026-10-30:
 * Claude Code .claude/skills (code.claude.com/docs/en/skills); Codex .agents/skills from the working
 * folder up to the repository root (learn.chatgpt.com/docs/build-skills); OpenCode .opencode/skills,
 * .claude/skills or .agents/skills (opencode.ai/docs/skills). Other ACP agents get .agents/skills, the shared name.
 */
export const SKILL_DIRS: Record<string, string[]> = { "claude-code": [".claude/skills"], codex: [".agents/skills"], opencode: [".agents/skills"] };
const PREFIX = "contextlanes-";

/**
 * Shared skills (4.6): owner-written skills kept per project in the data folder and copied into each new
 * lane's checkout where its agent looks, under a contextlanes- prefix and excluded from git (never a
 * tracked file). Copied, not linked: the data folder is hidden from the lane sandbox.
 */
export class Skills {
  constructor(private deps: { config: Config; store: Store; run: Runner }) {}
  private dir(project: ProjectId) { return join(this.deps.config.paths.data, "skills", project); }

  async list(project: ProjectId): Promise<ProjectSkill[]> {
    const names = await readdir(this.dir(project)).catch(() => []);
    return (await Promise.all(names.map(async (n) => {
      const text = await readFile(join(this.dir(project), n, "SKILL.md"), "utf8").catch(() => null);
      const m = text ? /^---\nname: (.+)\ndescription: (.+)\n---\n\n?([\s\S]*)$/.exec(text) : null;
      return m ? [{ name: m[1]!.trim(), description: m[2]!.trim(), body: m[3]!.trim() }] : [];
    }))).flat().sort((a, b) => a.name.localeCompare(b.name));
  }
  async save(project: ProjectId, input: unknown): Promise<ProjectSkill[]> {
    if (!this.deps.store.getProject(project)) throw new NotFound("no such project");
    const s = ProjectSkill.parse(input);
    await mkdir(join(this.dir(project), s.name), { recursive: true, mode: 0o700 });
    await writeFile(join(this.dir(project), s.name, "SKILL.md"), this.render(s), { mode: 0o600 });
    return this.list(project);
  }
  async remove(project: ProjectId, name: string): Promise<ProjectSkill[]> {
    await rm(join(this.dir(project), ProjectSkill.shape.name.parse(name)), { recursive: true, force: true });
    return this.list(project);
  }
  private render(s: ProjectSkill) { return `---\nname: ${s.name}\ndescription: ${s.description.replace(/\n/g, " ")}\n---\n\n${s.body}\n`; }

  /** Copies the project's skills into a new lane's checkout for its agent, and keeps them out of git. */
  async install(lane: Lane): Promise<number> {
    const skills = await this.list(lane.project);
    if (!skills.length) return 0;
    const dirs = SKILL_DIRS[lane.agent] ?? [".agents/skills"];
    // Through writeInside: the checkout may come from an agent's branch, so a committed .claude symlink is refused, not followed.
    for (const d of dirs) for (const s of skills) await writeInside(lane.worktree, `${d}/${PREFIX}${s.name}/SKILL.md`, this.render(s));
    // info/exclude lives in the repository's common git folder, shared by all its worktrees. Asked of the
    // project's own checkout, not the lane's, whose .git file and commondir the agent can rewrite.
    const project = this.deps.store.getProject(lane.project);
    if (!project) throw new NotFound("no such project");
    const common = (await this.deps.run("git", ["rev-parse", "--git-common-dir"], { cwd: project.path })).stdout.trim();
    const exclude = join(isAbsolute(common) ? common : resolve(project.path, common), "info", "exclude");
    const current = await readFile(exclude, "utf8").catch(() => "");
    const missing = [".claude/skills", ".agents/skills"].map((d) => `${d}/${PREFIX}*/`).filter((l) => !current.split("\n").includes(l));
    if (missing.length) { await mkdir(join(exclude, ".."), { recursive: true }); await appendFile(exclude, `${current && !current.endsWith("\n") ? "\n" : ""}# ContextLanes project skills\n${missing.join("\n")}\n`); }
    return skills.length;
  }
}
