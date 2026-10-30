#!/usr/bin/env node
import { parseArgs } from "node:util";
import { resolveAgent } from "./agents.js";
import { runLaneHost } from "./host.js";

const { values } = parseArgs({
  options: {
    lane: { type: "string" },
    agent: { type: "string", default: "claude-code" },
    task: { type: "string" },
    socket: { type: "string" },
  },
});

if (!values.lane || !values.task || !values.socket) {
  console.error("usage: contextlanes-lanehost --lane <project/NN> --task <text> --socket <path> [--agent claude-code]");
  process.exit(2);
}

runLaneHost({ lane: values.lane, task: values.task, socketPath: values.socket, cwd: process.cwd(), agent: resolveAgent(values.agent!) }).catch((err) => {
  console.error(err);
  process.exit(1);
});
