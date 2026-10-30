import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createConnection } from "node:net";
import { createInterface } from "node:readline";
import { Readable, Writable } from "node:stream";
import { client, methods, ndJsonStream, PROTOCOL_VERSION, type McpServer } from "@agentclientprotocol/sdk";
import type { NewLaneEvent } from "@contextlanes/protocol";
import type { AgentSpec } from "./agents.js";
import { Coalescer, mapPermission } from "./map.js";

export type LaneHostOptions = {
  lane: string;
  cwd: string;
  task: string;
  agent: AgentSpec;
  /** Unix socket of the daemon (HostLinks). */
  socketPath: string;
  /** The ContextLanes toolbox, handed to the agent so it can use the lane instead of guessing. */
  mcpServers?: McpServer[];
};

/**
 * Holds one agent session for one lane. Runs as its own systemd unit, so restarting or upgrading
 * the daemon never stops the agent; it reconnects to the socket and carries on.
 */
export async function runLaneHost(opts: LaneHostOptions): Promise<void> {
  const daemon = createConnection(opts.socketPath);
  const send = (msg: object) => daemon.write(`${JSON.stringify(msg)}\n`);
  send({ hello: opts.lane });
  const emit = (e: NewLaneEvent) => send(e);

  const answers = new Map<string, (optionId: string | null) => void>();
  const prompts: string[] = [];
  let wake: (() => void) | null = null;
  createInterface({ input: daemon }).on("line", (line) => {
    const msg = JSON.parse(line) as { prompt?: string; answer?: { requestId: string; optionId: string | null } };
    if (msg.answer) answers.get(msg.answer.requestId)?.(msg.answer.optionId);
    if (msg.prompt) {
      prompts.push(msg.prompt);
      wake?.();
    }
  });

  const child = spawn(opts.agent.command, opts.agent.args, { cwd: opts.cwd, env: { ...process.env, ...opts.agent.env, CONTEXTLANES_LANE: opts.lane }, stdio: ["pipe", "pipe", "inherit"] });
  const stream = ndJsonStream(Writable.toWeb(child.stdin) as WritableStream<Uint8Array>, Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>);

  const app = client({ name: "contextlanes" }).onRequest(methods.client.session.requestPermission, async ({ params }) => {
    const requestId = randomUUID();
    emit(mapPermission(requestId, params));
    // Nothing is allowed on a timer: the request waits until you answer.
    const optionId = await new Promise<string | null>((resolve) => answers.set(requestId, resolve));
    answers.delete(requestId);
    return optionId ? { outcome: { outcome: "selected", optionId } } : { outcome: { outcome: "cancelled" } };
  });

  await app.connectWith(stream, async (ctx) => {
    await ctx.request(methods.agent.initialize, {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: "contextlanes", version: "0.1.0" },
    });
    let builder = ctx.buildSession(opts.cwd);
    for (const server of opts.mcpServers ?? []) builder = builder.withMcpServer(server);
    const session = await builder.start();
    const coalescer = new Coalescer(emit);

    const turn = async (text: string) => {
      const done = session.prompt(text);
      for (;;) {
        const m = await session.nextUpdate();
        if (m.kind === "stop") break;
        coalescer.push(m.update);
      }
      coalescer.flush();
      await done;
    };

    await turn(opts.task);
    for (;;) {
      const next = prompts.shift();
      if (next) {
        await turn(next);
        continue;
      }
      await new Promise<void>((resolve) => (wake = resolve));
      wake = null;
    }
  });
}
