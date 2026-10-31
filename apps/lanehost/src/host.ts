import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { Readable, Writable } from "node:stream";
import { client, methods, ndJsonStream, PROTOCOL_VERSION, type ClientApp, type ClientConnection, type ContentBlock, type McpServer, type SessionConfigOption, type Usage } from "@agentclientprotocol/sdk/unstable";
import { mkdirSync, readFileSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { GENERIC_MODES, SafeMode, UNSAFE_OPTION, agentProfile, type CommandEnvelope, type LaneMode, type NewLaneEvent } from "@contextlanes/protocol";
import type { AgentSpec } from "./agents.js";
import { Coalescer, mapPermission } from "./map.js";
import { DaemonLink } from "./link.js";
import { SessionUsage, usageDelta, reportedLimits } from "./usage.js";

export type LaneHostOptions = {
  lane: string; cwd: string; task: string; agent: AgentSpec; socketPath: string; token: string;
  mcpServers?: McpServer[]; mode?: string; model?: string; effort?: string; signal?: AbortSignal; agentId?: string;
  /** The production transport is stdio; tests connect to an in-process SDK agent app. */
  connect?: (app: ClientApp) => ClientConnection;
};

export async function openAgentSession(opts: Omit<LaneHostOptions, "socketPath">, emit: (event: NewLaneEvent) => void) {
  const answers = new Map<string, { resolve: (id: string | null) => void; reject: (err: Error) => void; options: Set<string> }>();
  const profile = agentProfile(opts.agentId);
  const coalescer = new Coalescer(emit);
  const app = client({ name: "contextlanes" }).onRequest(methods.client.session.requestPermission, async ({ params }) => {
    const requestId = randomUUID();
    const answer = new Promise<string | null>((resolve, reject) => answers.set(requestId, { resolve, reject, options: new Set(params.options.map((o) => o.optionId)) }));
    coalescer.flush();
    emit(mapPermission(requestId, params));
    try {
      const optionId = await answer;
      return optionId === null ? { outcome: { outcome: "cancelled" } } : { outcome: { outcome: "selected", optionId } };
    } finally { answers.delete(requestId); }
  });
  let child: ReturnType<typeof spawn> | undefined;
  const connection = opts.connect ? opts.connect(app) : (() => {
    // Agents whose permissions are set at start (OpenCode, goose) get them for the lane's mode.
    const modeEnv = profile?.env?.[opts.mode === "plan" || opts.mode === "edits" ? opts.mode : "ask"] ?? {};
    child = spawn(opts.agent.command, opts.agent.args, { cwd: opts.cwd, env: { ...process.env, ...opts.agent.env, ...modeEnv, CONTEXTLANES_LANE: opts.lane, INITIAL_AGENT_MODE: "read-only" }, stdio: ["pipe", "pipe", "inherit"] });
    const stream = ndJsonStream(Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>, Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>);
    return app.connect(stream);
  })();
  // "spawn x ENOENT" means nothing to the owner; say which command is missing and where to fix it.
  child?.on("error", (err: NodeJS.ErrnoException) => connection.close(err.code === "ENOENT" ? new Error(`The agent's command ${opts.agent.command} is not installed on this machine. Install it, or fix its command in Models.`) : err));
  const abort = () => { connection.close(); child?.kill(); };
  opts.signal?.addEventListener("abort", abort, { once: true });
  const ctx = connection.agent;
  try {
    const init = await ctx.request(methods.agent.initialize, { protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false, session: { compaction: {} },
        // Command output as appended chunks with exit codes (Claude, Codex and Droid send them when asked).
        _meta: { terminal_output_delta: true } }, clientInfo: { name: "contextlanes", version: "0.1.0" } });
    // A lane is a git worktree: its commits are written to the main repository's git folder, outside the
    // checkout. Agents whose own sandbox limits writes to the checkout (Codex's workspace access) get the parts
    // a commit needs as extra roots: this worktree's folder, objects, refs and logs. Never hooks or config.
    const roots = gitWriteRoots(opts.cwd);
    const additional = roots.length && init.agentCapabilities?.sessionCapabilities?.additionalDirectories ? { additionalDirectories: roots } : {};
    let builder = ctx.buildSession({ cwd: opts.cwd, mcpServers: [], ...additional, _meta: { additionalRoots: roots, claudeCode: { options: { allowDangerouslySkipPermissions: false, permissionMode: "default", additionalDirectories: roots } } } });
    for (const server of opts.mcpServers ?? []) builder = builder.withMcpServer(server);
    const session = await builder.start();
    const logs = new SessionUsage(opts.agentId, opts.cwd, session.sessionId, { ...process.env, ...opts.agent.env });
    let sessionCost = 0;
    const compactions = new Set<string>();
    let configOptions = session.newSessionResponse.configOptions ?? [];
    const modelOption = () => configOptions.find((o) => o.type === "select" && (o.category === "model" || o.id === "model"));
    // Effort: the ACP thought_level category, Mistral Vibe's "thinking", or an option named for it.
    const effortOption = () => configOptions.find((o) => o.type === "select" && (o.category === "thought_level" || o.category === "thinking" || /effort|reasoning|thinking/i.test(o.id)));
    const modelValues = (option: SessionConfigOption | undefined) => !option || option.type !== "select" ? [] : option.options.flatMap((o) => "options" in o ? o.options : [o]);
    // Modes are ACP session modes for most agents; OpenCode and Factory Droid offer them as a config option.
    const modeOption = () => session.modes ? undefined : configOptions.find((o) => o.type === "select" && (profile?.modeOption ? o.id === profile.modeOption : o.category === "mode" && modelValues(o).some((v) => GENERIC_MODES.ask.test(v.value) || GENERIC_MODES.plan.test(v.value))));
    const allModes = (): { id: string; name: string }[] => session.modes ? session.modes.availableModes.map((m) => ({ id: m.id, name: m.name }))
      : modelValues(modeOption()).map((v) => ({ id: v.value, name: v.name }));
    const safe = (m: { id: string; name: string }) => SafeMode.safeParse(m.id).success && SafeMode.safeParse(m.name).success && !profile?.unsafeModes?.includes(m.id.split("#").at(-1)!);
    let currentMode = session.modes?.currentModeId ?? (() => { const o = modeOption(); return o?.type === "select" ? o.currentValue : undefined; })();
    let commands: { name: string; description: string }[] = [];
    const canImage = !!init.agentCapabilities?.promptCapabilities?.image;
    const reportSession = () => {
      const model = modelOption();
      const effort = effortOption();
      emit({ type: "agent.session", payload: { sessionId: session.sessionId, currentMode,
        currentModel: model?.type === "select" ? model.currentValue : undefined,
        efforts: modelValues(effort).map((e) => ({ id: e.value, label: e.name })), currentEffort: effort?.type === "select" ? effort.currentValue : undefined,
        modes: allModes().filter(safe).map((m) => ({ id: m.id, label: m.name })),
        models: modelValues(model).map((m) => ({ id: m.value, label: m.name })), commands, images: canImage } });
    };
    const setOption = async (configId: string, value: string | boolean) => {
      const result = await ctx.request(methods.agent.session.setConfigOption, (typeof value === "boolean" ? { sessionId: session.sessionId, configId, type: "boolean", value } : { sessionId: session.sessionId, configId, value }) as never);
      configOptions = (result as { configOptions: SessionConfigOption[] }).configOptions;
    };
    const setMode = async (mode: string) => {
      SafeMode.parse(mode);
      const found = allModes().find((m) => m.id === mode);
      if (!found || !safe(found)) throw new Error(`agent does not offer mode ${mode}`);
      const option = modeOption();
      if (option) await setOption(option.id, mode);
      else await ctx.request(methods.agent.session.setMode, { sessionId: session.sessionId, modeId: mode });
      currentMode = mode;
      reportSession();
    };
    const setModel = async (model: string) => {
      const option = modelOption();
      if (!option || !modelValues(option).some((m) => m.value === model)) throw new Error(`agent does not offer model ${model}`);
      await setOption(option.id, model);
      reportSession();
    };
    const setEffort = async (level: string) => {
      const option = effortOption();
      if (!option) throw new Error("this agent has no effort setting");
      const values = modelValues(option);
      // The owner picks low, medium or high; agents name theirs (minimal, xhigh…), so take the closest.
      const value = values.find((v) => v.value === level)?.value ?? closestEffort(level, values.map((v) => v.value));
      if (!value) throw new Error(`agent does not offer effort ${level}`);
      await setOption(option.id, value);
      reportSession();
    };
    // Switches that turn prompts off (Copilot's allow_all, Cline's auto_approve…) go off before anything runs.
    for (const option of [...configOptions]) {
      const forced = profile?.force?.[option.id];
      const risky = UNSAFE_OPTION.test(`${option.id} ${option.name}`);
      if (forced === undefined && !risky) continue;
      if (option.type === "boolean") { if (option.currentValue !== (forced ?? false)) await setOption(option.id, forced ?? false); continue; }
      if (option.type !== "select") continue;
      const off = typeof forced === "string" ? forced : modelValues(option).find((v) => /^(off|false|default|no|none|ask)$/i.test(v.value))?.value;
      if (!off) throw new Error(`${option.name} could not be turned off, so this agent would act without asking.`);
      if (option.currentValue !== off) await setOption(option.id, off);
    }
    // The lane's mode: the agent's own mode for "ask first", "edit the checkout" or "plan only", from its
    // profile or by name; never one that lets something else approve. Many agents start in such a mode
    // (goose, Qwen, Codex), so a lane always sets one, and fails if none of the agent's modes asks first.
    const wanted: LaneMode = opts.mode === "plan" || opts.mode === "edits" ? opts.mode : "ask";
    const choose = (mode: LaneMode) => {
      const modes = allModes().filter(safe);
      const listed = profile?.modes?.[mode];
      if (listed) return listed.map((id) => modes.find((m) => m.id === id || m.id.endsWith(`#${id}`))).find(Boolean)?.id;
      return modes.find((m) => GENERIC_MODES[mode].test(m.id) || GENERIC_MODES[mode].test(m.name))?.id;
    };
    const initialMode = opts.mode && !["ask", "edits", "plan"].includes(opts.mode) ? opts.mode : choose(wanted) ?? choose("ask");
    if (allModes().length) {
      if (!initialMode) throw new Error(`None of ${profile?.name ?? "this agent"}'s modes asks before acting, so ContextLanes cannot run it in a lane.`);
      await setMode(initialMode).catch(async (err: Error) => {
        // Gemini refuses Auto Edit in a folder it does not trust: fall back to asking, and say so.
        const ask = choose("ask");
        if (!ask || ask === initialMode) throw err;
        emit({ type: "agent.error", payload: { message: `The agent refused its ${wanted === "edits" ? "edit" : "plan"} mode (${err.message}); it asks before acting instead.` } });
        await setMode(ask);
      });
    } else if (currentMode && !SafeMode.safeParse(currentMode).success) throw new Error("This agent is in a mode that approves for you, and offers no other.");
    if (wanted === "plan" && profile?.planOption) await setOption(profile.planOption.id, profile.planOption.value).catch(() => {});
    if (opts.model) await setModel(opts.model);
    if (opts.effort) await setEffort(opts.effort).catch((err: Error) => emit({ type: "agent.error", payload: { message: `Effort was left at the agent's default: ${err.message}` } }));
    reportSession();
    type Queued = { text: string; commandId?: string; files?: string[]; images?: { mimeType: string; path: string }[]; steer?: boolean; steered?: boolean };
    const prompts: Queued[] = opts.task ? [{ text: opts.task }] : [];
    // @ file arrives as ACP resource links, which every agent must accept; pictures only when the agent said it takes them.
    const blocks = async (q: Queued): Promise<ContentBlock[]> => [{ type: "text", text: q.text },
      ...(q.files ?? []).map((f) => ({ type: "resource_link" as const, uri: pathToFileURL(resolve(opts.cwd, f)).href, name: basename(f) })),
      ...(canImage ? await Promise.all((q.images ?? []).map(async (i) => ({ type: "image" as const, mimeType: i.mimeType, data: (await readFile(i.path)).toString("base64") }))) : [])];
    let running = false;
    let stopped = false;
    // A message sent while a turn runs is delivered at the next step boundary, not when the turn ends: some
    // agents (Codex) keep one turn going for hours. When no tool call is running and no approval is waiting,
    // the turn is stopped cleanly and the message goes in as the next prompt; the session keeps its history.
    const inFlight = new Set<string>();
    let steering = false;
    const steerIfIdle = () => {
      if (!running || steering || stopped || !prompts.some((p) => p.steer) || inFlight.size || answers.size) return;
      steering = true;
      for (const p of prompts) if (p.steer) p.steered = true;
      void ctx.notify(methods.agent.session.cancel, { sessionId: session.sessionId }).catch(() => { steering = false; });
    };
    const drain = async () => {
      if (running || stopped) return;
      running = true;
      try {
        while (prompts.length && !stopped) {
          const queued = prompts.shift()!;
          const { commandId } = queued;
          const turnId = randomUUID();
          const before = await logs.read();
          const costBefore = sessionCost;
          let reportedCost = false;
          let promptUsage: Usage | null | undefined;
          emit({ type: "agent.turn", payload: { active: true, commandId } });
          const tick = setInterval(() => coalescer.flush(), 100);
          inFlight.clear();
          try {
            // A steered message says so, so the agent picks the task back up afterwards.
            const done = session.prompt(await blocks(queued.steered ? { ...queued, text: `${queued.text}\n\n(Sent to you between steps. Take it into account, then carry on with the task.)` } : queued));
            void done.catch(() => {});
            for (;;) {
              const message = await session.nextUpdate();
              if (message.kind === "stop") break;
              if (message.update.sessionUpdate === "current_mode_update") { currentMode = message.update.currentModeId; reportSession(); }
              if (message.update.sessionUpdate === "config_option_update") { configOptions = message.update.configOptions; reportSession(); }
              if (message.update.sessionUpdate === "available_commands_update") { commands = message.update.availableCommands.map((c) => ({ name: c.name, description: c.description })); reportSession(); }
              if (message.update.sessionUpdate === "usage_update") for (const limit of reportedLimits(message.update._meta)) emit({ type: "usage.limit", payload: limit });
              if (message.update.sessionUpdate === "usage_update" && message.update.cost?.currency === "USD") {
                sessionCost = message.update.cost.amount;
                reportedCost = true;
              }
              if (message.update.sessionUpdate === "compaction_update" && message.update.status === "completed" && !compactions.has(message.update.compactionId)) {
                compactions.add(message.update.compactionId);
                emit({ type: "usage.compaction", payload: { sessionId: session.sessionId, compactionId: message.update.compactionId, source: "acp" } });
              }
              coalescer.push(message.update);
              const u = message.update;
              if (u.sessionUpdate === "tool_call" || u.sessionUpdate === "tool_call_update") {
                if (u.status === "completed" || u.status === "failed") inFlight.delete(u.toolCallId);
                else if (u.sessionUpdate === "tool_call" || u.status === "in_progress" || u.status === "pending") inFlight.add(u.toolCallId);
              }
              steerIfIdle();
            }
            const result = await done;
            promptUsage = result.usage;
            coalescer.flush();
            emit({ type: "agent.turn", payload: { active: false, stopReason: steering && result.stopReason === "cancelled" ? "steered" : result.stopReason, commandId } });
          } catch (err) {
            if (!stopped) emit({ type: "agent.error", payload: { message: err instanceof Error ? err.message : String(err) } });
          } finally {
            steering = false;
            clearInterval(tick); coalescer.flush();
            const fallback = promptUsage ? null : await logs.read();
            const tokens = promptUsage ? { inputTokens: promptUsage.inputTokens, outputTokens: promptUsage.outputTokens,
              cacheReadTokens: promptUsage.cachedReadTokens ?? null, cacheWriteTokens: promptUsage.cachedWriteTokens ?? null }
              : fallback ? usageDelta(fallback.tokens, before?.tokens) : null;
            if (tokens || reportedCost) emit({ type: "usage.turn", payload: { turnId, sessionId: session.sessionId,
              source: promptUsage || !tokens ? "acp" : fallback!.source,
              ...(tokens ?? { inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null }),
              ...(reportedCost ? { costUsd: sessionCost >= costBefore ? sessionCost - costBefore : sessionCost, costSource: "acp" } : {}) } });
          }
        }
      } finally { running = false; }
    };
    const seen = new Set<string>();
    const command = async ({ commandId, command }: CommandEnvelope) => {
      if (seen.has(commandId)) return;
      seen.add(commandId);
      try {
        if (command.kind === "answer") {
          const pending = answers.get(command.requestId);
          if (!pending) throw new Error("permission is not pending in this host");
          if (command.optionId !== null && !pending.options.has(command.optionId)) throw new Error("invalid permission option");
          pending.resolve(command.optionId);
        } else if (command.kind === "prompt") {
          if (command.immediate) {
            prompts.unshift({ text: command.text, commandId, files: command.files, images: command.images });
            if (running) await ctx.notify(methods.agent.session.cancel, { sessionId: session.sessionId });
          } else prompts.push({ text: command.text, commandId, files: command.files, images: command.images, steer: running });
          void drain();
          steerIfIdle();
        } else if (command.kind === "cancel") {
          await ctx.notify(methods.agent.session.cancel, { sessionId: session.sessionId });
        } else if (command.kind === "mode") await setMode(command.mode);
        else if (command.kind === "effort") await setEffort(command.effort);
        else await setModel(command.model);
        emit({ type: "agent.command.result", payload: { commandId, ok: true } });
      } catch (err) {
        emit({ type: "agent.command.result", payload: { commandId, ok: false, error: err instanceof Error ? err.message : String(err) } });
      }
    };
    void drain();
    const close = () => {
      stopped = true;
      for (const answer of answers.values()) answer.reject(new Error("lane host closed"));
      session.dispose();
      connection.close();
      child?.kill();
      opts.signal?.removeEventListener("abort", abort);
    };
    return { command, close, closed: connection.closed };
  } catch (err) {
    connection.close();
    child?.kill();
    opts.signal?.removeEventListener("abort", abort);
    throw err;
  }
}

export async function runLaneHost(opts: LaneHostOptions): Promise<void> {
  let controls: ReturnType<typeof openAgentSession>;
  // Refused by the daemon (restarted elsewhere, or deleted): stop the agent rather than work unseen.
  const refused = new AbortController();
  opts = { ...opts, signal: opts.signal ? AbortSignal.any([opts.signal, refused.signal]) : refused.signal };
  const link = new DaemonLink({ lane: opts.lane, token: opts.token, path: opts.socketPath, command: (message) => { void controls.then((session) => session.command(message)).catch(() => {}); }, refused: () => refused.abort() });
  link.start();
  const stop = () => link.close();
  opts.signal?.addEventListener("abort", stop, { once: true });
  try {
    controls = openAgentSession(opts, (event) => link.emit(event));
    const session = await controls;
    try {
      await Promise.race([session.closed, new Promise<void>((resolve) => opts.signal?.addEventListener("abort", () => resolve(), { once: true }))]);
      if (!opts.signal?.aborted) throw new Error("agent connection closed; inspect the lane host journal");
    } finally { session.close(); }
  } catch (err) {
    if (!opts.signal?.aborted) {
      link.emit({ type: "agent.error", payload: { message: err instanceof Error ? err.message : String(err) } });
      await link.flush();
      throw err;
    }
  } finally {
    link.close();
    opts.signal?.removeEventListener("abort", stop);
  }
}

/** The folders of the main repository a commit in this worktree writes to; empty for an ordinary checkout. */
export function gitWriteRoots(cwd: string): string[] {
  try {
    const pointer = readFileSync(join(cwd, ".git"), "utf8").match(/^gitdir:\s*(.+)$/m)?.[1]?.trim();
    if (!pointer) return [];
    const gitdir = resolve(cwd, pointer);
    const common = resolve(gitdir, readFileSync(join(gitdir, "commondir"), "utf8").trim());
    // The first commit with a reflog creates logs/; made here so it can be a root.
    try { mkdirSync(join(common, "logs"), { recursive: true }); } catch { /* Read-only repository: commits fail anyway. */ }
    return [gitdir, join(common, "objects"), join(common, "refs"), join(common, "logs")].filter((d) => { try { return statSync(d).isDirectory(); } catch { return false; } });
  } catch { return []; }
}

const EFFORT_ORDER = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];
/** The agent's effort level nearest the one asked for, by its place in the usual order. */
export function closestEffort(wanted: string, offered: string[]): string | undefined {
  const rank = (v: string) => EFFORT_ORDER.indexOf(v.toLowerCase());
  const target = rank(wanted);
  // On a tie, lean the way the owner leaned: "high" takes the deeper level, "low" the lighter one.
  const lean = target > rank("medium") ? -1 : 1;
  return offered.filter((v) => rank(v) >= 0).sort((a, b) => Math.abs(rank(a) - target) - Math.abs(rank(b) - target) || lean * (rank(a) - rank(b)))[0];
}
