import { mkdir, mkdtemp, readFile, realpath, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Config, EventBus, LaneManager, Store, runCommand, type Runner } from "@contextlanes/daemon";
import { agentOf, claudeSlug, handoffFrom, OutsideAgents, sessionMessages } from "../src/outside.js";

const roots: string[] = [];
afterEach(async () => { for (const r of roots.splice(0)) await rm(r, { recursive: true, force: true }); });

describe("sessions started outside ContextLanes", () => {
  it("recognises Claude Code and Codex sessions, not adapters, logins or MCP servers", () => {
    expect(agentOf("claude")).toBe("claude-code");
    expect(agentOf("/home/k/.local/bin/claude --continue")).toBe("claude-code");
    expect(agentOf("node /usr/lib/node_modules/@anthropic-ai/claude-code/cli.js")).toBe("claude-code");
    expect(agentOf("codex")).toBe("codex");
    expect(agentOf("node /x/@openai/codex/bin/codex.js resume")).toBe("codex");
    for (const no of ["claude auth login", "node /x/claude-agent-acp/dist/index.js", "codex-acp", "codex login --device-auth", "claude mcp serve", "vim claude.md", "grep codex"]) expect(agentOf(no)).toBeNull();
    expect(claudeSlug("/home/k/code/shop.app")).toBe("-home-k-code-shop-app");
  });

  it("reads the conversation from Claude Code and Codex logs, without tool output", () => {
    const claude = [
      { type: "user", message: { role: "user", content: "Add invoices" } },
      { type: "assistant", message: { content: [{ type: "text", text: "Reading billing/" }, { type: "tool_use", name: "Read" }] } },
      { type: "user", message: { content: [{ type: "tool_result", content: "secret file body" }] } },
      { type: "user", isMeta: true, message: { content: "<command-name>/clear</command-name>" } },
    ].map((r) => JSON.stringify(r)).join("\n");
    expect(sessionMessages("claude-code", claude)).toEqual([{ role: "user", text: "Add invoices" }, { role: "agent", text: "Reading billing/" }]);
    const codex = [
      { type: "session_meta", payload: { cwd: "/c" } },
      { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "<environment_context>cwd</environment_context>" }] } },
      { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Fix the solver" }] } },
      { type: "response_item", payload: { type: "function_call", name: "shell" } },
      { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Done" }] } },
    ].map((r) => JSON.stringify(r)).join("\n");
    expect(sessionMessages("codex", codex)).toEqual([{ role: "user", text: "Fix the solver" }, { role: "agent", text: "Done" }]);
    const handoff = handoffFrom([{ role: "user", text: "Fix the solver" }, ...Array.from({ length: 50 }, (_, i) => ({ role: "agent" as const, text: `step ${i} ${"x".repeat(300)}` }))], "/c");
    expect(handoff).toContain("Fix the solver"); expect(handoff).toContain("step 49"); expect(handoff).not.toContain("step 0 "); expect(handoff.length).toBeLessThan(11_000);
  });

  it("lists a running session, refuses to take it over, then takes it over once it ends: same branch, changes carried", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "cl-outside-"))); roots.push(root);
    const repo = join(root, "shop"); const home = join(root, "home"); await mkdir(repo); await mkdir(home);
    const git = (cwd: string, ...a: string[]) => runCommand("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "init.defaultBranch=main", ...a], { cwd });
    await git(repo, "init", "-q"); await writeFile(join(repo, "a.txt"), "one\n"); await git(repo, "add", "-A"); await git(repo, "commit", "-qm", "one");
    await writeFile(join(repo, "a.txt"), "one\ntwo\n"); await writeFile(join(repo, "new.txt"), "fresh\n");
    const sessions = join(home, ".claude/projects", claudeSlug(repo)); await mkdir(sessions, { recursive: true });
    await writeFile(join(sessions, "s1.jsonl"), [{ type: "user", message: { content: "Add a second line" } }, { type: "assistant", message: { content: [{ type: "text", text: "Added it to a.txt" }] } }].map((r) => JSON.stringify(r)).join("\n"));
    const old = join(sessions, "old.jsonl"); await writeFile(old, "{}"); await utimes(old, 1000, 1000);
    let running = true;
    const run: Runner = async (cmd, args, opts) => {
      if (cmd === "ps") return { stdout: running ? `  4242   30 claude\n  4243   30 node /x/claude-agent-acp/dist/index.js\n` : "" };
      if (cmd === "readlink") return { stdout: `${repo}\n` };
      if (cmd === "cat") return { stdout: "0::/user.slice/app.slice/term.scope\n" };
      if (cmd === "git") return runCommand(cmd, args, opts);
      return { stdout: "" };
    };
    const config = Config.parse({ paths: { data: join(root, "data"), lanes: join(root, "lanes") }, lanes: { launchHosts: false } });
    const store = Store.open(":memory:"); const bus = new EventBus();
    store.addProject({ id: "shop", name: "Shop", path: repo });
    const lanes = new LaneManager({ store, bus, config, run });
    const outside = new OutsideAgents({ run, store, lanes, home, data: config.paths.data, lanesDir: config.paths.lanes });
    const [seen] = await outside.list("shop");
    expect(seen).toMatchObject({ agent: "claude-code", pid: 4242, cwd: repo, running: true, session: join(sessions, "s1.jsonl") });
    await expect(outside.takeOver("shop", 4242, seen!.startedAt)).rejects.toThrow(/Close the Claude Code session first/);
    running = false;
    expect((await outside.list("shop"))[0]).toMatchObject({ running: false });
    const lane = await outside.takeOver("shop", 4242, seen!.startedAt);
    expect(lane).toMatchObject({ task: "Continue: Add a second line", agent: "claude-code", base: "main" });
    expect(await readFile(join(lane.worktree, "a.txt"), "utf8")).toBe("one\ntwo\n");
    expect(await readFile(join(lane.worktree, "new.txt"), "utf8")).toBe("fresh\n");
    expect(await readFile(join(repo, "a.txt"), "utf8")).toBe("one\ntwo\n"); // the original folder is untouched
    expect(await outside.list("shop")).toEqual([]);
  });
});
