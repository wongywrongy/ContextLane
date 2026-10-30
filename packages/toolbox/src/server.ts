import { McpServer, type ServerContext } from "@modelcontextprotocol/server";
import { randomUUID } from "node:crypto";
import { setTimeout } from "node:timers/promises";
import { LIVE_TOOLS, TOOLS, type ToolName } from "./tools.js";

export type ToolboxOptions = { daemonUrl: string; lane: string; fetch?: typeof fetch; tools?: ToolName[] };

/** Retrying the same question ID survives a daemon restart without asking twice. */
export async function callLaneTool(opts: ToolboxOptions, name: ToolName, args: Record<string, unknown>, signal?: AbortSignal): Promise<{ text: string; ok: boolean }> {
  const body = name === "ask_owner" ? { ...args, requestId: randomUUID() } : args;
  const doFetch = opts.fetch ?? fetch;
  for (;;) {
    signal?.throwIfAborted();
    try {
      const response = await doFetch(`${opts.daemonUrl}/api/lanes/${opts.lane}/tools/${name}`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal,
      });
      if (name !== "ask_owner" || response.status !== 202) return { text: await response.text(), ok: response.ok };
    } catch (err) { if (name !== "ask_owner" || signal?.aborted) throw err; }
    await setTimeout(1000, undefined, { signal });
  }
}

/** Builds the MCP server with the live tools. Each tool posts to /api/lanes/:lane/tools/:name on the daemon. */
export function createToolbox(opts: ToolboxOptions): McpServer {
  const server = new McpServer({ name: "contextlanes", version: "0.1.0" });
  for (const name of opts.tools ?? LIVE_TOOLS) {
    const tool = TOOLS[name as ToolName];
    server.registerTool(name, { description: tool.description, inputSchema: tool.input }, async (args: Record<string, unknown>, context: ServerContext) => {
      const result = await callLaneTool(opts, name, args ?? {}, context.mcpReq.signal);
      return { content: [{ type: "text" as const, text: result.text }], isError: !result.ok };
    });
  }
  return server;
}
