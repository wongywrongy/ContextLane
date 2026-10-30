#!/usr/bin/env node
import { setupOutput, addProject } from "./setup.js";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { benchTable, type BenchResult, type Health, type InboxItem, type Lane, type Project, type ProjectBranches, type ProjectMap } from "@contextlanes/protocol";
import { readFile } from "node:fs/promises";
import { api, daemonUrl, ClientError } from "./client.js";
import { formatArch, formatInbox, formatLanes, formatMermaid } from "./format.js";
import { bold, cyan, dim, fail, ok } from "./term.js";

const HELP = () => `${bold("contextlanes")} ${dim("— run coding agents in parallel lanes on an always-on machine")}

${bold("Get started")}
  contextlanes setup                          sign in from a browser: prints a one-time link and QR code
  contextlanes add [path]                     add a repository (default: this folder)

${bold("Lanes")}
  contextlanes lanes [project]                every lane, its state and what it waits on
  contextlanes lane start <project> "<task>"  start a lane  ${dim("[--agent claude-code|codex|opencode] [--model m] [--base branch]")}
  contextlanes term <lane>                    your shell in the lane's checkout (tmux; detach with Ctrl-b d)
  contextlanes inbox                          questions and permissions waiting on you
  contextlanes answer <id> <option>           answer one, using the id and option from inbox

${bold("Projects")}
  contextlanes arch [project]                 areas, modules and where lanes work  ${dim("[--json] [--mermaid]")}
  contextlanes bench <tasks.json>             measure tokens with and without local models

${bold("This machine")}
  contextlanes status                         is ContextLanes running, and where to open it
  contextlanes update                         install the newest version and restart; lanes keep running
                                              ${dim("[--check] only list what's new   [--rollback] go back one version")}

Lanes are written project/NN, e.g. shuttleworks/01. Talks to ${daemonUrl()}.`;

async function main(argv: string[]): Promise<number> {
  // The updater ships with the daemon; run the copy from the release this command belongs to.
  if (argv[0] === "update") {
    const release = fileURLToPath(new URL("../../../", import.meta.url));
    return spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", join(release, "apps/daemon/dist/update-main.js"), ...argv.slice(1)], { stdio: "inherit" }).status ?? 1;
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
      console.log(HELP());
      return 0;
    case "status": {
      const h = await api<Health>("/api/health").catch(() => null);
      if (!h) { console.error(fail(`ContextLanes is not answering at ${daemonUrl()}.`)); console.error(dim("  Start it: systemctl --user start contextlanes   Logs: journalctl --user -u contextlanes -n 50")); return 1; }
      console.log(ok(`ContextLanes ${bold(h.version)} is running on ${h.host}`));
      console.log(`  Open ${cyan(daemonUrl())} on this machine, or the HTTPS address contextlanes setup printed.`);
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
      console.log(ok(`Started ${bold(lane.id)} on ${lane.branch}`));
      console.log(dim(`  Watch it in the browser, or open its shell: contextlanes term ${lane.id}`));
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
      console.log(ok("Answered. The agent continues."));
      return 0;
    }
    case "setup":
      console.log(await setupOutput());
      return 0;
    case "add": {
      const project = await addProject(rest[0]);
      console.log(ok(`Added ${bold(project.name)}. Start a lane from the browser, or: contextlanes lane start ${project.id} "<task>"`));
      return 0;
    }
    case "schedule": {
      // Run by the systemd timers that Settings → Scheduled lanes writes.
      if (rest[0] !== "run" || !rest[1]) return usage();
      const lane = await api<Lane>(`/api/schedules/${rest[1]}/run`, { method: "POST", body: {} });
      console.log(`Started ${lane.id} for schedule ${rest[1]}.`);
      return 0;
    }
    case "bench": {
      if (!rest[0]) return usage();
      const tasks = JSON.parse(await readFile(rest[0], "utf8")) as unknown;
      let run = await api<BenchResult>("/api/bench", { method: "POST", body: { tasks } });
      console.log(`Bench ${run.id} started: ${run.tasks.length} ${run.tasks.length === 1 ? "task" : "tasks"}, two lanes each. Answer their questions in the Inbox as usual.`);
      let last = "";
      while (!run.finishedAt) {
        await new Promise((r) => setTimeout(r, 15_000));
        run = await api<BenchResult>(`/api/bench/${run.id}`);
        const line = run.tasks.flatMap((t) => t.runs.map((r) => `${r.lane} ${r.state}`)).join(" · ");
        if (line !== last) { console.log(line); last = line; }
      }
      console.log(`\n${benchTable(run)}`);
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
      console.error(fail(`Unknown command: ${cmd}\n`));
      return usage();
  }
}

function usage(): number {
  console.error(HELP());
  return 2;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(fail(err instanceof ClientError ? err.message : "This command could not finish. Check the daemon logs: journalctl --user -u contextlanes -n 50"));
    process.exit(1);
  },
);
