#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { AgentSpec, LaneId, SafeMode } from "@contextlanes/protocol";
import { resolveAgent } from "./agents.js";
import { runLaneHost } from "./host.js";

const { values } = parseArgs({ options: {
  lane: { type: "string" }, agent: { type: "string", default: "claude-code" }, task: { type: "string" }, "task-file": { type: "string" }, socket: { type: "string" },
  mode: { type: "string", default: "ask" }, model: { type: "string" }, effort: { type: "string" }, "agent-spec": { type: "string" }, toolbox: { type: "string" },
} });
// A long task (a whole plan) comes as a file: no argument length limit, no escaping, not in `ps`.
const task = values["task-file"] ? readFileSync(values["task-file"], "utf8") : values.task;
if (!values.lane || !task || !values.socket) {
  console.error("usage: contextlanes-lanehost --lane <project/NN> (--task <text> | --task-file <path>) --socket <path> [--agent claude-code]");
  process.exit(2);
}
const stop = new AbortController();
process.once("SIGTERM", () => stop.abort());
process.once("SIGINT", () => stop.abort());
const token = process.env.CONTEXTLANES_LANE_TOKEN;
if (!token) {
  console.error("CONTEXTLANES_LANE_TOKEN is not set; the daemon sets it when it starts a lane.");
  process.exit(2);
}
const toolbox = values.toolbox ? JSON.parse(values.toolbox) : null;
toolbox?.env.push({ name: "CONTEXTLANES_LANE_TOKEN", value: token });
// MCP schema is validated by the ACP SDK when session/new is sent.
runLaneHost({ lane: LaneId.parse(values.lane), task, socketPath: values.socket, token, cwd: process.cwd(),
  agent: values["agent-spec"] ? AgentSpec.parse(JSON.parse(values["agent-spec"])) : resolveAgent(values.agent!), agentId: values.agent,
  mode: SafeMode.parse(values.mode), model: values.model, effort: values.effort, mcpServers: toolbox ? [toolbox] : [], signal: stop.signal,
}).catch((err) => { console.error(err); process.exitCode = 1; });
