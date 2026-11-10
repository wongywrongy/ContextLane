#!/usr/bin/env node
import { setupLink, setupOutput, addProject } from "./setup.js";
import { spawn, spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { benchTable, type DoctorReport, type BenchResult, type Health, type InboxItem, type Lane, type Project, type ProjectBranches, type ProjectMap } from "@contextlanes/protocol";
import { readFile } from "node:fs/promises";
import { api, daemonUrl, ClientError, UsageError } from "./client.js";
import { laneCommand } from "./lane.js";
import { expandShort, unmounted } from "./short.js";
import { canAsk, fillIn, session } from "./interactive.js";
import { formatArch, formatDoctor, formatInbox, formatLanes, formatMermaid, table } from "./format.js";
import { bold, cyan, dim, fail, ok } from "./term.js";
import { startCliLane } from "./wrapper.js";

const HELP = () => `${bold("cl")} ${dim("— run coding agents in parallel lanes on an always-on machine (long name: contextlanes)")}

${dim("A project is a repository folder. A lane is one task inside a project: its own branch, checkout, terminal and app.")}
${dim("In a terminal, cl on its own opens the menus: Projects → a project's lanes → one lane. Esc goes back a step.")}

${bold("Projects")}
  cl add [path]                   make a folder a project (default: this folder)
  cl projects                     every project and how many lanes it has
  cl remove <project>             stop tracking one (the folder is untouched)

${bold("Lanes")} ${dim("— inside a project folder the project is implied, and a lane is just its number")}
  cl new "<task>"                 start a lane in this project, on a new branch  ${dim("[--agent id] [--model m]")}
                                  ${dim("--branch <name>: work on an existing branch instead   --base <name>: start the new branch from it")}
                                  ${dim("--here: in the current checkout, on its branch   --no-agent: just the checkout, terminal and app")}
  cl new <project> "<task>"       start a lane in another project
  cl claude [args…]               start Claude Code in a new lane and attach  ${dim("(or: cl codex)")}
  cl ls [project] [--all]         open lanes, their state and what they wait on (--all: deleted ones too)
  cl status <lane>                one lane: state, plan and verdict
  cl say <lane> "<text>"          queue a message for its agent
  cl sh <lane>                    your shell in the lane's checkout (tmux; detach with Ctrl-b d)
  cl rename <lane> "<task>"       change what a lane is called
  cl auto <lane> on|off           let ContextLanes allow safe requests once for you; dire ones still wait
  cl lane restart <lane>          start the lane's agent again where it left off
  cl rm <lane>                    stop and delete a lane  ${dim("[--force: with uncommitted changes] [--delete-branch]")}

${bold("A lane's app")} ${dim("— inside a lane the lane is implied; elsewhere add its number")}
  cl up [lane] [service…]         start from the approved recipe; waits until healthy or failed
  cl down [lane]                  stop it
  cl restart [lane] [service…]    restart all, or only the services named
  cl ps [lane]                    services, state, port and link
  cl logs <service> [lane] [-n 100]
  cl url [service] [lane]         the service's link and nothing else (default: web)
  cl recipe [lane]                the recipe, its commands, its hash and whether it is approved
  cl recipe approve [lane]        approve it after reading it (owner only); without a lane, the project's own

${bold("Waiting on you")}
  cl inbox                        questions and permissions from every lane
  cl ok <id> <option>             answer one, using the id and option from inbox

${bold("This machine")}
  cl setup                        sign a browser in to the web page, once per browser: a one-time link and QR code
  cl status                       is ContextLanes running, and where to open it
  cl daemon                       run ContextLanes in the foreground (no systemd needed; Ctrl-C stops it)
  cl doctor                       check tools, sandbox, router and your proxy, and say how to fix what fails
  cl update                       install the newest version and restart; lanes keep running  ${dim("[--check] [--rollback]")}
  cl agent-notes                  what to put in AGENTS.md so agents use this
  cl arch [project]               areas, modules and where lanes work  ${dim("[--mermaid]")}

A lane is its number here (2) or project/number anywhere (shop/02). The long forms still work:
lane start, lanes, send, term, lane rm, env start|stop|restart, answer. Talks to ${daemonUrl()}.
Every command takes --json. Exit codes: 0 done, 1 failed, 2 wrong usage, 3 not reachable, 4 waiting on the owner.`;

async function main(argv: string[]): Promise<number> {
  const io = { api, env: process.env, cwd: process.cwd(), out: () => {}, err: () => {} };
  // Short verbs and bare lane numbers become the long commands run() understands.
  argv = await expandShort(argv, io);
  // A person at a terminal gets the menus: cl alone opens them, and a command with something left out
  // asks for it. Agents, scripts and --json never get a question.
  if (canAsk(argv, process.env, { in: !!process.stdin.isTTY, out: !!process.stdout.isTTY }) && !["claude", "codex", "daemon", "update"].includes(argv[0] ?? "")) {
    const { terminal } = await import("./prompts.js");
    // Inside the menus a failed command says why and the menu comes back; it does not end the session.
    const exec = (command: string[]) => run(command).catch((err: unknown) => report(err, false));
    if (!argv.length) return session(io, terminal, exec);
    const asked = await fillIn(argv, io, terminal, exec);
    if (asked !== null) return asked;
  }
  return run(argv);
}

/** One complete command in its long form. */
async function run(argv: string[]): Promise<number> {
  if (argv[0] === "claude" || argv[0] === "codex") {
    const lane = await startCliLane(argv[0], argv.slice(1));
    return openTerminal(lane);
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
    // In Docker the image is the release: it is rebuilt from the stack folder, not swapped in place.
    if (process.env.CONTEXTLANES_DOCKER) {
      const how = "ContextLanes runs in Docker here. Update it from the stack folder: git pull && docker compose up -d --build";
      if (argv.includes("--json")) console.error(JSON.stringify({ error: how, code: "docker" })); else console.error(how);
      return 1;
    }
    const release = fileURLToPath(new URL("../../../", import.meta.url));
    const args = ["--disable-warning=ExperimentalWarning", join(release, "apps/daemon/dist/update-main.js"), ...argv.slice(1).filter((a) => a !== "--json")];
    if (!argv.includes("--json")) return spawnSync(process.execPath, args, { stdio: "inherit" }).status ?? 1;
    // The updater writes for people; with --json its lines are returned in one document.
    const done = spawnSync(process.execPath, args, { encoding: "utf8" });
    const code = done.status ?? 1, lines = (text: string) => plain(text).split("\n").map((l) => l.trim()).filter(Boolean);
    if (code === 0) console.log(JSON.stringify({ ok: true, output: lines(done.stdout) }, null, 2));
    else console.error(JSON.stringify({ error: lines(done.stderr || done.stdout).join(" ") || "The update did not finish.", code: "failed" }));
    return code;
  }
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { agent: { type: "string" }, model: { type: "string" }, base: { type: "string" }, branch: { type: "string" }, json: { type: "boolean" }, all: { type: "boolean" }, mermaid: { type: "boolean" }, help: { type: "boolean", short: "h" },
      lines: { type: "string", short: "n" }, wait: { type: "boolean" }, force: { type: "boolean" }, "delete-branch": { type: "boolean" }, "no-agent": { type: "boolean" }, here: { type: "boolean" } },
  });
  const [cmd, ...rest] = positionals;
  const handled = await laneCommand(cmd, [...rest], values, { api, env: process.env, cwd: process.cwd(), out: (t) => console.log(t), err: (t) => console.error(t) });
  if (handled !== null) return handled;

  switch (cmd) {
    case undefined:
    case "help":
      console.log(values.json ? JSON.stringify({ help: plain(HELP()) }, null, 2) : HELP());
      return 0;
    case "status": {
      if (rest[0]) {
        const view = await api<{ lane: Lane; plan: { text: string; status: string }[]; verdict: string | null }>(`/api/lanes/${rest[0]}/status`);
        console.log(values.json ? JSON.stringify(view, null, 2) : `${formatLanes([view.lane])}\n${view.plan.filter(p => p.status === "completed").length}/${view.plan.length} plan steps complete${view.verdict ? ` · judge: ${view.verdict}` : ""}`);
        return 0;
      }
      // With --json an unreachable daemon is reported like every other error: one JSON object on stderr, exit 3.
      const h = values.json ? await api<Health>("/api/health") : await api<Health>("/api/health").catch(() => null);
      if (!h) { console.error(fail(`ContextLanes is not answering at ${daemonUrl()}.`)); console.error(dim("  Start it: systemctl --user start contextlanes   Logs: journalctl --user -u contextlanes -n 50")); return 3; }
      if (values.json) { console.log(JSON.stringify(h, null, 2)); return 0; }
      console.log(ok(`ContextLanes ${bold(h.version)} is running on ${h.host}`));
      if (h.sandbox === "off") console.log(fail("The sandbox is off: agents run with your full access. Set [sandbox] mode = \"bwrap\" where bubblewrap works."));
      console.log(`  Open ${cyan(daemonUrl())} on this machine, or the HTTPS address cl setup printed.`);
      return 0;
    }
    case "lanes": {
      const projects = rest[0] ? [rest[0]] : (await api<Project[]>("/api/projects")).map((p) => p.id);
      const lanes = (await Promise.all(projects.map((p) => api<Lane[]>(`/api/projects/${p}/lanes`)))).flat();
      // Deleted lanes stay in the history; --all lists them too.
      const shown = values.all ? lanes : lanes.filter((l) => !["cleaned", "archived"].includes(l.state));
      console.log(values.json ? JSON.stringify(shown, null, 2) : shown.length ? formatLanes(shown) : `No open lanes. Start one: cl new "<task>"`);
      return 0;
    }
    case "lane": {
      if (rest[0] !== "start" || !rest[1] || !rest[2]) return usage(values.json);
      if (values["no-agent"] && (values.agent || values.model)) throw new UsageError("--no-agent starts a lane without an agent; leave out --agent and --model.");
      const project = rest[1] === "." ? (await addProject()).id : rest[1];
      if (values.branch && values.here) throw new UsageError("--here works in the current checkout on its branch; leave out --branch.");
      const base = values.here ? undefined : values.base ?? (await api<ProjectBranches>(`/api/projects/${project}/branches`)).defaultBranch ?? undefined;
      const kind = values["no-agent"] ? "shell" : undefined;
      const lane = await api<Lane>("/api/lanes", { method: "POST", body: { project, task: rest[2], ...(kind ? { kind } : { agent: values.agent, model: values.model }), direct: !!values.here, ...(base ? { base } : {}), ...(values.branch ? { branch: values.branch } : {}) } });
      if (values.json) { console.log(JSON.stringify(lane, null, 2)); return lane.state === "failed" ? 1 : 0; }
      console.log(ok(`Started ${bold(lane.id)} on ${lane.branch}`));
      console.log(dim(`  Watch it in the browser. Open its shell: cl sh ${lane.id}`));
      return lane.state === "failed" ? 1 : 0;
    }
    case "send": {
      if (!rest[0] || !rest[1]) return usage(values.json);
      await api(`/api/lanes/${rest[0]}/prompt`, { method: "POST", body: { text: rest.slice(1).join(" ") } });
      console.log(values.json ? JSON.stringify({ queued: true, lane: rest[0] }) : "Message queued.");
      return 0;
    }
    case "term": {
      if (!rest[0]) return usage(values.json);
      const [project, n] = rest[0].split("/");
      const lanes = await api<Lane[]>(`/api/projects/${project}/lanes`);
      const lane = lanes.find((l) => l.id === `${project}/${n}`);
      if (!lane) throw new Error(`no lane ${rest[0]}`);
      return openTerminal(lane);
    }
    case "doctor": {
      const report = await api<DoctorReport>("/api/doctor");
      console.log(values.json ? JSON.stringify(report, null, 2) : formatDoctor(report));
      return report.checks.some((c) => c.state === "fail") ? 1 : 0;
    }
    case "inbox": {
      const items = await api<InboxItem[]>("/api/inbox");
      console.log(values.json ? JSON.stringify(items, null, 2) : formatInbox(items));
      return 0;
    }
    case "answer": {
      const [id, optionId] = rest;
      if (!id || !optionId) return usage(values.json);
      const [lane, requestId] = id.split("#");
      await api("/api/answers", { method: "POST", body: { lane, requestId, optionId, via: "cli" } });
      console.log(values.json ? JSON.stringify({ answered: true, lane, requestId, optionId }) : ok("Answered. The agent continues."));
      return 0;
    }
    case "setup":
      console.log(values.json ? JSON.stringify(await setupLink(), null, 2) : await setupOutput());
      return 0;
    case "add": {
      if (!rest[0] && unmounted(process.env)) throw new UsageError(unmounted(process.env)!);
      const project = await addProject(rest[0]);
      if (values.json) { console.log(JSON.stringify(project, null, 2)); return 0; }
      console.log(ok(`${bold(project.name)} is a project now (${project.path}). Start a lane in it: cl new "<task>"`));
      return 0;
    }
    case "projects": {
      const [projects, lanes] = await Promise.all([api<Project[]>("/api/projects"), api<Lane[]>("/api/lanes")]);
      const open = (id: string) => lanes.filter((l) => l.project === id && !["cleaned", "archived"].includes(l.state)).length;
      if (values.json) { console.log(JSON.stringify(projects.map((p) => ({ ...p, lanes: open(p.id) })), null, 2)); return 0; }
      console.log(projects.length ? table(["PROJECT", "LANES", "FOLDER"], projects.map((p) => [p.id, String(open(p.id)), p.path])) : "No projects yet. Inside a repository: cl add");
      return 0;
    }
    case "remove": {
      if (!rest[0]) return usage(values.json);
      if (process.env.CONTEXTLANES_LANE_TOKEN) throw new ClientError("Only the owner can remove a project.", { exit: 4, code: "owner_only" });
      await api(`/api/projects/${encodeURIComponent(rest[0])}`, { method: "DELETE" });
      console.log(values.json ? JSON.stringify({ removed: true, project: rest[0] }) : ok(`Removed ${bold(rest[0])} from ContextLanes. The repository itself is untouched.`));
      return 0;
    }
    case "schedule": {
      // Run by the systemd timers that Settings → Scheduled lanes writes.
      if (rest[0] !== "run" || !rest[1]) return usage(values.json);
      const lane = await api<Lane>(`/api/schedules/${rest[1]}/run`, { method: "POST", body: {} });
      console.log(values.json ? JSON.stringify(lane, null, 2) : `Started ${lane.id} for schedule ${rest[1]}.`);
      return 0;
    }
    case "bench": {
      if (!rest[0]) return usage(values.json);
      const tasks = JSON.parse(await readFile(rest[0], "utf8")) as unknown;
      let run = await api<BenchResult>("/api/bench", { method: "POST", body: { tasks } });
      const say = (text: string) => { if (!values.json) console.log(text); };
      say(`Bench ${run.id} started: ${run.tasks.length} ${run.tasks.length === 1 ? "task" : "tasks"}, two lanes each. Answer their questions in the Inbox as usual.`);
      let last = "";
      while (!run.finishedAt) {
        await new Promise((r) => setTimeout(r, 15_000));
        run = await api<BenchResult>(`/api/bench/${run.id}`);
        const line = run.tasks.flatMap((t) => t.runs.map((r) => `${r.lane ?? "not started"} ${r.state}`)).join(" · ");
        if (line !== last) { say(line); last = line; }
      }
      console.log(values.json ? JSON.stringify(run, null, 2) : `\n${benchTable(run)}`);
      return 0;
    }
    case "arch": {
      const project = rest[0] ?? (await api<Project[]>("/api/projects")).find((p) => process.cwd() === p.path || process.cwd().startsWith(`${p.path}/`))?.id;
      if (!project) throw new UsageError("Name a project, or run this inside one: cl arch <project>");
      const view = await api<ProjectMap>(`/api/projects/${project}/map`);
      console.log(values.json ? JSON.stringify(view, null, 2) : values.mermaid ? formatMermaid(view) : formatArch(view));
      return view.map ? 0 : 1;
    }
    default:
      if (values.json) throw new UsageError(`Unknown command: ${cmd}. Run cl help.`);
      console.error(fail(`Unknown command: ${cmd}\n`));
      return usage();
  }
}

/**
 * Puts this terminal in the lane's tmux session. "=" makes tmux match the exact name, never cl-shop-010
 * for cl-shop-01. Already inside tmux, attaching would nest, so this client switches over instead.
 */
function openTerminal(lane: Pick<Lane, "id" | "terminal">): number {
  // Lanes made before the wheel fix get it when they are next opened (see Terminals.wheel in the daemon).
  spawnSync("tmux", ["set-option", "-t", `=${lane.terminal}:`, "mouse", "on"], { stdio: "ignore" });
  if (!process.env.TMUX) return spawnSync("tmux", ["attach-session", "-t", `=${lane.terminal}`], { stdio: "inherit" }).status ?? 1;
  const switched = spawnSync("tmux", ["switch-client", "-t", `=${lane.terminal}`], { stdio: "inherit" }).status ?? 1;
  if (switched === 0) { console.log(dim("  Switched this tmux client to the lane. Ctrl-b L switches back.")); return 0; }
  console.error(fail(`Could not switch to ${lane.terminal} from inside tmux. From a plain shell: cl sh ${lane.id}`));
  return 1;
}

/** Colour codes off, for output a program reads. */
const plain = (text: string) => text.replace(/\u001b\[[0-9;]*m/g, "");

function usage(json = false): number {
  if (json) throw new UsageError("That command needs more arguments. Run cl help.");
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
