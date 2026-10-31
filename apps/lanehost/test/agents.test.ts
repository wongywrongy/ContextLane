import { afterEach, describe, expect, it } from "vitest";
import { agent, methods, PROTOCOL_VERSION, type SessionConfigOption, type SessionMode } from "@agentclientprotocol/sdk/unstable";
import { openAgentSession } from "@contextlanes/lanehost";
import { AGENTS, agentProfile, SafeMode, type NewLaneEvent } from "@contextlanes/protocol";
import { exitOf, rawText } from "../src/map.js";
import { probeAgent } from "../src/probe.js";

/**
 * Each agent's quirks, played by a small SDK agent shaped like it (modes, config options, refusals) as its
 * source describes them. The lane must end in a mode that asks, with prompt-killing switches off.
 */
function shaped(shape: { modes?: SessionMode[]; current?: string; options?: SessionConfigOption[]; refuse?: string[]; newSessionError?: { code: number; message: string } }) {
  const log: { modes: string[]; options: [string, unknown][] } = { modes: [], options: [] };
  let options = shape.options ?? [];
  const app = agent({ name: "shaped" })
    .onRequest(methods.agent.initialize, () => ({ protocolVersion: PROTOCOL_VERSION, agentCapabilities: {}, authMethods: [{ id: "login", name: "Log in", _meta: { "terminal-auth": { command: "shaped", args: ["login"] } } }] }))
    .onRequest(methods.agent.session.new, () => {
      if (shape.newSessionError) throw Object.assign(new Error(shape.newSessionError.message), shape.newSessionError);
      return { sessionId: "s", ...(shape.modes ? { modes: { currentModeId: shape.current ?? shape.modes[0]!.id, availableModes: shape.modes } } : {}), configOptions: options };
    })
    .onRequest(methods.agent.session.setMode, ({ params }) => { if (shape.refuse?.includes(params.modeId)) throw new Error("Cannot enable privileged approval modes in an untrusted folder."); log.modes.push(params.modeId); return {}; })
    .onRequest(methods.agent.session.setConfigOption, ({ params }) => {
      log.options.push([params.configId, params.value]);
      options = options.map((o) => o.id === params.configId ? { ...o, currentValue: params.value } as SessionConfigOption : o);
      return { configOptions: options };
    })
    .onRequest(methods.agent.session.prompt, async () => ({ stopReason: "end_turn" }));
  return { app, log };
}
const select = (id: string, category: string, current: string, values: string[], name = id): SessionConfigOption =>
  ({ id, name, category, type: "select", currentValue: current, options: values.map((v) => ({ value: v, name: v })) });

const sessions: (() => void)[] = [];
afterEach(() => { for (const close of sessions.splice(0)) close(); });
async function open(agentId: string, a: ReturnType<typeof shaped>, mode: "ask" | "edits" | "plan" = "ask") {
  const events: NewLaneEvent[] = [];
  const session = await openAgentSession({ lane: "p/01", cwd: "/tmp", task: "", agentId, mode, agent: { command: "unused", args: [] }, connect: (c) => c.connect(a.app) }, (e) => events.push(e));
  sessions.push(() => session.close());
  return { events, last: () => events.findLast((e) => e.type === "agent.session") };
}

describe("agents, each as its source describes it", () => {
  it("goose starts in auto (approves everything): the lane switches it to approve, and never offers smart approve", async () => {
    const goose = shaped({ current: "auto", modes: [{ id: "auto", name: "Automatically approve tool calls" }, { id: "approve", name: "Ask before every tool call" }, { id: "smart_approve", name: "Ask only for sensitive tool calls" }, { id: "chat", name: "Chat only, no tool calls" }] });
    const { last } = await open("goose", goose);
    expect(goose.log.modes).toEqual(["approve"]);
    expect(last()).toMatchObject({ payload: { modes: [{ id: "approve" }, { id: "chat" }] } });
  });

  it("Qwen Code starts in auto: ask, edits and plan map to default, auto-edit and plan", async () => {
    const modes = [{ id: "plan", name: "Plan" }, { id: "default", name: "Default" }, { id: "auto-edit", name: "Auto Edit" }, { id: "auto", name: "Auto" }, { id: "yolo", name: "YOLO" }];
    for (const [mode, id] of [["ask", "default"], ["edits", "auto-edit"], ["plan", "plan"]] as const) {
      const qwen = shaped({ current: "auto", modes });
      await open("qwen-code", qwen, mode);
      expect(qwen.log.modes).toEqual([id]);
    }
  });

  it("OpenCode has modes only as a config option: plan sets the option", async () => {
    const opencode = shaped({ options: [select("model", "model", "a", ["a"]), select("mode", "mode", "build", ["build", "plan"])] });
    const { last } = await open("opencode", opencode, "plan");
    expect(opencode.log.options).toContainEqual(["mode", "plan"]);
    expect(last()).toMatchObject({ payload: { currentMode: "plan", modes: [{ id: "build" }, { id: "plan" }] } });
    expect(agentProfile("opencode")!.env!.ask!.OPENCODE_PERMISSION).toContain('"bash":"ask"');
  });

  it("Factory Droid: autonomy levels as a config option; normal, auto-low and spec; never auto-medium or high", async () => {
    const droid = shaped({ options: [select("autonomy_level", "mode", "auto-medium", ["normal", "spec", "auto-low", "auto-medium", "auto-high"]), select("reasoning_effort", "thought_level", "high", ["off", "low", "medium", "high"])] });
    const { last } = await open("factory-droid", droid, "edits");
    expect(droid.log.options).toContainEqual(["autonomy_level", "auto-low"]);
    expect(last()).toMatchObject({ payload: { modes: [{ id: "normal" }, { id: "spec" }, { id: "auto-low" }], efforts: [{ id: "off" }, { id: "low" }, { id: "medium" }, { id: "high" }] } });
  });

  it("GitHub Copilot: allow_all is turned off, autopilot is never offered, ids end in #mode", async () => {
    const copilot = shaped({ current: "x#agent", modes: [{ id: "x#agent", name: "Agent" }, { id: "x#plan", name: "Plan" }, { id: "x#autopilot", name: "Autopilot" }],
      options: [select("allow_all", "permissions", "on", ["on", "off"], "Allow all")] });
    const { last } = await open("github-copilot", copilot, "plan");
    expect(copilot.log.options).toContainEqual(["allow_all", "off"]);
    expect(copilot.log.modes).toEqual(["x#plan"]);
    expect((last()!.payload as { modes: { id: string }[] }).modes.map((m) => m.id)).toEqual(["x#agent", "x#plan"]);
  });

  it("Cline: the auto_approve switch is turned off", async () => {
    const cline = shaped({ current: "act", modes: [{ id: "plan", name: "Plan" }, { id: "act", name: "Act" }],
      options: [{ id: "auto_approve", name: "Auto approve", category: "_permissions", type: "boolean", currentValue: true } as SessionConfigOption] });
    await open("cline", cline);
    expect(cline.log.options).toContainEqual(["auto_approve", false]);
    expect(cline.log.modes).toEqual(["act"]);
  });

  it("Gemini refuses Auto Edit in an untrusted folder: the lane asks instead and says so", async () => {
    const gemini = shaped({ modes: [{ id: "default", name: "Default" }, { id: "autoEdit", name: "Auto Edit" }, { id: "yolo", name: "YOLO" }, { id: "plan", name: "Plan" }], refuse: ["autoEdit"] });
    const { events } = await open("gemini", gemini, "edits");
    expect(gemini.log.modes).toEqual(["default"]);
    expect(events.some((e) => e.type === "agent.error" && /asks before acting instead/.test(e.payload.message))).toBe(true);
  });

  it("Codex plan only is read-only plus its plan collaboration mode; Auto review is never used", async () => {
    const codex = shaped({ current: "agent", modes: [{ id: "read-only", name: "Read-only" }, { id: "workspace-write", name: "Workspace access" }, { id: "agent", name: "Auto review" }, { id: "agent-full-access", name: "Full access" }],
      options: [select("collaboration_mode", "collaboration_mode", "default", ["default", "plan"])] });
    const { last } = await open("codex", codex, "plan");
    expect(codex.log.modes).toEqual(["read-only"]);
    expect(codex.log.options).toContainEqual(["collaboration_mode", "plan"]);
    expect((last()!.payload as { modes: { id: string }[] }).modes.map((m) => m.id)).toEqual(["read-only", "workspace-write"]);
  });

  it("refuses an agent none of whose modes asks first", async () => {
    const yolo = shaped({ modes: [{ id: "yolo", name: "YOLO" }, { id: "auto", name: "Auto" }] });
    await expect(open("someagent", yolo)).rejects.toThrow(/cannot run it in a lane/);
  });
});

describe("what agents say about commands", () => {
  it("reads exit codes wherever each agent puts them", () => {
    expect(exitOf({ terminal_exit: { exit_code: 2 } }, undefined)).toBe(2);
    expect(exitOf(undefined, { stdout: "", stderr: "x", exit_code: 1, timed_out: false })).toBe(1); // goose
    expect(exitOf(undefined, { output: "x", metadata: { output: "x", exit: 127, truncated: false } })).toBe(127); // OpenCode
    expect(exitOf(undefined, undefined, "Output: (empty)\nExit Code: 3")).toBe(3); // Qwen
    expect(exitOf(undefined, undefined, "Command exited with code: 1")).toBe(1); // Gemini
    expect(exitOf(undefined, undefined, "Command failed with exit code: 4")).toBe(4); // Kimi
    expect(exitOf(undefined, undefined, "<return-code>5</return-code>")).toBe(5); // Auggie
    expect(exitOf(undefined, undefined, "all good")).toBeUndefined();
    expect(rawText({ output: "built" })).toBe("built");
    expect(rawText({ stdout: "out", stderr: "err" })).toBe("out\nerr");
    expect(rawText("plain")).toBe("plain");
  });
});

describe("probe", () => {
  it("reports modes and options of an agent that is signed in, and the terminal sign-in it offers", async () => {
    const a = shaped({ modes: [{ id: "default", name: "Default" }], options: [select("reasoning_effort", "thought_level", "medium", ["low", "medium"])] });
    const p = await probeAgent({ agent: { command: "unused", args: [] }, cwd: "/tmp", connect: (c) => c.connect(a.app) });
    expect(p).toMatchObject({ state: "ready", auth: [{ id: "login", command: "shaped", args: ["login"] }], modes: [{ id: "default" }], options: [{ id: "reasoning_effort", category: "thought_level", values: ["low", "medium"] }] });
  });

  it("says sign in when session/new answers auth_required", async () => {
    const a = shaped({ newSessionError: { code: -32000, message: "Authentication required" } });
    expect(await probeAgent({ agent: { command: "unused", args: [] }, cwd: "/tmp", connect: (c) => c.connect(a.app) })).toMatchObject({ state: "signin", error: expect.stringContaining("Authentication") });
  });
});

describe("profiles", () => {
  it("never list a mode SafeMode refuses, and unsupported agents say why", () => {
    for (const a of AGENTS) {
      for (const ids of Object.values(a.modes ?? {})) for (const id of ids) expect(SafeMode.safeParse(id).success, `${a.id} ${id}`).toBe(true);
      if (a.support === "unsupported") expect(a.note).toMatch(/without asking|never asks/i);
    }
    expect(agentProfile("claude-acp")!.id).toBe("claude-code");
    expect(agentProfile(undefined)).toBeNull();
  });
});
