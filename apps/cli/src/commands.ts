#!/usr/bin/env node
import { setupOutput, addProject } from "./setup.js";
import { spawn, spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { benchTable, type BenchResult, type Health, type InboxItem, type Lane, type Project, type ProjectBranches, type ProjectMap } from "@contextlanes/protocol";
import { readFile } from "node:fs/promises";
import { api, daemonUrl, ClientError, UsageError } from "./client.js";
import { laneCommand } from "./lane.js";
import { formatArch, formatInbox, formatLanes, formatMermaid } from "./format.js";
import { bold, cyan, dim, fail, ok } from "./term.js";
import { startCliLane } from "./wrapper.js";

const HELP = () => `${bold("contextlanes")} ${dim("— run coding agents in parallel lanes on an always-on machine")}

${bold("Get started")}
  contextlanes setup                          sign in from a browser: prints a one-time link and QR code
  contextlanes add [path]                     add a repository (default: this folder)

${bold("Lanes")}
  contextlanes lanes [project] [--json]       every lane, its state and what it waits on
  contextlanes status <lane> [--json]         lane state, plan and judge verdict
  contextlanes send <lane> "<text>"           queue a message for its agent
  contextlanes claude [args…]                 start Claude Code in a lane and attach [--here: current checkout]
  contextlanes codex [args…]                  start Codex in a lane and attach [--here: current checkout]
  contextlanes lane start <project> "<task>"  start a lane  ${dim("[--agent id] [--model m] [--base branch]")}
                                              ${dim("--no-agent: just the checkout, terminal and app; --here: in the current checkout (project .)")}
  contextlanes term <lane>                    your shell in the lane's checkout (tmux; detach with Ctrl-b d)
  contextlanes inbox                          questions and permissions waiting on you
  contextlanes answer <id> <option>           answer one, using the id and option from inbox

${bold("A lane's app")} ${dim("— inside a lane the lane is implied; elsewhere name it")}
  contextlanes env [lane]                     services, state, port and link
  contextlanes env start [lane] [service…]    start from the approved recipe; waits until healthy or failed
  contextlanes env restart [lane] [service…]  restart all, or only the services named
  contextlanes env stop [lane]
  contextlanes logs <service> [lane] [-n 100] recent log lines
  contextlanes url [service] [lane]           the service's link and nothing else (default: web)
  contextlanes recipe [project]               the recipe, its hash and whether it is approved
  contextlanes recipe approve [project]       approve the recipe in the main checkout (owner only)
  contextlanes lane rm <lane>                 stop and delete a lane  ${dim("[--force: with uncommitted changes] [--delete-branch]")}
  contextlanes agent-notes                    what to put in AGENTS.md so agents use this

${bold("Projects")}
  contextlanes arch [project]                 areas, modules and where lanes work  ${dim("[--json] [--mermaid]")}
  contextlanes bench <tasks.json>             compare CLI tokens with and without enhancers

${bold("This machine")}
  contextlanes status                         is ContextLanes running, and where to open it
  contextlanes daemon                         run ContextLanes in the foreground (no systemd needed; Ctrl-C stops it)
  contextlanes update                         install the newest version and restart; lanes keep running
                                              ${dim("[--check] only list what's new   [--rollback] go back one version")}

Lanes are written project/NN, e.g. shuttleworks/01. Talks to ${daemonUrl()}.
Every command takes --json. Exit codes: 0 done, 1 failed, 2 wrong usage, 3 not reachable, 4 waiting on the owner.`;

async function main(argv: string[]): Promise<number> {
  if (argv[0] === "claude" || argv[0] === "codex") {
    const lane = await startCliLane(argv[0], argv.slice(1));
    return spawnSync("tmux", ["attach-session", "-t", `=${lane.terminal}`], { stdio: "inherit" }).status ?? 1;
  }
  // In the foreground, for any init system or none; logs go to this terminal. Ctrl-C stops it.
  if (argv[0] === "daemon") {
    const release = fileURLToPath(new URL("../../../", import.meta.url));
    const child = spawn(process.execPath, [join(release, "apps/daemon/dist/main.js")], { stdio: "inherit" });
    for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => child.kill(signal));
    return new Promise<number>((resolve) => child.on("exit", (code, signal) => resolve(code ?? (signal ? 1 : 0))));
  }
  // The updater ships with the daemon; run the copy from the release this command belongs to.
  if (argv[0] === "update") {
    const release = fileURLToPath(new URL("../../../", import.meta.url));
    return spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", join(release, "apps/daemon/dist/update-main.js"), ...argv.slice(1)], { stdio: "inherit" }).status ?? 1;
  }
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { agent: { type: "string" }, model: { type: "string" }, base: { type: "string" }, json: { type: "boolean" }, mermaid: { type: "boolean" }, help: { type: "boolean", short: "h" },
      lines: { type: "string", short: "n" }, wait: { type: "boolean" }, force: { type: "boolean" }, "delete-branch": { type: "boolean" }, "no-agent": { type: "boolean" }, here: { type: "boolean" } },
  });
  const [cmd, ...rest] = positionals;
  const handled = await laneCommand(cmd, [...rest], values, { api, env: process.env, cwd: process.cwd(), out: (t) => console.log(t), err: (t) => console.error(t) });
  if (handled !== null) return handled;

  switch (cmd) {
    case undefined:
    case "help":
      console.log(HELP());
      return 0;
    case "status": {
      if (rest[0]) {
        const view = await api<{ lane: Lane; plan: { text: string; status: string }[]; verdict: string | null }>(`/api/lanes/${rest[0]}/status`);
        console.log(values.json ? JSON.stringify(view, null, 2) : `${formatLanes([view.lane])}\n${view.plan.filter(p => p.status === "completed").length}/${view.plan.length} plan steps complete${view.verdict ? ` · judge: ${view.verdict}` : ""}`);
        return 0;
      }
      const h = await api<Health>("/api/health").catch(() => null);
      if (!h) { console.error(fail(`ContextLanes is not answering at ${daemonUrl()}.`)); console.error(dim("  Start it: systemctl --user start contextlanes   Logs: journalctl --user -u contextlanes -n 50")); return 3; }
      if (values.json) { console.log(JSON.stringify(h, null, 2)); return 0; }
      console.log(ok(`ContextLanes ${bold(h.version)} is running on ${h.host}`));
      if (h.sandbox === "off") console.log(fail("The sandbox is off: agents run with your full access. Set [sandbox] mode = \"bwrap\" where bubblewrap works."));
      console.log(`  Open ${cyan(daemonUrl())} on this machine, or the HTTPS address contextlanes setup printed.`);
      return 0;
    }
    case "lanes": {
      const projects = rest[0] ? [rest[0]] : (await api<Project[]>("/api/projects")).map((p) => p.id);
      const lanes = (await Promise.all(projects.map((p) => api<Lane[]>(`/api/projects/${p}/lanes`)))).flat();
      console.log(values.json ? JSON.stringify(lanes, null, 2) : formatLanes(lanes));
      return 0;
    }
    case "lane": {
      if (rest[0] !== "start" || !rest[1] || !rest[2]) return usage();
      if (values["no-agent"] && (values.agent || values.model)) throw new UsageError("--no-agent starts a lane without an agent; leave out --agent and --model.");
      const project = rest[1] === "." ? (await addProject()).id : rest[1];
      const base = values.here ? undefined : values.base ?? (await api<ProjectBranches>(`/api/projects/${project}/branches`)).defaultBranch ?? undefined;
      const kind = values["no-agent"] ? "shell" : undefined;
      const lane = await api<Lane>("/api/lanes", { method: "POST", body: { project, task: rest[2], ...(kind ? { kind } : { agent: values.agent, model: values.model }), direct: !!values.here, ...(base ? { base } : {}) } });
      if (values.json) { console.log(JSON.stringify(lane, null, 2)); return lane.state === "failed" ? 1 : 0; }
      console.log(ok(`Started ${bold(lane.id)} on ${lane.branch}`));
      console.log(dim(`  Watch it in the browser, or open its shell: contextlanes term ${lane.id}`));
      return lane.state === "failed" ? 1 : 0;
    }
    case "send": {
      if (!rest[0] || !rest[1]) return usage();
      await api(`/api/lanes/${rest[0]}/prompt`, { method: "POST", body: { text: rest.slice(1).join(" ") } });
      console.log(values.json ? JSON.stringify({ queued: true, lane: rest[0] }) : "Message queued.");
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
    case "inbox": {
      const items = await api<InboxItem[]>("/api/inbox");
      console.log(values.json ? JSON.stringify(items, null, 2) : formatInbox(items));
      return 0;
    }
    case "answer": {
      const [id, optionId] = rest;
      if (!id || !optionId) return usage();
      const [lane, requestId] = id.split("#");
      await api("/api/answers", { method: "POST", body: { lane, requestId, optionId, via: "cli" } });
      console.log(values.json ? JSON.stringify({ answered: true, lane, requestId, optionId }) : ok("Answered. The agent continues."));
      return 0;
    }
    case "setup":
      console.log(await setupOutput());
      return 0;
    case "add": {
      const project = await addProject(rest[0]);
      if (values.json) { console.log(JSON.stringify(project, null, 2)); return 0; }
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
        const line = run.tasks.flatMap((t) => t.runs.map((r) => `${r.lane ?? "not started"} ${r.state}`)).join(" · ");
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

/** Errors go to stderr: a sentence, or with --json one JSON object, so stdout only ever holds the answer. */
function report(err: unknown, json: boolean): number {
  const known = err instanceof ClientError ? err
    : err instanceof TypeError && (err as { code?: string }).code?.startsWith("ERR_PARSE_ARGS") ? new UsageError(err.message)
    : null;
  const message = known?.message ?? "This command could not finish. Check the daemon logs: journalctl --user -u contextlanes -n 50";
  if (json) console.error(JSON.stringify({ error: message, code: known?.code ?? "failed" }));
  else console.error(fail(message));
  return known?.exit ?? 1;
}

const argv = process.argv.slice(2);
main(argv).then(
  (code) => process.exit(code),
  (err: unknown) => process.exit(report(err, argv.includes("--json"))),
);
