import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it, vi } from "vitest";
import { RECIPE_FILE } from "@contextlanes/protocol";
import { Checker, Config, EventBus, Runtime, runCommand, Store, type Previews } from "@contextlanes/daemon";
import { readRecipe } from "../src/recipes.js";

const exec = promisify(execFile);
const page = (text: string) => `require("node:http").createServer((q, r) => { r.setHeader("content-type", "text/html"); r.end("<body style='background:${text}'><h1>${text}</h1>"); }).listen(Number(process.env.PORT), process.env.HOST);`;

it.runIf(process.env.CONTEXTLANES_REAL_HOSTS === "1")("builds a checkpoint from real checks, a real diff and real before and after screenshots", async () => {
  const root = await mkdtemp(join(tmpdir(), "cl-real-checker-"));
  const repo = join(root, "repo"); const worktree = join(root, "lane");
  const git = (cwd: string, ...args: string[]) => exec("git", ["-c", "user.name=CL", "-c", "user.email=cl@example.invalid", ...args], { cwd });
  const store = Store.open(":memory:");
  const bus = new EventBus();
  const config = Config.parse({ paths: { data: root, lanes: root } });
  const previews = { publish: async () => "https://fixture.invalid:4700", unpublish: async () => {} } as unknown as Previews;
  const runtime = new Runtime({ store, bus, config, run: runCommand, previews });
  const checker = new Checker({ store, bus, config, run: runCommand, runtime });
  try {
    await mkdir(repo);
    await git(repo, "init", "-b", "main");
    await writeFile(join(repo, "server.cjs"), page("red"));
    await writeFile(join(repo, RECIPE_FILE), JSON.stringify({ services: [{ name: "web", command: [process.execPath, "server.cjs"] }], checks: [{ name: "Passes", command: ["/usr/bin/true"] }, { name: "Fails", command: ["/usr/bin/false"] }] }));
    await git(repo, "add", "."); await git(repo, "commit", "-m", "Fixture");
    await git(repo, "worktree", "add", "-b", "lane/01", worktree);
    await writeFile(join(worktree, "server.cjs"), page("blue"));
    await git(worktree, "commit", "-am", "Make it blue");
    store.addProject({ id: "fixture", name: "Fixture", path: repo });
    store.insertLane({ id: "fixture/01", n: 1, project: "fixture", goal: null, task: "T", agent: "codex", model: null, mode: "ask", branch: "lane/01", worktree, terminal: "t", hostUnit: null, base: "main", state: "working", colour: "lc1" });
    store.approveRecipe("fixture", (await readRecipe(store, store.getProject("fixture")!, worktree))!.hash);

    await checker.begin("fixture/01", "Blue");
    await vi.waitFor(() => expect(store.getLane("fixture/01")!.state).toBe("in_review"), { timeout: 40_000, interval: 200 });
    const checkpoint = store.latestCheckpoint("fixture/01")!;
    expect(checkpoint.checks.map((c) => [c.name, c.passed])).toEqual([["Passes", true], ["Fails", false]]);
    expect(checkpoint.files).toEqual([{ path: "server.cjs", added: 1, removed: 1 }]);
    const [shot] = checkpoint.screenshots;
    expect(shot).toMatchObject({ path: "/", before: "0-before.png", after: "0-after.png", url: "https://fixture.invalid:4700/", note: null });
    const dir = join(root, "checkpoints", checkpoint.id);
    const [before, after] = await Promise.all([readFile(join(dir, "0-before.png")), readFile(join(dir, "0-after.png"))]);
    expect(before.subarray(1, 4).toString()).toBe("PNG");
    expect(before.equals(after)).toBe(false);
    expect((await checker.diff(checkpoint)).includes("-require") || (await checker.diff(checkpoint)).includes("+require")).toBe(true);
    expect((await exec("git", ["worktree", "list"], { cwd: repo })).stdout).not.toContain("before");
  } finally {
    await runtime.stop("fixture/01").catch(() => {});
    store.close();
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);
