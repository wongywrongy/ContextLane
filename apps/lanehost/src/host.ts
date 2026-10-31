import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { Readable, Writable } from "node:stream";
import { client, methods, ndJsonStream, PROTOCOL_VERSION, type ClientApp, type ClientConnection, type ContentBlock, type McpServer, type SessionConfigOption, type Usage } from "@agentclientprotocol/sdk/unstable";
import { readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { SafeMode, type CommandEnvelope, type NewLaneEvent } from "@contextlanes/protocol";
import type { AgentSpec } from "./agents.js";
import { Coalescer, mapPermission } from "./map.js";
import { DaemonLink } from "./link.js";
import { SessionUsage, usageDelta, reportedLimits } from "./usage.js";

export type LaneHostOptions = {
  lane: string; cwd: string; task: string; agent: AgentSpec; socketPath: string; token: string;
  mcpServers?: McpServer[]; mode?: string; model?: string; signal?: AbortSignal; agentId?: string;
  /** The production transport is stdio; tests connect to an in-process SDK agent app. */
  connect?: (app: ClientApp) => ClientConnection;
};

export async function openAgentSession(opts: Omit<LaneHostOptions, "socketPath">, emit: (event: NewLaneEvent) => void) {
  const answers = new Map<string, { resolve: (id: string | null) => void; reject: (err: Error) => void; options: Set<string> }>();
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
    child = spawn(opts.agent.command, opts.agent.args, { cwd: opts.cwd, env: { ...process.env, ...opts.agent.env, CONTEXTLANES_LANE: opts.lane, INITIAL_AGENT_MODE: "read-only" }, stdio: ["pipe", "pipe", "inherit"] });
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
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false, session: { compaction: {} } }, clientInfo: { name: "contextlanes", version: "0.1.0" } });
    let builder = ctx.buildSession({ cwd: opts.cwd, mcpServers: [], _meta: { claudeCode: { options: { allowDangerouslySkipPermissions: false, permissionMode: "default" } } } });
    for (const server of opts.mcpServers ?? []) builder = builder.withMcpServer(server);
    const session = await builder.start();
    const logs = new SessionUsage(opts.agentId, opts.cwd, session.sessionId, { ...process.env, ...opts.agent.env });
    let sessionCost = 0;
    const compactions = new Set<string>();
    let currentMode = session.modes?.currentModeId;
    let configOptions = session.newSessionResponse.configOptions ?? [];
    const modelOption = () => configOptions.find((o) => o.type === "select" && (o.category === "model" || o.id === "model"));
    const modelValues = (option: SessionConfigOption | undefined) => !option || option.type !== "select" ? [] : option.options.flatMap((o) => "options" in o ? o.options : [o]);
    let commands: { name: string; description: string }[] = [];
    const canImage = !!init.agentCapabilities?.promptCapabilities?.image;
    const reportSession = () => {
      const model = modelOption();
      emit({ type: "agent.session", payload: { sessionId: session.sessionId, currentMode,
        currentModel: model?.type === "select" ? model.currentValue : undefined,
        modes: (session.modes?.availableModes ?? []).filter((m) => SafeMode.safeParse(m.id).success && SafeMode.safeParse(m.name).success).map((m) => ({ id: m.id, label: m.name })),
        models: modelValues(model).map((m) => ({ id: m.value, label: m.name })), commands, images: canImage } });
    };
    const setMode = async (mode: string) => {
      SafeMode.parse(mode);
      if (!session.modes?.availableModes.some((m) => m.id === mode && SafeMode.safeParse(m.name).success)) throw new Error(`agent does not offer mode ${mode}`);
      await ctx.request(methods.agent.session.setMode, { sessionId: session.sessionId, modeId: mode });
      currentMode = mode;
      reportSession();
    };
    const setModel = async (model: string) => {
      const option = modelOption();
      if (!option || !modelValues(option).some((m) => m.value === model)) throw new Error(`agent does not offer model ${model}`);
      const result = await ctx.request(methods.agent.session.setConfigOption, { sessionId: session.sessionId, configId: option.id, value: model });
      configOptions = result.configOptions;
      reportSession();
    };
    // Do not inherit an agent's saved bypass mode, and never select an auto-approval mode.
    const initialMode = opts.mode === "plan" ? "plan" : opts.mode && !["ask", "edits"].includes(opts.mode) ? opts.mode :
      session.modes?.availableModes.find((m) => ["default", "read-only", "ask", "on-request", "approve", "manual"].includes(m.id))?.id;
    if (initialMode) await setMode(initialMode);
    else if (currentMode) SafeMode.parse(currentMode);
    if (opts.model) await setModel(opts.model);
    reportSession();
    type Queued = { text: string; commandId?: string; files?: string[]; images?: { mimeType: string; path: string }[] };
    const prompts: Queued[] = opts.task ? [{ text: opts.task }] : [];
    // @ file arrives as ACP resource links, which every agent must accept; pictures only when the agent said it takes them.
    const blocks = async (q: Queued): Promise<ContentBlock[]> => [{ type: "text", text: q.text },
      ...(q.files ?? []).map((f) => ({ type: "resource_link" as const, uri: pathToFileURL(resolve(opts.cwd, f)).href, name: basename(f) })),
      ...(canImage ? await Promise.all((q.images ?? []).map(async (i) => ({ type: "image" as const, mimeType: i.mimeType, data: (await readFile(i.path)).toString("base64") }))) : [])];
    let running = false;
    let stopped = false;
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
          try {
            const done = session.prompt(await blocks(queued));
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
            }
            const result = await done;
            promptUsage = result.usage;
            coalescer.flush();
            emit({ type: "agent.turn", payload: { active: false, stopReason: result.stopReason, commandId } });
          } catch (err) {
            if (!stopped) emit({ type: "agent.error", payload: { message: err instanceof Error ? err.message : String(err) } });
          } finally {
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
          } else prompts.push({ text: command.text, commandId, files: command.files, images: command.images });
          void drain();
        } else if (command.kind === "cancel") {
          await ctx.notify(methods.agent.session.cancel, { sessionId: session.sessionId });
        } else if (command.kind === "mode") await setMode(command.mode);
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
