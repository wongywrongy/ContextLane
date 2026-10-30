import { z } from "zod";

/**
 * The toolbox, declared as data so the daemon, docs and tests share one list.
 * Each tool calls the daemon's API for the lane named in CONTEXTLANES_LANE.
 * Phase tags say when a tool starts doing real work (see docs/IMPLEMENTATION.md).
 */
export const TOOLS = {
  env_status: {
    phase: 2,
    description: "Status, ports and private preview links of this lane's running services.",
    input: z.object({}),
  },
  env_start: {
    phase: 2,
    description: "Start this lane's services from the approved recipe.",
    input: z.object({ services: z.array(z.string()).optional() }),
  },
  get_logs: {
    phase: 2,
    description: "Recent log lines for one of this lane's services.",
    input: z.object({ service: z.string(), lines: z.number().int().positive().max(500).default(100) }),
  },
  preview_url: {
    phase: 2,
    description: "The private link for a service in this lane, for your own browser checks.",
    input: z.object({ service: z.string().default("web") }),
  },
  ask_owner: {
    phase: 1,
    description: "Ask the owner a question with buttons. It reaches their inbox and phone; you get the chosen option back.",
    input: z.object({ question: z.string().min(1).max(10_000), options: z.array(z.string().min(1).max(200)).min(2).max(4) }),
  },
  checkpoint: {
    phase: 2,
    description: "Say this lane is ready for review. Commit your work first. Starts the checks and builds the review packet in the background; the owner reviews it.",
    input: z.object({ summary: z.string().trim().min(1).max(2000) }),
  },
  get_brief: {
    phase: 3,
    description: "The short brief for a module (what it holds, rules, entry points) instead of reading every file.",
    input: z.object({ module: z.string() }),
  },
  delegate: {
    phase: 3,
    description: "Hand work to a local model: read (logs, big files -> the lines that matter), edit (a tightly specified change), check (run tests, sort failures).",
    input: z.object({ kind: z.enum(["read", "edit", "check"]), task: z.string(), files: z.array(z.string()).default([]) }),
  },
} as const;

export type ToolName = keyof typeof TOOLS;
export const TOOL_NAMES = Object.keys(TOOLS) as ToolName[];

/**
 * Tools agents are given today. A tool joins this list only when its daemon route works; until
 * then agents never see it, so they do not spend tokens on a tool that answers "not available yet".
 */
export const LIVE_TOOLS: ToolName[] = ["ask_owner", "env_status", "env_start", "get_logs", "preview_url", "checkpoint"];
