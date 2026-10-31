import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { client, methods, ndJsonStream, PROTOCOL_VERSION, type ClientApp, type ClientConnection } from "@agentclientprotocol/sdk/unstable";
import type { AgentProbe } from "@contextlanes/protocol";
import type { AgentSpec } from "./agents.js";

export type { AgentProbe };

type Probe = { agent: AgentSpec; cwd?: string; timeoutMs?: number; connect?: (app: ClientApp) => ClientConnection };

/**
 * Starts the agent, introduces ContextLanes, and opens a session in an empty folder. No prompt is sent, so
 * nothing is spent. ACP's auth_required error (-32000), or an error that says to log in, means "sign in".
 */
export async function probeAgent({ agent, cwd, timeoutMs = 25_000, connect }: Probe): Promise<AgentProbe> {
  const empty: AgentProbe = { state: "broken", name: null, version: null, protocolVersion: null, auth: [], capabilities: { images: false, loadSession: false, additionalDirectories: false, mcpHttp: false }, modes: [], options: [], error: null };
  const dir = cwd ?? mkdtempSync(join(tmpdir(), "cl-probe-"));
  const app = client({ name: "contextlanes" }).onRequest(methods.client.session.requestPermission, async () => ({ outcome: { outcome: "cancelled" } }));
  let child: ReturnType<typeof spawn> | undefined;
  let stderr = "";
  let connection: ClientConnection | undefined;
  const result: AgentProbe = { ...empty };
  const work = (async () => {
    connection = connect ? connect(app) : (() => {
      child = spawn(agent.command, agent.args, { cwd: dir, env: { ...process.env, ...agent.env }, stdio: ["pipe", "pipe", "pipe"] });
      child.stderr!.on("data", (d) => { if (stderr.length < 4000) stderr += String(d); });
      child.on("error", (err: NodeJS.ErrnoException) => { result.error = err.code === "ENOENT" ? `${agent.command} is not installed` : err.message; connection?.close(); });
      return app.connect(ndJsonStream(Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>, Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>));
    })();
    const ctx = connection.agent;
    const init = await ctx.request(methods.agent.initialize, { protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: { name: "contextlanes", version: "0.1.0" } });
    const caps = init.agentCapabilities;
    result.name = init.agentInfo?.title ?? init.agentInfo?.name ?? null;
    result.version = init.agentInfo?.version ?? null;
    result.protocolVersion = init.protocolVersion;
    result.capabilities = { images: !!caps?.promptCapabilities?.image, loadSession: !!caps?.loadSession, additionalDirectories: !!caps?.sessionCapabilities?.additionalDirectories, mcpHttp: !!caps?.mcpCapabilities?.http };
    result.auth = (init.authMethods ?? []).map((m) => {
      const meta = (m as { _meta?: Record<string, unknown> })._meta?.["terminal-auth"] as { command?: string; args?: string[] } | undefined;
      const terminal = m as { type?: string; command?: string; args?: string[] };
      const command = terminal.type === "terminal" ? terminal.command : meta?.command;
      const args = terminal.type === "terminal" ? terminal.args : meta?.args;
      return { id: m.id, name: m.name, ...(command ? { command, args: args ?? [] } : {}) };
    });
    try {
      const session = await ctx.request(methods.agent.session.new, { cwd: dir, mcpServers: [] });
      result.state = "ready";
      result.modes = (session.modes?.availableModes ?? []).map((m) => ({ id: m.id, name: m.name, description: m.description ?? null }));
      result.options = (session.configOptions ?? []).flatMap((o) => o.type === "select"
        ? [{ id: o.id, name: o.name, category: o.category ?? null, values: o.options.flatMap((v) => "options" in v ? v.options.map((x) => x.value) : [v.value]) }] : []);
    } catch (err) {
      const e = err as { code?: number; message?: string; data?: unknown };
      const text = `${e.message ?? String(err)} ${typeof e.data === "string" ? e.data : e.data ? JSON.stringify(e.data) : ""}`.trim();
      result.state = e.code === -32000 || /auth|log ?in|sign ?in|credential|api key|unauthori[sz]ed|not logged/i.test(text) ? "signin" : "broken";
      result.error = text.slice(0, 500);
    }
  })();
  const timer = new Promise<void>((resolve) => setTimeout(() => { result.error ??= `no answer within ${Math.round(timeoutMs / 1000)} seconds`; resolve(); }, timeoutMs).unref());
  try { await Promise.race([work.catch((err: Error) => { result.error ??= err.message; }), timer]); }
  finally {
    connection?.close();
    child?.kill("SIGTERM");
    if (!cwd) rmSync(dir, { recursive: true, force: true });
  }
  if (result.state === "broken" && !result.error && stderr) result.error = stderr.trim().split("\n").slice(-3).join(" ").slice(0, 500);
  if (result.state === "broken" && result.error && /auth|log ?in|sign ?in|credential|api key|unauthori[sz]ed/i.test(result.error)) result.state = "signin";
  return result;
}
