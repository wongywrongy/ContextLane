#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { createToolbox } from "./server.js";

const lane = process.env.CONTEXTLANES_LANE;
const token = process.env.CONTEXTLANES_LANE_TOKEN;
if (!lane || !token) {
  console.error("CONTEXTLANES_LANE and CONTEXTLANES_LANE_TOKEN are not set; the lane host passes them to the agent.");
  process.exit(2);
}
const server = createToolbox({ daemonUrl: process.env.CONTEXTLANES_URL ?? "http://127.0.0.1:4600", lane, token });
await server.connect(new StdioServerTransport());
