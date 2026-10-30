#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { createToolbox } from "./server.js";
import { LIVE_TOOLS, TOOL_NAMES } from "./tools.js";

const lane = process.env.CONTEXTLANES_LANE;
const token = process.env.CONTEXTLANES_LANE_TOKEN;
if (!lane || !token) {
  console.error("CONTEXTLANES_LANE and CONTEXTLANES_LANE_TOKEN are not set; the lane host passes them to the agent.");
  process.exit(2);
}
const daemonUrl = process.env.CONTEXTLANES_URL ?? "http://127.0.0.1:4600";
// Ask the daemon which tools this lane has right now (delegate only while the local helper is on).
const offered = await fetch(`${daemonUrl}/api/lanes/${lane}/tools`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5000) })
  .then(async (r) => r.ok ? ((await r.json()) as { tools: string[] }).tools : null, () => null);
const tools = offered ? TOOL_NAMES.filter((t) => offered.includes(t)) : LIVE_TOOLS;
const server = createToolbox({ daemonUrl, lane, token, tools });
await server.connect(new StdioServerTransport());
