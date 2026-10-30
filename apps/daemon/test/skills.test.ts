import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import type { Lane } from "@contextlanes/protocol";
import { Config, Store, type Runner } from "@contextlanes/daemon";
import { Skills } from "../src/skills.js";

const exec = promisify(execFile);
const run: Runner = async (cmd, args, opts) => { const r = await exec(cmd, args, { cwd: opts?.cwd }); return { stdout: r.stdout }; };
const roots: string[] = [];
afterEach(async () => { for (const r of roots.splice(0)) await rm(r, { recursive: true, force: true }); });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "cl-skills-")); roots.push(root);
  const repo = join(root, "shop");
  await exec("git", ["init", "-q", "-b", "main", repo]);
  await exec("git", ["-C", repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"]);
  const worktree = join(root, "lanes", "shop-1");
  await exec("git", ["-C", repo, "worktree", "add", "-q", "-b", "lane-1", worktree]);
  const store = Store.open(":memory:"); store.addProject({ id: "shop", name: "Shop", path: repo });
  const config = Config.parse({ paths: { data: join(root, "data") } });
  const lane = (agent: string) => ({ id: "shop/1", project: "shop", agent, worktree }) as unknown as Lane;
  return { skills: new Skills({ config, store, run }), repo, worktree, lane };
}
const skill = { name: "release-notes", description: "Write release notes for this project.", body: "Group changes by area. Link each PR." };

describe("shared skills", () => {
  it("saves, lists and removes a project's skills", async () => {
    const f = await fixture();
    expect(await f.skills.list("shop")).toEqual([]);
    expect(await f.skills.save("shop", skill)).toEqual([skill]);
    expect(await f.skills.remove("shop", "release-notes")).toEqual([]);
    await expect(f.skills.save("shop", { ...skill, name: "../escape" })).rejects.toThrow();
    await expect(f.skills.save("nope", skill)).rejects.toThrow(/no such project/);
  });

  it("copies skills where each agent reads them and keeps them out of git", async () => {
    const f = await fixture();
    expect(await f.skills.install(f.lane("claude-code"))).toBe(0);
    await f.skills.save("shop", skill);
    expect(await f.skills.install(f.lane("claude-code"))).toBe(1);
    expect(await readFile(join(f.worktree, ".claude/skills/contextlanes-release-notes/SKILL.md"), "utf8")).toBe(`---\nname: release-notes\ndescription: ${skill.description}\n---\n\n${skill.body}\n`);
    await f.skills.install(f.lane("codex"));
    expect((await stat(join(f.worktree, ".agents/skills/contextlanes-release-notes/SKILL.md"))).isFile()).toBe(true);
    const status = (await exec("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: f.worktree })).stdout;
    expect(status).toBe("");
    // Installing again does not repeat the exclude lines.
    await f.skills.install(f.lane("opencode"));
    const exclude = await readFile(join(f.repo, ".git/info/exclude"), "utf8");
    expect(exclude.match(/contextlanes-\*/g)).toHaveLength(2);
  });
});
