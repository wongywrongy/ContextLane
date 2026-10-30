import { McpServer } from "@modelcontextprotocol/server";
import { TOOLS, TOOL_NAMES, type ToolName } from "./tools.js";

export type ToolboxOptions = { daemonUrl: string; lane: string; fetch?: typeof fetch };

/** Builds the MCP server. Each tool posts to /api/lanes/:lane/tools/:name on the daemon. */
export function createToolbox(opts: ToolboxOptions): McpServer {
  const server = new McpServer({ name: "contextlanes", version: "0.1.0" });
  const doFetch = opts.fetch ?? fetch;
  const [project, n] = opts.lane.split("/");

  for (const name of TOOL_NAMES) {
    const tool = TOOLS[name as ToolName];
    server.registerTool(name, { description: tool.description, inputSchema: tool.input }, async (args: Record<string, unknown>) => {
      const res = await doFetch(`${opts.daemonUrl}/api/lanes/${project}/${n}/tools/${name}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(args ?? {}),
      });
      const text = await res.text();
      return { content: [{ type: "text" as const, text }], isError: !res.ok };
    });
  }
  return server;
}
