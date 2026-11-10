import { ALL_FEATURES } from "./features.js";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it, vi } from "vitest";
import { Config, EventBus, HostLinks, LaneManager, SetupManager, Store, buildServer, type Runner } from "@contextlanes/daemon";
import type { BenchResult } from "@contextlanes/protocol";
const exec = promisify(execFile);

it("runs contextlanes bench end to end through fake native CLI launches, hooks, JSONL usage and sandboxed checks", async () => {
  const root = await mkdtemp("/tmp/cl-bench-cli-");
  const source = join(root, "source"); await mkdir(source);
  vi.stubEnv("CLAUDE_CONFIG_DIR", source); vi.stubEnv("CODEX_HOME", source); vi.stubEnv("CONTEXTLANES_CONFIG", join(root, "config", "config.toml"));
  const config = Config.parse({ features: ALL_FEATURES, paths: { data: join(root, "data"), lanes: join(root, "lanes") }, access: { shellOwner: "fixture" } });
  const store = Store.open(":memory:"), bus = new EventBus();
  store.addProject({ id: "demo", name: "Demo", path: root });
  const launches: { agent: string; baseline: boolean; base: string | null; model: string | null }[] = [];
  const checks: string[][] = [], errors: unknown[] = [], pending: Promise<void>[] = [];
  let app: ReturnType<typeof buildServer>;
  const run: Runner = async (cmd, args) => {
    if (cmd === "git" && args[0] === "rev-parse") return { stdout: "a".repeat(40) };
    if (cmd === "bwrap" && args.includes("mcp")) return { stdout: "[]" };
    if (cmd === "systemd-run" && args.includes("--test")) checks.push(args);
    if (cmd === "tmux" && args[0] === "respawn-pane") {
      const spec = JSON.parse(await readFile(args.at(-1)!, "utf8"));
      const lane = store.getLane(spec.env.CONTEXTLANES_LANE)!;
      const baseline = !!store.eventsOfType(["lane.created"], { lanes: [lane.id] })[0]?.payload.baseline;
      launches.push({ agent: lane.agent, baseline, base: lane.base, model: lane.model });
      expect(spec.args).toContain(lane.agent === "codex" ? "codex" : "claude");
      if (lane.agent === "claude-code") {
        expect(spec.args.includes("--strict-mcp-config")).toBe(baseline);
        expect(Object.keys(JSON.parse(await readFile(spec.args[spec.args.indexOf("--mcp-config") + 1], "utf8")).mcpServers)).toEqual(baseline ? [] : ["contextlanes"]);
      }
      // The fake native agent writes the installed agents' verified JSONL shapes and calls their hooks.
      pending.push(new Promise<void>(resolve => setTimeout(resolve, 20)).then(async () => {
        const id = randomUUID(), home = spec.env.CLAUDE_CONFIG_DIR ?? spec.env.CODEX_HOME;
        const post = async (event: string) => {
          const r = await app.inject({ method: "POST", url: `/api/lanes/${lane.id}/hooks`, headers: { authorization: `Bearer ${spec.env.CONTEXTLANES_LANE_TOKEN}` }, payload: { eventId: randomUUID(), payload: { session_id: id, cwd: lane.worktree, hook_event_name: event } } });
          expect(r.statusCode).toBe(200); return r.json();
        };
        expect(await post("SessionStart")).toEqual(baseline ? {} : { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: expect.stringContaining("get_brief") } });
        await post("UserPromptSubmit");
        const input = baseline ? 90_000 : 50_000;
        const folder = join(home, lane.agent === "codex" ? "sessions/2026/11/01" : "projects/fixture"); await mkdir(folder, { recursive: true });
        const rows = lane.agent === "codex" ? [
          { type: "session_meta", payload: { id, cwd: lane.worktree } },
          { type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: input, output_tokens: 10_000, cached_input_tokens: 0, cache_write_input_tokens: 0 } } } },
        ] : [{ type: "assistant", cwd: lane.worktree, sessionId: id, message: { id: "answer", usage: { input_tokens: input, output_tokens: 10_000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }];
        await writeFile(join(folder, lane.agent === "codex" ? `rollout-fixture-${id}.jsonl` : `${id}.jsonl`), rows.map(row => JSON.stringify(row)).join("\n") + "\n");
        await post("Stop");
      }).catch(err => { errors.push(err); }));
    }
    return { stdout: "" };
  };
  const hosts = new HostLinks({ store, bus }), lanes = new LaneManager({ config, store, bus, run });
  const setup = new SetupManager(config, store, run, { home: root }); await setup.initialize();
  app = buildServer({ config, store, bus, run, lanes, hosts, setup, version: "fake-native-bench" });
  try {
    await app.listen({ host: "127.0.0.1", port: 0 });
    const port = (app.server.address() as { port: number }).port;
    const tasks = join(root, "tasks.json"); await writeFile(tasks, JSON.stringify(["claude-code", "codex"].map(agent => ({ project: "demo", task: `Fake ${agent} task`, agent, model: "fixture-model", check: ["node", "--test"] }))));
    const result = await exec(process.execPath, ["--import", import.meta.resolve("tsx"), "--conditions=source", fileURLToPath(new URL("../../cli/src/main.ts", import.meta.url)), "bench", tasks], { env: { ...process.env, CONTEXTLANES_URL: `http://127.0.0.1:${port}` }, timeout: 25_000 });
    await Promise.all(pending);
    expect(errors).toEqual([]);
    expect(launches).toHaveLength(4);
    expect(launches.every(l => l.base === "a".repeat(40) && l.model === "fixture-model")).toBe(true);
    expect(store.listLanes().every(l => l.kind === "cli")).toBe(true);
    expect(checks).toHaveLength(4); expect(checks.every(args => args.includes("bwrap"))).toBe(true);
    expect(store.eventsOfType(["usage.turn"]).map(e => e.payload.source).sort()).toEqual(["claude-log", "claude-log", "codex-log", "codex-log"]);
    expect(result.stdout).toContain("| Fake claude-code task | 100000 | 60000 | 40% fewer | passed / passed |");
    expect(result.stdout).toContain("| Fake codex task | 100000 | 60000 | 40% fewer | passed / passed |");
    const id = result.stdout.match(/Bench ([\w-]+) started/)![1]!;
    const saved = JSON.parse(await readFile(join(config.paths.data, "bench", `${id}.json`), "utf8")) as BenchResult;
    expect(saved.tasks.every(t => t.base === "a".repeat(40) && t.kind === "cli" && t.runs.every(r => r.minutes !== null && r.passed))).toBe(true);
    console.log(`Fake native benchmark (plumbing evidence only):\n${result.stdout}`);
  } finally { await Promise.all(pending); await app.close(); store.close(); vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); }
}, 30_000);
