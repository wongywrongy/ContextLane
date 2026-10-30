import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it, vi } from "vitest";
import { RECIPE_FILE } from "@contextlanes/protocol";
import { Config, EventBus, Runtime, runCommand, Store, type Previews } from "@contextlanes/daemon";
import { readRecipe } from "../src/recipes.js";

const exec = promisify(execFile);
const SERVER = `const http = require("node:http");
console.log("args", process.argv.slice(2).join(" "));
http.createServer((req, res) => { console.log("request", req.url); res.end(process.env.GREETING ?? "none"); }).listen(Number(process.env.PORT), process.env.HOST);`;

it.runIf(process.env.CONTEXTLANES_REAL_HOSTS === "1")("runs a lane's service as a real systemd unit with health checks and journald logs", async () => {
  const root = await mkdtemp(join(tmpdir(), "cl-real-runtime-"));
  const repo = join(root, "repo"); const worktree = join(root, "lane");
  const git = (...args: string[]) => exec("git", ["-c", "user.name=CL", "-c", "user.email=cl@example.invalid", ...args], { cwd: repo });
  const store = Store.open(":memory:");
  // Real systemd, fake links: a fixture must never add routes to the machine's tailnet.
  const previews = { publish: async () => "https://fixture.invalid:4700", unpublish: async () => {} } as unknown as Previews;
  const runtime = new Runtime({ store, bus: new EventBus(), config: Config.parse({ paths: { data: join(root, "data"), lanes: root } }), run: runCommand, previews });
  try {
    await mkdir(repo);
    await git("init", "-b", "main");
    await writeFile(join(repo, ".gitignore"), ".env*\nnode_modules\n");
    await writeFile(join(repo, "server.cjs"), SERVER);
    await git("add", "."); await git("commit", "-m", "Fixture");
    await writeFile(join(repo, ".env.local"), "SECRET=real\n");
    await mkdir(join(repo, "node_modules/dep"), { recursive: true }); await writeFile(join(repo, "node_modules/dep/index.js"), "// dep\n");
    await git("worktree", "add", "-b", "lane/01", worktree);
    await writeFile(join(worktree, RECIPE_FILE), JSON.stringify({
      cache: ["node_modules"],
      setup: [{ name: "Marker", command: [process.execPath, "-e", "require('fs').writeFileSync('marker', 'ran')"] }],
      services: [{ name: "web", command: [process.execPath, "server.cjs", "$PORT", "100%", "$KEEP"], env: { GREETING: "hello" } }],
    }));
    store.addProject({ id: "fixture", name: "Fixture", path: repo });
    store.insertLane({ id: "fixture/01", n: 1, project: "fixture", goal: null, task: "T", agent: "codex", model: null, mode: "ask", branch: "lane/01", worktree, terminal: "t", hostUnit: null, base: null, state: "working", colour: "lc1" });
    store.approveRecipe("fixture", (await readRecipe(store, store.getProject("fixture")!, worktree))!.hash);

    const env = await runtime.start("fixture/01");
    const web = env.services[0]!;
    expect(env.error).toBeNull();
    expect(web).toMatchObject({ state: "healthy", name: "web" });
    expect(env.setup).toMatchObject({ ignored: [".env.local"], cache: "linked", steps: 1 });
    expect(await readFile(join(worktree, ".env.local"), "utf8")).toBe("SECRET=real\n");
    expect(await readFile(join(worktree, "marker"), "utf8")).toBe("ran");
    expect((await stat(join(worktree, "node_modules/dep/index.js"))).ino).toBe((await stat(join(repo, "node_modules/dep/index.js"))).ino);
    expect(await (await fetch(`http://127.0.0.1:${web.port}/`)).text()).toBe("hello");
    await vi.waitFor(async () => {
      const lines = (await runtime.logs("fixture/01", "web", 50)).map((l) => l.text);
      expect(lines).toContain(`args ${web.port} 100% $KEEP`);
      expect(lines).toContain("request /");
    }, { timeout: 5000 });

    await runtime.poll();
    expect(store.environment("fixture/01")!.services[0]).toMatchObject({ state: "healthy" });
    await exec("systemctl", ["--user", "kill", "--kill-whom=main", "-sKILL", web.unit]);
    await new Promise((resolve) => setTimeout(resolve, 200));
    await runtime.poll();
    expect(store.environment("fixture/01")!.services[0]!.state).toBe("failed");
    await vi.waitFor(async () => { await runtime.poll(); expect(store.environment("fixture/01")!.services[0]!.state).toBe("healthy"); }, { timeout: 8000, interval: 300 });

    await runtime.stop("fixture/01");
    await expect(fetch(`http://127.0.0.1:${web.port}/`)).rejects.toThrow();
  } finally {
    await runtime.stop("fixture/01").catch(() => {});
    store.close();
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
