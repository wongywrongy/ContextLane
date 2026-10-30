import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Lane } from "@contextlanes/protocol";
import { Config, EventBus, LocalModels, Store, runCommand, type Runner, type Runtime } from "@contextlanes/daemon";
import { Helper } from "../src/helper.js";

const roots: string[] = [];
afterEach(async () => { for (const r of roots.splice(0)) await rm(r, { recursive: true, force: true }); });

async function fixture(opts: { model?: boolean; answer?: (prompt: string) => string } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "cl-helper-"))); roots.push(root);
  const worktree = join(root, "lane"); await mkdir(worktree);
  const git = (...a: string[]) => runCommand("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", ...a], { cwd: worktree });
  await git("init", "-q"); await writeFile(join(worktree, "fees.py"), "def fee(club):\n    return club.base\n"); await writeFile(join(worktree, "test.log"), `${"PASS ok\n".repeat(3000)}FAIL test_due_date: expected UTC\n`);
  await git("add", "-A"); await git("commit", "-qm", "one");
  const store = Store.open(":memory:"); const bus = new EventBus();
  store.addProject({ id: "shop", name: "Shop", path: worktree });
  const lane = store.insertLane({ id: "shop/01", n: 1, project: "shop", goal: null, task: "x", agent: "codex", model: null, mode: "ask", branch: "b", worktree, terminal: "t", hostUnit: null, base: "main", state: "working", colour: "lc1" }) as Lane;
  const prompts: string[] = [];
  const fetch = (async (_u: string, init?: RequestInit) => { if (!init?.body) return Response.json({ models: [] }); const p = (JSON.parse(String(init.body)) as { messages: { content: string }[] }).messages.at(-1)!.content; prompts.push(p); return Response.json({ model: "qwen3-coder", choices: [{ message: { content: opts.answer?.(p) ?? "test.log:3001 FAIL test_due_date: expected UTC" } }] }); }) as unknown as typeof globalThis.fetch;
  const config = Config.parse({ paths: { data: join(root, "data"), lanes: join(root, "lanes") }, localModels: opts.model === false ? [] : [{ name: "qwen3-coder", provider: "ollama", url: "http://127.0.0.1:11434" }] });
  const run: Runner = async (cmd, args, o) => cmd === "systemd-run" ? { stdout: "FAILED test_due_date\n1 failed, 40 passed in 1.2s\n" } : runCommand(cmd, args, o);
  const runtime = { recipeFor: async () => ({ checks: [{ name: "Tests", command: ["pytest", "-q"], timeoutSeconds: 60 }] }) } as unknown as Runtime;
  const helper = new Helper({ config, store, bus, models: new LocalModels({ config, run, fetch }), run, runtime });
  const turnEnd = () => bus.publish(store.appendEvent(lane.id, { type: "agent.turn", payload: { active: false } }));
  return { store, lane, helper, prompts, worktree, turnEnd, bus, root };
}
const flush = () => new Promise((r) => setTimeout(r, 50));

describe("local helper", () => {
  it("read: answers from the files, records the tokens it saved, and counts a redo when the lead reads them anyway", async () => {
    const f = await fixture();
    const r = await f.helper.delegate(f.lane, { kind: "read", task: "Which test fails and why?", files: ["test.log"] });
    expect(r.result).toContain("test_due_date");
    expect(r.tokensSaved).toBeGreaterThan(5000);
    expect(f.store.events(f.lane.id).at(-1)).toMatchObject({ type: "helper.delegated", payload: { kind: "read", model: "qwen3-coder", files: ["test.log"] } });
    await expect(f.helper.delegate(f.lane, { kind: "read", task: "x", files: ["../../etc/passwd"] })).rejects.toThrow(/outside this lane's checkout/);
    // A symlink the agent planted to a file outside its checkout is not read.
    await symlink("/etc/hostname", join(f.worktree, "host.txt"));
    const before = f.prompts.length;
    await f.helper.delegate(f.lane, { kind: "read", task: "quote it", files: ["host.txt"] });
    expect(f.prompts.slice(before).join("")).toContain("not a regular file");
    f.bus.publish(f.store.appendEvent(f.lane.id, { type: "tool.call", payload: { callId: "c", kind: "read", title: "Read test.log", files: [join(f.worktree, "test.log")] } }));
    f.turnEnd(); await flush();
    expect(f.store.events(f.lane.id).filter((e) => e.type === "helper.redone")).toHaveLength(1);
  });

  it("check: runs only the approved recipe's checks, in the sandbox, and returns the sorted failures", async () => {
    const f = await fixture();
    const r = await f.helper.delegate(f.lane, { kind: "check", task: "billing tests", files: [] });
    expect(r.result).toContain("test_due_date");
    expect(f.prompts[0]).toContain("=== Tests (pytest -q): passed");
  });

  it("edit: returns a patch that applies, never writes it, and counts a redo when it was not applied", async () => {
    const diff = "--- a/fees.py\n+++ b/fees.py\n@@ -1,2 +1,2 @@\n def fee(club):\n-    return club.base\n+    return club.base * 2\n";
    const f = await fixture({ answer: () => "```diff\n" + diff + "```" });
    const r = await f.helper.delegate(f.lane, { kind: "edit", task: "double the fee", files: ["fees.py"] });
    expect(r.result).toMatch(/^This patch applies cleanly/);
    expect((await runCommand("git", ["status", "--porcelain"], { cwd: f.worktree })).stdout).toBe(""); // the helper wrote nothing
    f.turnEnd(); await flush();
    expect(f.store.events(f.lane.id).filter((e) => e.type === "helper.redone")).toHaveLength(1);
  });

  it("turns a kind off after too many redos, and lets the owner decide", async () => {
    const f = await fixture();
    for (let i = 0; i < 6; i++) {
      const e = f.store.appendEvent(f.lane.id, { type: "helper.delegated", payload: { kind: "read", model: "m", tokensSaved: 1000 } });
      if (i < 2) f.store.appendEvent(f.lane.id, { type: "helper.redone", payload: { seq: e.seq, kind: "read" } });
    }
    const read = (await f.helper.status()).find((s) => s.kind === "read")!;
    expect(read).toMatchObject({ uses: 6, state: "off", savedThisWeek: 6000, reason: "Redone 33% of the last 6 times (limit 25%)." });
    await expect(f.helper.delegate(f.lane, { kind: "read", task: "x", files: ["fees.py"] })).rejects.toThrow(/off: Redone 33%/);
    await f.helper.setKind("read", true);
    expect((await f.helper.status()).find((s) => s.kind === "read")!.state).toBe("near");
    await f.helper.setKind("check", false);
    expect((await f.helper.status()).find((s) => s.kind === "check")).toMatchObject({ state: "off", reason: "Turned off by you." });
  });

  it("is off with no local model, so agents are not offered delegate", async () => {
    const f = await fixture({ model: false });
    expect(await f.helper.available()).toBe(false);
  });
});
