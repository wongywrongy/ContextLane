#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { createToolbox } from "./server.js";

const lane = process.env.CONTEXTLANES_LANE;
if (!lane) {
  console.error("CONTEXTLANES_LANE is not set; the lane host passes it to the agent.");
  process.exit(2);
}
const server = createToolbox({ daemonUrl: process.env.CONTEXTLANES_URL ?? "http://127.0.0.1:4600", lane });
await server.connect(new StdioServerTransport());
