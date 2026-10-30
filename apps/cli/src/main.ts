#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { parseArgs } from "node:util";
import type { Health, InboxItem, SetupStatus, Lane, Project } from "@contextlanes/protocol";
import { api, daemonUrl } from "./client.js";
import { formatInbox, formatLanes } from "./format.js";

const HELP = `contextlanes — run coding agents in parallel lanes

  contextlanes status                         is the daemon up
  contextlanes lanes [project]                every lane, its state and what it waits on
  contextlanes lane start <project> "<task>"  start a lane  [--agent claude-code|codex|opencode] [--model m]
  contextlanes term <lane>                    your persistent shell in the lane's worktree (tmux)
  contextlanes inbox                          what is waiting on you
  contextlanes answer <id> <option>           answer a permission or question
  contextlanes arch [module]                  the architecture view as text  (phase 3)
  contextlanes setup                          open setup and show the claim code

Lanes are written project/NN, e.g. shuttleworks/01. Talks to ${daemonUrl()}.`;

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { agent: { type: "string" }, model: { type: "string" }, help: { type: "boolean", short: "h" } },
  });
  const [cmd, ...rest] = positionals;

  switch (cmd) {
    case undefined:
    case "help":
      console.log(HELP);
      return 0;
    case "status": {
      const h = await api<Health>("/api/health");
      console.log(`ContextLanes ${h.version} on ${h.host}`);
      return 0;
    }
    case "lanes": {
      const projects = rest[0] ? [rest[0]] : (await api<Project[]>("/api/projects")).map((p) => p.id);
      const lanes = (await Promise.all(projects.map((p) => api<Lane[]>(`/api/projects/${p}/lanes`)))).flat();
      console.log(formatLanes(lanes));
      return 0;
    }
    case "lane": {
      if (rest[0] !== "start" || !rest[1] || !rest[2]) return usage();
      const lane = await api<Lane>("/api/lanes", { method: "POST", body: { project: rest[1], task: rest[2], agent: values.agent, model: values.model } });
      console.log(`Started ${lane.id} on ${lane.branch} (${lane.state}). Shell: contextlanes term ${lane.id}`);
      return 0;
    }
    case "term": {
      if (!rest[0]) return usage();
      const [project, n] = rest[0].split("/");
      const lanes = await api<Lane[]>(`/api/projects/${project}/lanes`);
      const lane = lanes.find((l) => l.id === `${project}/${n}`);
      if (!lane) throw new Error(`no lane ${rest[0]}`);
      return spawnSync("tmux", ["attach-session", "-t", lane.terminal], { stdio: "inherit" }).status ?? 1;
    }
    case "inbox":
      console.log(formatInbox(await api<InboxItem[]>("/api/inbox")));
      return 0;
    case "answer": {
      const [id, optionId] = rest;
      if (!id || !optionId) return usage();
      const [lane, requestId] = id.split("#");
      await api("/api/answers", { method: "POST", body: { lane, requestId, optionId, via: "cli" } });
      console.log("Answered.");
      return 0;
    }
    case "arch":
      console.log("The architecture view arrives with the code map in phase 3 (docs/IMPLEMENTATION.md).");
      return 0;
    case "setup": {
      const status = await api<SetupStatus>("/api/setup/status");
      const url = new URL(daemonUrl());
      if (["127.0.0.1", "localhost"].includes(url.hostname)) url.hostname = "localhost";
      console.log(`Open ${status.publicUrl ?? url.origin}/setup`);
      if (!status.claimed && status.claimFile && ["127.0.0.1", "localhost"].includes(new URL(daemonUrl()).hostname)) console.log(`Claim code: ${(await readFile(status.claimFile, "utf8")).trim()}`);
      return 0;
    }
    default:
      return usage();
  }
}

function usage(): number {
  console.error(HELP);
  return 2;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(`contextlanes: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  },
);
