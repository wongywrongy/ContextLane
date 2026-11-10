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
  env_stop: {
    phase: 2,
    description: "Stop this lane's services.",
    input: z.object({}),
  },
  env_restart: {
    phase: 2,
    description: "Restart this lane's services, or only the ones named, and wait until they are healthy.",
    input: z.object({ services: z.array(z.string()).optional() }),
  },
  recipe_status: {
    phase: 2,
    description: "This lane's recipe (.contextlanes.json): its services, its hash and whether the owner has approved it. Services start only from an approved recipe.",
    input: z.object({}),
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
    description: "A module's brief and facts (what it is for, its exports, what uses it, its tests) from the code map, instead of reading every file. Give a module name from the Architecture page or any file path inside it.",
    input: z.object({ module: z.string().optional(), path: z.string().optional() }),
  },
  delegate: {
    phase: 3,
    description: "Hand bounded work to a local model on this machine, to save your context: read (name the files and the question; get back the lines that matter), check (run the recipe's checks; get back the failures, sorted), edit (name the files and an exact change; get back a patch to review and apply yourself).",
    input: z.object({ kind: z.enum(["read", "edit", "check"]), task: z.string(), files: z.array(z.string()).default([]) }),
  },
  split_lanes: {
    phase: 4,
    description: "Run independent parts of your task in parallel: each sub-lane gets its own agent and checkout, branched from your current commit, and its work merges back into your branch once the owner approves it. Use it when the rest of the task has 2 to 5 parts that touch different files (say, the API and the UI, or separate pages). Commit first. The owner agrees once for all of them; you get the new lanes back. Keep working on your own part, and leave their files alone.",
    input: z.object({ why: z.string().min(1).max(1000), lanes: z.array(z.object({ title: z.string().min(3).max(100), task: z.string().min(10).max(8000).describe("Everything the sub-lane needs: what to change, which files are its own, and how to test it") })).min(2).max(5) }),
  },
  sublane_status: {
    phase: 4,
    description: "Where your sub-lanes are: working, waiting for the owner, in review (with the review judge's verdict), or merged into your branch.",
    input: z.object({}),
  },
  lanes_list: {
    phase: 4, description: "List this project's lanes, their agents, states and latest checkpoints.", input: z.object({}),
  },
  lane_status: {
    phase: 4, description: "Read a project lane's state, plan progress and latest judge verdict.", input: z.object({ lane: z.string().min(1) }),
  },
  lane_start: {
    phase: 4, description: "Propose one child lane. The owner must approve its task, agent and base before it starts. Children cannot spawn lanes. Use split_lanes for one approval covering two or more children.",
    input: z.object({ task: z.string().min(1).max(8000), agent: z.string().optional(), base: z.string().optional() }),
  },
  lane_send: {
    phase: 4, description: "Send a message to one of your own child lanes, through its normal input queue.", input: z.object({ lane: z.string().min(1), text: z.string().min(1).max(100_000) }),
  },
} as const;

export type ToolName = keyof typeof TOOLS;
export const TOOL_NAMES = Object.keys(TOOLS) as ToolName[];

/**
 * Tools agents are given today. A tool joins this list only when its daemon route works; until
 * then agents never see it, so they do not spend tokens on a tool that answers "not available yet".
 */
export const LIVE_TOOLS: ToolName[] = ["ask_owner", "env_status", "env_start", "env_stop", "env_restart", "recipe_status", "get_logs", "preview_url", "checkpoint", "get_brief", "split_lanes", "sublane_status", "lanes_list", "lane_status", "lane_start", "lane_send"];
