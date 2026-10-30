#!/usr/bin/env node
import { setupOutput, addProject } from "./setup.js";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import type { Health, InboxItem, Lane, Project, ProjectBranches, ProjectMap } from "@contextlanes/protocol";
import { api, daemonUrl, ClientError } from "./client.js";
import { formatArch, formatInbox, formatLanes, formatMermaid } from "./format.js";

const HELP = `contextlanes — run coding agents in parallel lanes

  contextlanes status                         is the daemon up
  contextlanes lanes [project]                every lane, its state and what it waits on
  contextlanes lane start <project> "<task>"  start a lane  [--agent claude-code|codex|opencode] [--model m] [--base branch]
  contextlanes term <lane>                    your persistent shell in the lane's worktree (tmux)
  contextlanes inbox                          what is waiting on you
  contextlanes answer <id> <option>           answer a permission or question
  contextlanes setup                          claim, enable remote access, print sign-in link and QR
  contextlanes add [path]                     add a repository (defaults to the current folder)
  contextlanes arch [project]                 layers, modules and where lanes work  [--json] [--mermaid]
  contextlanes update                         install the newest version and restart; lanes keep running
                                              [--check] only list what's new   [--rollback] go back one version

Lanes are written project/NN, e.g. shuttleworks/01. Talks to ${daemonUrl()}.`;

async function main(argv: string[]): Promise<number> {
  // The updater ships with the daemon; run the copy from the release this command belongs to.
  if (argv[0] === "update") {
    const release = fileURLToPath(new URL("../../../", import.meta.url));
    return spawnSync(process.execPath, [join(release, "apps/daemon/dist/update-main.js"), ...argv.slice(1)], { stdio: "inherit" }).status ?? 1;
  }
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { agent: { type: "string" }, model: { type: "string" }, base: { type: "string" }, json: { type: "boolean" }, mermaid: { type: "boolean" }, help: { type: "boolean", short: "h" } },
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
      const base = values.base ?? (await api<ProjectBranches>(`/api/projects/${rest[1]}/branches`)).defaultBranch ?? undefined;
      const lane = await api<Lane>("/api/lanes", { method: "POST", body: { project: rest[1], task: rest[2], agent: values.agent, model: values.model, base } });
      console.log(`Started ${lane.id} on ${lane.branch} (${lane.state}). Shell: contextlanes term ${lane.id}`);
      return 0;
    }
    case "term": {
      if (!rest[0]) return usage();
      const [project, n] = rest[0].split("/");
      const lanes = await api<Lane[]>(`/api/projects/${project}/lanes`);
      const lane = lanes.find((l) => l.id === `${project}/${n}`);
      if (!lane) throw new Error(`no lane ${rest[0]}`);
      // "=" makes tmux match the exact session, never cl-shop-010 for cl-shop-01.
      return spawnSync("tmux", ["attach-session", "-t", `=${lane.terminal}`], { stdio: "inherit" }).status ?? 1;
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
    case "setup":
      console.log(await setupOutput());
      return 0;
    case "add": {
      const project = await addProject(rest[0]);
      console.log(`Added ${project.name}.`);
      return 0;
    }
    case "arch": {
      const project = rest[0] ?? (await api<Project[]>("/api/projects")).find((p) => process.cwd() === p.path || process.cwd().startsWith(`${p.path}/`))?.id;
      if (!project) { console.error("Name a project, or run this inside one: contextlanes arch <project>"); return 2; }
      const view = await api<ProjectMap>(`/api/projects/${project}/map`);
      console.log(values.json ? JSON.stringify(view, null, 2) : values.mermaid ? formatMermaid(view) : formatArch(view));
      return view.map ? 0 : 1;
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
    console.error(`contextlanes: ${err instanceof ClientError ? err.message : "This command could not finish; check the daemon logs and try again."}`);
    process.exit(1);
  },
);
