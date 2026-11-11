import { randomBytes } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { posix } from "node:path";
import { z } from "zod";
import type { EventPayload, Lane, Project, ProjectOwner } from "@contextlanes/protocol";
import type { EventBus } from "../bus.js";
import type { Config } from "../config.js";
import type { Store } from "../db/store.js";
import { Refused } from "../lanes/manager.js";
import { branchName, slugify } from "../lanes/naming.js";
import type { Runner } from "../run.js";
import { DockerSupervisor } from "../supervisor/docker.js";
import type { ControlInfo } from "./control.js";
import { execArgv, lanePath, laneVars, type ExecOptions, type LaneTarget } from "./exec.js";
import { helperName, lanesFolder, lanesFolderArgv, type DockerFolders } from "./folders.js";
import { Copied, copyIgnoredArgv, parseFound, READ_SH, readProjectArgv } from "./app.js";
import type { AppFiles, FoundFile } from "../recipes.js";
import { agentHomeVolume, HELPER_LABEL, INSTANCE_LABEL, LANE_AGENT_HOME, LANE_DIR, LANE_LABEL, LANE_TMUX_SOCKET, LANE_TOOLS, NETWORK, PROJECT_LABEL, SOCKET, TOOLS_VOLUME } from "./names.js";

/** The step a lane's creation failed in, recorded in a lane.container event and in the lane's failure. */
export type LaneStep = "checkout" | "environment" | "mounts" | "network" | "terminal";

export class LaneStepError extends Refused {
  constructor(readonly step: LaneStep, message: string, code = "lane_failed") { super(message, 502, code); }
}

/** Where the Dev Container CLI's helper keeps the lane's config: its own tmpfs, never the checkout. */
const OVERRIDE = "/tmp/contextlanes/devcontainer.json";
/** The time `devcontainer up` may take: pulling and building an image can take many minutes. */
const UP_MS = 25 * 60_000;
const CONFIG_FILES = [".devcontainer/devcontainer.json", ".devcontainer.json"];

/** The fields of `devcontainer up`'s answer that are used. */
const UpResult = z.object({ outcome: z.string(), containerId: z.string().optional(), remoteUser: z.string().optional(), remoteWorkspaceFolder: z.string().optional(), message: z.string().optional(), description: z.string().optional() });

/** `docker inspect` of a lane container, only the fields used, checked at the edge. */
const Inspect = z.array(z.object({
  Id: z.string(),
  Name: z.string().default(""),
  Config: z.object({ Image: z.string().default(""), Env: z.array(z.string()).nullable().default([]), Labels: z.record(z.string(), z.string()).nullable().default({}) }).prefault({}),
  HostConfig: z.object({ Privileged: z.boolean().default(false) }).prefault({}),
  Mounts: z.array(z.object({ Type: z.string().default(""), Source: z.string().default(""), Name: z.string().optional(), Destination: z.string(), RW: z.boolean().default(true) })).nullable().default([]),
  State: z.object({ Running: z.boolean().default(false), Status: z.string().default("") }).prefault({}),
})).min(1);
type Inspected = z.infer<typeof Inspect>[number];

/** Settings a devcontainer.json may not have in a lane: they would hand the lane this machine (docs/V4.md 3.5). */
export function unsafeConfig(cfg: Record<string, unknown>): string | null {
  const text = JSON.stringify({ mounts: cfg.mounts ?? [], runArgs: cfg.runArgs ?? [], workspaceMount: cfg.workspaceMount ?? "" });
  if (cfg.privileged === true) return "it asks for a privileged container";
  if (/docker\.sock/.test(text)) return "it mounts the Docker socket";
  const args = Array.isArray(cfg.runArgs) ? cfg.runArgs.map(String) : [];
  if (args.some((a) => /^--privileged(=true)?$/.test(a))) return "its runArgs ask for --privileged";
  if (args.some((a, i) => /^--security-opt(=|$)/.test(a) && /(seccomp|apparmor)[=:]unconfined/.test(a.includes("=") ? a : args[i + 1] ?? ""))) return "its runArgs turn off seccomp or AppArmor";
  return null;
}

/**
 * The override config for `devcontainer up` (docs/V4.md 8a): the project's own configuration as the Dev
 * Container CLI read it, or the default, plus the checkout at its host path, the read-only tools mount (the
 * CLI's --mount cannot say read-only) and a fixed container name. Paths in `build` are made absolute against
 * the project's config folder, since the override file lives elsewhere.
 */
export function laneConfig(input: { name: string; worktree: string; image: string; imageUser: string; project?: { configuration: Record<string, unknown>; file: string } }): Record<string, unknown> {
  let cfg: Record<string, unknown>;
  if (input.project) {
    cfg = structuredClone(input.project.configuration);
    if (cfg.dockerComposeFile) throw new Refused("This project's devcontainer.json uses Docker Compose (dockerComposeFile), which lanes do not support yet. Remove it from the lane's branch, or use an image or a Dockerfile.", 400, "compose_devcontainer");
    delete cfg.configFilePath;
    const dir = posix.dirname(input.project.file);
    // UNVERIFIED: that the Dev Container CLI resolves relative build paths against the override file; absolute paths sidestep it.
    const build = cfg.build && typeof cfg.build === "object" ? { ...cfg.build as Record<string, unknown> } : null;
    if (build) {
      if (typeof build.dockerfile === "string") build.dockerfile = posix.resolve(dir, build.dockerfile);
      build.context = posix.resolve(dir, typeof build.context === "string" ? build.context : ".");
      cfg.build = build;
    }
    if (typeof cfg.dockerFile === "string") { cfg.dockerFile = posix.resolve(dir, cfg.dockerFile); cfg.context = posix.resolve(dir, typeof cfg.context === "string" ? cfg.context : "."); }
    const why = unsafeConfig(cfg);
    if (why) throw new Refused(`This project's devcontainer.json cannot be used for a lane: ${why}. Lanes never get the Docker socket or a privileged container.`, 400, "unsafe_devcontainer");
  } else {
    cfg = { name: input.name, image: input.image, remoteUser: input.imageUser, updateRemoteUserUID: true };
  }
  // The worktree's .git file points at the main repository by absolute host path: same path inside.
  cfg.workspaceMount = `type=bind,source=${input.worktree},target=${input.worktree}`;
  cfg.workspaceFolder = input.worktree;
  const mounts = Array.isArray(cfg.mounts) ? cfg.mounts.slice() : [];
  mounts.push(`type=volume,source=${TOOLS_VOLUME},target=${LANE_TOOLS},readonly`);
  cfg.mounts = mounts;
  const runArgs = Array.isArray(cfg.runArgs) ? cfg.runArgs.map(String) : [];
  for (let i = runArgs.length - 1; i >= 0; i--) {
    if (runArgs[i] === "--name") runArgs.splice(i, 2);
    else if (runArgs[i]!.startsWith("--name=")) runArgs.splice(i, 1);
  }
  runArgs.push("--name", input.name);
  cfg.runArgs = runArgs;
  return cfg;
}

/** `devcontainer up`'s answer: the last line of stdout that is a JSON object. */
export function parseUp(stdout: string): z.infer<typeof UpResult> | null {
  const line = stdout.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("{")).at(-1);
  if (!line) return null;
  try { return UpResult.parse(JSON.parse(line)); } catch { return null; }
}

export type DockerLanesDeps = {
  /** Plain docker, run in the control container. */
  docker: Runner;
  /** The daemon's own git (confineGit over the helper runner): git on a project runs in a helper container. */
  git: Runner;
  folders: DockerFolders;
  store: Store;
  bus: EventBus;
  config: Config;
  control: () => ControlInfo | null;
  /** The group of the Docker socket as this container sees it: the one helper that gets the socket joins it. */
  socketGid?: () => Promise<number>;
  /** This image's /etc/passwd, which the Dev Container CLI helper gets with a line for the folder's owner added. */
  passwd?: () => Promise<string>;
  /** Writes a file into ./data (inside the control container) and says its host path. */
  dataFile?: (name: string, content: string) => Promise<string | null>;
};

type Names = { branch: string; worktree: string; container: string };

/**
 * Lanes in the Docker runtime (docs/V4.md 3.3): a git worktree beside the project made by a helper, one
 * container made by the Dev Container CLI from the checkout's devcontainer.json (or the default image),
 * joined to the contextlanes network, with tmux inside. Every Docker object a lane has is named and
 * labelled so the control service finds it again after it restarts.
 */
export class DockerLanes implements AppFiles {
  constructor(private readonly deps: DockerLanesDeps) {}

  private control(): ControlInfo {
    const c = this.deps.control();
    if (!c) throw new Refused("The control service could not read its own container from Docker, so it cannot make lane containers. Run contextlanes doctor.", 503, "docker_unreachable");
    return c;
  }

  private emit(e: ReturnType<Store["appendEvent"]>): void { this.deps.bus.publish(e); }

  private record(lane: string, payload: EventPayload<"lane.container">): void {
    this.emit(this.deps.store.appendEvent(lane, { type: "lane.container", payload }));
  }

  /** True for a lane that has (or had) a container: every lane made in the Docker runtime. */
  isDocker(lane: Pick<Lane, "id">): boolean {
    return this.deps.store.eventsOfType(["lane.container"], { lanes: [lane.id] }).length > 0;
  }

  /** How commands reach the lane: from its latest lane.container event that has the container's facts. */
  target(lane: Pick<Lane, "id" | "worktree">): LaneTarget | null {
    const facts = this.deps.store.eventsOfType(["lane.container"], { lanes: [lane.id] }).findLast((e) => e.payload.id && e.payload.user && e.payload.path);
    if (!facts) return null;
    return { container: facts.payload.name, user: facts.payload.user!, workdir: lane.worktree, path: facts.payload.path!, env: laneVars(lane.id) };
  }

  private need(lane: Pick<Lane, "id" | "worktree">): LaneTarget {
    const t = this.target(lane);
    if (!t) throw new Refused(`${lane.id} has no container yet.`, 409, "no_container");
    return t;
  }

  /** One command inside the lane's container. */
  exec(target: LaneTarget, argv: string[], opts: ExecOptions & { timeout?: number; input?: string } = {}): Promise<{ stdout: string }> {
    const { timeout, input, ...exec } = opts;
    return this.deps.docker("docker", execArgv(target, argv, { ...exec, ...(input !== undefined ? { interactive: true } : {}) }), { timeout: timeout ?? 30_000, ...(input !== undefined ? { input } : {}), ...(opts.secrets ? { env: opts.secrets } : {}) });
  }

  /** tmux inside the lane, on ContextLanes' own socket name. */
  tmux(lane: Pick<Lane, "id" | "worktree">, args: string[], opts: { timeout?: number } = {}): Promise<{ stdout: string }> {
    return this.exec(this.need(lane), ["tmux", "-L", LANE_TMUX_SOCKET, ...args], opts);
  }

  /** Writes a file inside the lane (mode 0600 in a 0700 folder), through stdin: never in an argument. */
  async write(target: LaneTarget, path: string, content: string): Promise<void> {
    await this.exec(target, ["sh", "-c", 'umask 077 && mkdir -p "$(dirname "$1")" && cat > "$1"', "sh", path], { input: content });
  }

  /** Reads a file inside the lane; empty when it is not there. */
  async read(target: LaneTarget, path: string): Promise<string> {
    return this.exec(target, ["sh", "-c", 'cat "$1" 2>/dev/null || true', "sh", path]).then((r) => r.stdout, () => "");
  }

  /** The supervisor for processes inside this lane: the app's services and the recipe's one-shot steps. */
  supervisor(lane: Pick<Lane, "id" | "worktree">): DockerSupervisor {
    return new DockerSupervisor(this.deps.docker, this.need(lane));
  }

  /** The container's state as last recorded (lane.container events): running, stopped, missing, failed… */
  state(lane: Pick<Lane, "id">): string | null {
    return this.deps.store.eventsOfType(["lane.container"], { lanes: [lane.id] }).at(-1)?.payload.state ?? null;
  }

  // ── the app's files (docs/V4.md 3.4, phase 4) ──

  /** The first of these files in the lane's checkout, read inside the lane as its user (READ_SH). */
  async readInLane(lane: Lane, files: readonly string[]): Promise<FoundFile | null> {
    const target = this.need(lane);
    let stdout: string;
    try { stdout = (await this.exec(target, ["sh", "-c", READ_SH, "sh", ...files], { timeout: 15_000 })).stdout; }
    catch (err) { throw new Refused(`The recipe could not be read inside the lane's container ${lane.terminal} (${(err as Error).message.slice(0, 300)}). Is it running? contextlanes status ${lane.id}`, 502, "lane_unreachable"); }
    return parseFound(stdout, files);
  }

  /** The same in the project's main checkout, by a helper that mounts only it, read-only, as its owner. */
  async readInProject(project: Project, files: readonly string[]): Promise<FoundFile | null> {
    const owner = await this.deps.folders.ownerOf(project);
    const argv = readProjectArgv(this.control().image, this.deps.folders.checkPath(project.path), owner, files);
    let stdout: string;
    try { stdout = (await this.deps.folders.helper(argv, { timeout: 15_000 })).stdout; }
    catch (err) { throw new Refused(`A helper container could not read the recipe in ${project.path}: ${(err as Error).message.slice(0, 300)}`, 502, "helper_failed"); }
    return parseFound(stdout, files);
  }

  /**
   * The recipe's `copy`: ignored files of the main checkout (.env and the like) into the lane's checkout,
   * by a helper that mounts the project read-only and the checkout, as the owner. Returns the files copied.
   */
  async copyIgnored(lane: Lane, project: Project, patterns: readonly string[]): Promise<string[]> {
    if (!patterns.length || lane.direct) return [];
    const owner = await this.deps.folders.ownerOf(project);
    const argv = copyIgnoredArgv(this.control().image, this.deps.folders.checkPath(project.path), this.deps.folders.checkPath(lane.worktree), owner, patterns);
    const { stdout } = await this.deps.folders.helper(argv, { timeout: 300_000 });
    try { return Copied.parse(JSON.parse(stdout || "[]")); }
    catch { throw new Error(`Copying ignored files gave an answer that is not a list of files: ${stdout.slice(0, 200)}`); }
  }

  /** `docker exec -it` argv that puts a person's terminal in the lane's tmux session. */
  attachArgv(lane: Pick<Lane, "id" | "worktree" | "terminal">, term = "xterm-256color"): string[] {
    const t = this.need(lane);
    return execArgv(t, ["tmux", "-L", LANE_TMUX_SOCKET, "attach-session", "-t", `=${lane.terminal}`], { interactive: true, tty: true, env: { TERM: term } });
  }

  // ── names ──

  /**
   * Lane numbers restart with a fresh database, and branches, checkouts and containers outlive their lanes.
   * Add -2, -3… until the branch, the checkout and the container name are all free.
   */
  async freeNames(project: Project, n: number, title: string, ownBranch: string | null): Promise<Names> {
    const repo = project.path;
    const names = new Set((await this.deps.docker("docker", ["ps", "-a", "--format", "{{.Names}}"], { timeout: 15_000 }).then((r) => r.stdout, () => "")).split("\n").map((s) => s.trim()).filter(Boolean));
    const worktrees = (await this.deps.git("git", ["worktree", "list", "--porcelain"], { cwd: repo, timeout: 30_000 }).then((r) => r.stdout, () => "")).split("\n").filter((l) => l.startsWith("worktree ")).map((l) => l.slice(9));
    for (let i = 1; i <= 50; i++) {
      const suffix = i === 1 ? "" : `-${i}`;
      const branch = ownBranch ?? `${branchName(n, title)}${suffix}`;
      const worktree = `${lanesFolder(repo)}/${String(n).padStart(2, "0")}-${slugify(title)}${suffix}`;
      const container = `cl-${project.id}-${String(n).padStart(2, "0")}${suffix}`;
      const listed = ownBranch ? "" : await this.deps.git("git", ["branch", "--list", branch], { cwd: repo, timeout: 30_000 }).then((r) => r.stdout.trim(), () => "");
      if (!listed && !worktrees.includes(worktree) && !names.has(container)) return { branch, worktree, container };
    }
    throw new Refused(`Branches lane/${String(n).padStart(2, "0")}-… are all taken in this repository; delete old lane branches and try again.`);
  }

  // ── create ──

  /**
   * Makes the lane in the order of docs/V4.md 3.3: checkout, environment, mounts, network, terminal (and
   * the agent, through `launch`). A step that fails removes what the earlier ones made, records a
   * lane.container event naming the step, and throws.
   */
  async create(lane: Lane, project: Project, opts: { ownBranch: { name: string; remoteOnly: boolean } | null; base: string; launch?: (target: LaneTarget) => Promise<void> }): Promise<LaneTarget> {
    const owner = await this.deps.folders.ownerOf(project);
    const undo: (() => Promise<unknown>)[] = [];
    const fail = async (step: LaneStep, err: unknown): Promise<never> => {
      const message = err instanceof Error ? err.message : String(err);
      for (const u of undo.reverse()) await u().catch((e: Error) => console.error(`Cleaning up ${lane.id} failed:`, e.message));
      this.record(lane.id, { state: "failed", name: lane.terminal, step, message: message.slice(0, 4000) });
      throw new LaneStepError(step, message, err instanceof Refused && err.code ? err.code : "lane_failed");
    };

    // 1. Checkout.
    this.record(lane.id, { state: "creating", name: lane.terminal });
    try { await this.checkout(lane, project, owner, opts.ownBranch, opts.base); }
    catch (err) { await this.forgetWorktree(lane, project); return fail("checkout", err); }
    undo.push(() => this.removeCheckout(lane, project, !opts.ownBranch));

    // 2. Environment: the container, from the checkout's devcontainer.json or the default image.
    let id: string, user: string;
    try {
      undo.push(() => this.deps.docker("docker", ["rm", "--force", lane.terminal], { timeout: 60_000 }));
      ({ id, user } = await this.up(lane, project, owner));
    } catch (err) { return fail("environment", err); }

    // 3. Mounts: checked as Docker reports them, then the lane's own folders and the agent logins prepared.
    let target: LaneTarget, facts: { uid: number; gid: number; image: string };
    try {
      const inspected = await this.inspect(id);
      if (inspected.Config.Image.startsWith("vsc-")) undo.push(() => this.deps.docker("docker", ["image", "rm", inspected.Config.Image], { timeout: 60_000 }));
      this.checkMounts(inspected, lane, project, owner);
      const imagePath = (inspected.Config.Env ?? []).find((e) => e.startsWith("PATH="))?.slice(5);
      target = { container: lane.terminal, user, workdir: lane.worktree, path: lanePath(imagePath), env: laneVars(lane.id) };
      const ids = (await this.exec(target, ["sh", "-c", "id -u && id -g"])).stdout.trim().split("\n").map(Number);
      const [uid, gid] = ids as [number, number];
      if (!Number.isInteger(uid) || !Number.isInteger(gid)) throw new Error(`could not read the lane user's ids (${ids.join(" ")})`);
      // The agent-login volume is per uid; a lane user that is neither the owner nor root would take it over.
      if (uid !== 0 && uid !== owner.uid) throw new Refused(`The lane's user ${user} has uid ${uid}, but the project folder belongs to uid ${owner.uid}. Files the lane writes would not be yours. Set remoteUser in devcontainer.json to a user whose uid the Dev Container CLI can change (updateRemoteUserUID), or leave it out.`, 400, "lane_user_mismatch");
      await this.prepare(target, uid, gid);
      facts = { uid, gid, image: inspected.Config.Image };
    } catch (err) { return fail("mounts", err); }

    // 4. Network: the contextlanes network, under the lane's container name. Nothing is published.
    try { await this.deps.docker("docker", ["network", "connect", "--alias", lane.terminal, NETWORK, id], { timeout: 30_000 }); }
    catch (err) { return fail("network", err); }
    this.record(lane.id, { state: "running", name: lane.terminal, id, user, uid: facts.uid, gid: facts.gid, path: target.path, image: facts.image });

    // 5. Terminal, and the agent in it.
    try {
      await this.terminal(lane, target);
      await opts.launch?.(target);
    } catch (err) { return fail("terminal", err); }
    if (facts.uid === 0) this.emit(this.deps.store.appendEvent(lane.id, { type: "agent.notice", payload: { message: "This lane's container runs as root (the project's devcontainer.json asks for it), so files it writes in the checkout belong to root on the host." } }));
    return target;
  }

  /** `<project>.lanes`, then the worktree on a new lane branch or the one asked for. */
  private async checkout(lane: Lane, project: Project, owner: ProjectOwner, ownBranch: { name: string; remoteOnly: boolean } | null, base: string): Promise<void> {
    const folder = this.deps.folders.checkPath(lanesFolder(project.path));
    const made = (await this.deps.folders.helper(lanesFolderArgv(this.control().image, folder, owner), { timeout: 30_000 })).stdout.trim();
    if (made !== `${owner.uid}:${owner.gid}`) throw new Error(`${folder} belongs to ${made}, not to the project's owner ${owner.uid}:${owner.gid}. Give it to them (sudo chown ${owner.uid}:${owner.gid} ${folder}) or move it away.`);
    const repo = project.path;
    // Run from <project>.lanes, so the helper mounts both the project and the folder the checkout goes in.
    const git = (args: string[], timeout = 120_000) => this.deps.git("git", ["-C", repo, ...args], { cwd: folder, timeout });
    if (ownBranch) await git(["worktree", "add", ...(ownBranch.remoteOnly ? ["--track", "-b", ownBranch.name, lane.worktree, `origin/${ownBranch.name}`] : [lane.worktree, ownBranch.name])]);
    else {
      const has = (ref: string) => git(["rev-parse", "--verify", "--quiet", ref], 30_000).then(() => true, () => false);
      const from = await has(`refs/heads/${base}`) ? base : await has(`refs/remotes/origin/${base}`) ? `origin/${base}` : base;
      await git(["worktree", "add", "-b", lane.branch, lane.worktree, from]);
    }
  }

  /**
   * Drops this lane's worktree record and nothing else. Never `git worktree prune`: a helper sees only the
   * project and `<project>.lanes`, so every worktree the owner keeps anywhere else looks missing to it and
   * prune would delete their records. `worktree remove` on a path whose folder is gone removes just its record.
   */
  private forgetWorktree(lane: Pick<Lane, "worktree">, project: Project): Promise<unknown> {
    return this.deps.git("git", ["-C", project.path, "worktree", "remove", "--force", lane.worktree], { cwd: lanesFolder(project.path), timeout: 30_000 }).catch(() => {});
  }

  /** The checkout, and the branch only when it is a lane/ branch this lane made and the caller asks. */
  private async removeCheckout(lane: Lane, project: Project, deleteBranch: boolean): Promise<void> {
    const folder = lanesFolder(project.path);
    // Removes the folder and its record; when the folder is already gone, only the record. Never prune (see forgetWorktree).
    await this.deps.git("git", ["-C", project.path, "worktree", "remove", "--force", lane.worktree], { cwd: folder, timeout: 120_000 }).catch(() => {});
    if (deleteBranch && lane.branch.startsWith("lane/")) await this.deps.git("git", ["branch", "-D", lane.branch], { cwd: project.path, timeout: 30_000 }).catch(() => {});
  }

  /** The one helper that gets the Docker socket (docs/V4.md 8a): the Dev Container CLI, as the folder's owner. */
  async devcontainerArgv(lane: Pick<Lane, "worktree">, project: Project, owner: ProjectOwner, cliArgs: string[], extraEnv: Record<string, string> = {}, name = helperName()): Promise<string[]> {
    const control = this.control();
    const gid = await (this.deps.socketGid ?? (async () => (await stat(SOCKET)).gid))();
    const passwd = await this.passwdMount(owner);
    // UNVERIFIED: the spike ran this helper without --cap-drop ALL and no-new-privileges; a non-root CLI should need neither.
    return ["run", "--rm", "--name", name, "--label", `${HELPER_LABEL}=1`, "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
      "--user", `${owner.uid}:${owner.gid}`, "--group-add", String(gid), "-e", "HOME=/tmp", ...Object.entries(extraEnv).flatMap(([k, v]) => ["-e", `${k}=${v}`]),
      ...passwd,
      // This helper, and no other, gets the socket: it is how the Dev Container CLI builds and starts the lane.
      "-v", `${control.socket}:${SOCKET}`,
      "--mount", `type=bind,source=${lane.worktree},target=${lane.worktree}`,
      "--mount", `type=bind,source=${project.path}/.git,target=${project.path}/.git`,
      "--entrypoint", "sh", control.image, "-c",
      'mkdir -p /tmp/contextlanes && if [ -n "${CL_CONFIG:-}" ]; then printf "%s" "$CL_CONFIG" > /tmp/contextlanes/devcontainer.json; fi && exec devcontainer "$@"', "devcontainer", ...cliArgs];
  }

  /**
   * The Dev Container CLI needs a user name for the uid it runs as. The image has one for uid 1000 (node);
   * for any other uid the helper gets this image's passwd file with one line added, from ./data, read-only.
   */
  private async passwdMount(owner: ProjectOwner): Promise<string[]> {
    const passwd = await (this.deps.passwd ?? (() => readFile("/etc/passwd", "utf8")))();
    if (passwd.split("\n").some((l) => l.split(":")[2] === String(owner.uid))) return [];
    // UNVERIFIED: the spike's retry with a passwd file mounted read-only; on neo the run as uid 1000 worked without it.
    const content = `${passwd.trimEnd()}\ncontextlanes:x:${owner.uid}:${owner.gid}:ContextLanes project owner:/tmp:/bin/sh\n`;
    const host = await (this.deps.dataFile ?? (async () => null))(`helpers/passwd-${owner.uid}`, content);
    if (!host) throw new Refused(`The project folder belongs to uid ${owner.uid}, and the control service could not find where its ./data folder is on this machine to give the Dev Container CLI a user for it. Run contextlanes doctor.`, 503, "no_data_path");
    return ["--mount", `type=bind,source=${host},target=/etc/passwd,readonly`];
  }

  /** Reads the checkout's devcontainer.json (through the CLI, which understands its format), merges ours in, and runs `devcontainer up`. */
  private async up(lane: Lane, project: Project, owner: ProjectOwner): Promise<{ id: string; user: string }> {
    const control = this.control();
    const found = (await this.deps.folders.helper([...this.lookArgv(lane.worktree, owner), control.image, "-c",
      'for f in "$@"; do if [ -f "$0/$f" ]; then echo "$f"; exit 0; fi; done', lane.worktree, ...CONFIG_FILES], { timeout: 30_000 })).stdout.trim();
    let projectConfig: { configuration: Record<string, unknown>; file: string } | undefined;
    if (found) {
      const file = `${lane.worktree}/${found}`;
      // UNVERIFIED: read-configuration prints {"configuration": {...}} on stdout; the spike wrote this path but its repository had no devcontainer.json.
      const read = await this.deps.folders.helper(await this.devcontainerArgv(lane, project, owner, ["read-configuration", "--workspace-folder", lane.worktree]), { timeout: 120_000 });
      const parsed = (() => { try { return JSON.parse(read.stdout.split("\n").filter((l) => l.trim().startsWith("{")).at(-1) ?? "") as { configuration?: unknown }; } catch { return {}; } })();
      if (!parsed.configuration || typeof parsed.configuration !== "object") throw new Error(`The Dev Container CLI could not read ${found}.`);
      projectConfig = { configuration: parsed.configuration as Record<string, unknown>, file };
    }
    const config = laneConfig({ name: lane.terminal, worktree: lane.worktree, image: this.deps.config.lanes.image, imageUser: this.deps.config.lanes.imageUser, ...(projectConfig ? { project: projectConfig } : {}) });
    const args = ["up", "--workspace-folder", lane.worktree, "--override-config", OVERRIDE,
      "--id-label", `${LANE_LABEL}=${lane.id}`, "--id-label", `${PROJECT_LABEL}=${project.id}`, "--id-label", `${INSTANCE_LABEL}=${randomBytes(6).toString("hex")}`,
      "--mount", `type=bind,source=${project.path}/.git,target=${project.path}/.git`,
      "--mount", `type=volume,source=${agentHomeVolume(owner.uid)},target=${LANE_AGENT_HOME}`,
      "--remote-env", `PATH=${LANE_TOOLS}/bin:\${containerEnv:PATH}`,
      "--update-remote-user-uid-default", "on", "--remove-existing-container", "--no-lockfile", "--log-format", "text"];
    let stdout: string;
    try { stdout = (await this.deps.folders.helper(await this.devcontainerArgv(lane, project, owner, args, { CL_CONFIG: JSON.stringify(config) }), { timeout: UP_MS })).stdout; }
    catch (err) {
      // UNVERIFIED: that a failed `up` still prints {"outcome":"error","message":…,"description":…} on stdout.
      const said = parseUp(String((err as { stdout?: string }).stdout ?? ""));
      throw new Error(said?.message ? `devcontainer up failed: ${said.message}${said.description ? ` (${said.description.slice(0, 600)})` : ""}` : (err as Error).message);
    }
    const result = parseUp(stdout);
    if (!result || result.outcome !== "success" || !result.containerId) throw new Error(`devcontainer up did not succeed: ${result?.message ?? (stdout.trim().split("\n").at(-1) ?? "no answer").slice(0, 600)}`);
    if (result.remoteWorkspaceFolder && result.remoteWorkspaceFolder !== lane.worktree) throw new Error(`The container's workspace is ${result.remoteWorkspaceFolder}, not the checkout's path ${lane.worktree}.`);
    return { id: result.containerId, user: result.remoteUser || "root" };
  }

  /** A no-socket, no-network helper that only looks at the checkout (read-only), as its owner. */
  private lookArgv(worktree: string, owner: ProjectOwner): string[] {
    return ["run", "--rm", "--name", helperName(), "--label", `${HELPER_LABEL}=1`, "--network", "none", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
      "--read-only", "--user", `${owner.uid}:${owner.gid}`, "--mount", `type=bind,source=${worktree},target=${worktree},readonly`, "--entrypoint", "sh"];
  }

  async inspect(ref: string): Promise<Inspected> {
    const { stdout } = await this.deps.docker("docker", ["inspect", "--type", "container", ref], { timeout: 15_000 });
    return Inspect.parse(JSON.parse(stdout))[0]!;
  }

  /** The hard limits of docs/V4.md 3.5, read from what Docker says the container has. */
  checkMounts(c: Inspected, lane: Pick<Lane, "worktree">, project: Project, owner: ProjectOwner): void {
    const control = this.control();
    const mounts = (c.Mounts ?? []).map((m) => ({ ...m, Source: m.Type === "volume" ? m.Name ?? m.Source : m.Source }));
    if (c.HostConfig.Privileged) throw new Refused("The lane's container is privileged; lanes never are. It was removed.", 400, "unsafe_devcontainer");
    const bad = mounts.find((m) => [SOCKET, "/run/docker.sock", control.socket].includes(m.Source) || m.Destination === SOCKET || (control.data && (m.Source === control.data || m.Source.startsWith(`${control.data}/`))));
    if (bad) throw new Refused(`The lane's container mounts ${bad.Source}, which no lane may see (the Docker socket or ContextLanes' data). It was removed.`, 400, "unsafe_devcontainer");
    const has = (dest: string, rw?: boolean) => mounts.some((m) => m.Destination === dest && (rw === undefined || m.RW === rw));
    const missing = [
      has(lane.worktree) ? null : `the checkout at ${lane.worktree}`,
      has(`${project.path}/.git`) ? null : `the project's .git at ${project.path}/.git`,
      has(LANE_TOOLS, false) ? null : `the tools volume read-only at ${LANE_TOOLS}`,
      mounts.some((m) => m.Destination === LANE_AGENT_HOME && m.Source === agentHomeVolume(owner.uid)) ? null : `the agent logins (${agentHomeVolume(owner.uid)}) at ${LANE_AGENT_HOME}`,
    ].filter(Boolean);
    if (missing.length) throw new Error(`The lane's container is missing ${missing.join(", ")}.`);
  }

  /**
   * The agent-login volume is owned by root when Docker creates it, and the lane's own folder does not
   * exist: root makes both and gives them to the lane's user (proven by the spike). Only top folders are
   * changed, so an existing volume keeps its files as they are.
   */
  private async prepare(target: LaneTarget, uid: number, gid: number): Promise<void> {
    await this.exec(target, ["sh", "-c", 'mkdir -p "$1/claude" "$1/codex" "$3" && chown "$2" "$1" "$1/claude" "$1/codex" "$3" && chmod 0700 "$3"', "sh", LANE_AGENT_HOME, `${uid}:${gid}`, LANE_DIR], { user: "0", dir: "/" });
  }

  /** tmux in the lane, its server started by this exec and outliving it. Mouse on, as in v3 (Terminals.wheel). */
  private async terminal(lane: Lane, target: LaneTarget): Promise<void> {
    await this.exec(target, ["tmux", "-L", LANE_TMUX_SOCKET, "new-session", "-d", "-s", lane.terminal, "-x", "200", "-y", "50", "-c", lane.worktree]);
    await this.exec(target, ["tmux", "-L", LANE_TMUX_SOCKET, "set-option", "-t", `=${lane.terminal}:`, "mouse", "on"]).catch(() => {});
  }

  /** The lane's tmux session, started again when it is gone (a restarted container loses it). */
  async ensureTerminal(lane: Lane): Promise<void> {
    const target = this.need(lane);
    const has = await this.exec(target, ["tmux", "-L", LANE_TMUX_SOCKET, "has-session", "-t", `=${lane.terminal}`]).then(() => true, () => false);
    if (!has) await this.terminal(lane, target);
  }

  // ── delete ──

  /**
   * Stops and removes the lane's container, the image the Dev Container CLI built for it, the checkout (by a
   * helper), and the branch only when asked and it is a lane/ branch. Records lane.container removed.
   */
  async remove(lane: Lane, project: Project, opts: { deleteBranch: boolean }): Promise<void> {
    const facts = this.deps.store.eventsOfType(["lane.container"], { lanes: [lane.id] }).findLast((e) => e.payload.image);
    const name = lane.terminal;
    const gone = (err: unknown) => /no such (container|object)|not found/i.test(String((err as Error).message));
    await this.deps.docker("docker", ["rm", "--force", name], { timeout: 60_000 }).catch((err) => { if (!gone(err)) throw new Refused(`The lane's container ${name} could not be removed: ${(err as Error).message}`, 502, "docker_failed"); });
    const image = facts?.payload.image;
    // Only the lane's own image (vsc-…), never a base image another lane or the project may use.
    if (image?.startsWith("vsc-")) await this.deps.docker("docker", ["image", "rm", image], { timeout: 60_000 }).catch(() => {});
    if (!lane.direct) await this.removeCheckout(lane, project, opts.deleteBranch);
    this.record(lane.id, { state: "removed", name });
  }

  /** What `contextlanes delete` shows first: changes that would be lost, read by a helper in the checkout. */
  async preview(lane: Lane, project: Project): Promise<{ uncommitted: number; commits: number; present: boolean }> {
    // From <project>.lanes with -C: a helper's working folder that does not exist would be created by Docker.
    const status = await this.deps.git("git", ["-C", lane.worktree, "status", "--porcelain"], { cwd: lanesFolder(project.path), timeout: 30_000 }).then((r) => r.stdout, () => null);
    const commits = Number((await this.deps.git("git", ["rev-list", "--count", `${lane.base ?? "HEAD"}..${lane.branch}`], { cwd: project.path, timeout: 30_000 }).then((r) => r.stdout, () => "0")).trim()) || 0;
    return { uncommitted: status === null ? 0 : status.split("\n").filter(Boolean).length, commits, present: status !== null };
  }

  // ── found again ──

  /**
   * Run when the control service starts (and by doctor): lists containers by label and records, for each
   * open lane, whether its container is running, stopped or missing, as a lane.container event when that
   * changed. A lane whose container is gone fails with a reason. Containers labelled as lanes that no open
   * lane owns are returned as strays; nothing is removed.
   */
  async reconcile(opts: { record?: boolean } = {}): Promise<{ lines: string[]; strays: string[]; missing: string[] }> {
    const write = opts.record !== false;
    const { store, bus } = this.deps;
    // UNVERIFIED: the {{.State}} field of `docker ps --format` ("running", "exited", "created"), from memory.
    const out = (await this.deps.docker("docker", ["ps", "-a", "--filter", `label=${LANE_LABEL}`, "--format", "{{.ID}}\t{{.Names}}\t{{.State}}"], { timeout: 30_000 })).stdout;
    const found = new Map(out.split("\n").map((l) => l.trim().split("\t")).filter((c) => c.length >= 3).map(([id, name, state]) => [name!, { id: id!, state: state! }]));
    const lines: string[] = [], missing: string[] = [];
    const open = store.listLanes().filter((l) => !["cleaned", "archived"].includes(l.state) && this.isDocker(l));
    for (const lane of open) {
      const last = store.eventsOfType(["lane.container"], { lanes: [lane.id] }).at(-1)!;
      if (last.payload.state === "failed" || last.payload.state === "removed" || last.payload.state === "creating") continue;
      const c = found.get(lane.terminal);
      const now = !c ? "missing" : c.state === "running" ? "running" : "stopped";
      if (now === "missing") missing.push(lane.id);
      if (last.payload.state === now || !write) continue;
      const facts = store.eventsOfType(["lane.container"], { lanes: [lane.id] }).findLast((e) => e.payload.id)?.payload;
      this.record(lane.id, { ...(facts ?? {}), name: lane.terminal, state: now });
      lines.push(`${lane.id}: container ${lane.terminal} ${now}`);
      if (now === "missing" && ["working", "needs_you", "setting_up", "draft"].includes(lane.state))
        bus.publish(store.setLaneState(lane.id, "failed", `The lane's container ${lane.terminal} is gone (removed outside ContextLanes). The checkout and branch are kept; delete the lane and start a new one.`));
    }
    const owned = new Set(open.map((l) => l.terminal));
    const strays = [...found.keys()].filter((name) => !owned.has(name));
    return { lines, strays, missing };
  }
}
