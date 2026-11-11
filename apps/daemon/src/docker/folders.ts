import { randomBytes } from "node:crypto";
import { posix } from "node:path";
import type { ProjectOwner } from "@contextlanes/protocol";
import type { Store } from "../db/store.js";
import { Refused } from "../lanes/manager.js";
import { DEFAULT_TIMEOUT, type Runner } from "../run.js";
import type { ControlInfo } from "./control.js";
import { HELPER_LABEL, HELPER_PREFIX } from "./names.js";
import { checkProjectPath } from "./paths.js";

/** How `docker run --mount` says the folder is not there. */
const MISSING_SOURCE = /bind source path does not exist|no such file or directory/i;
/** Time a helper may take to start, on top of the command's own timeout. */
const START_MS = 15_000;

/**
 * The flags every helper container gets: removed when done, labelled and named so a stray one can be found
 * and removed, no network, no capabilities, no privilege gain. Never the Docker socket, never --privileged.
 */
export function helperBase(name: string): string[] {
  return ["run", "--rm", "--name", name, "--label", `${HELPER_LABEL}=1`, "--network", "none",
    "--cap-drop", "ALL", "--security-opt", "no-new-privileges"];
}

/** The one folder a helper sees, at the same path, read-only when it only looks. */
export function folderMount(path: string, readonly = false): string[] {
  return ["--mount", `type=bind,source=${path},target=${path}${readonly ? ",readonly" : ""}`];
}

export const helperName = () => `${HELPER_PREFIX}${randomBytes(6).toString("hex")}`;

/**
 * `stat` on the folder, as root with the folder read-only and the root filesystem read-only: reading the
 * owner needs no permission on the folder itself, so no capability is added back.
 */
export function statArgv(image: string, path: string, name = helperName()): string[] {
  return [...helperBase(name), "--read-only", "--user", "0:0", ...folderMount(path, true), "--entrypoint", "stat", image, "-c", "%u:%g", "--", path];
}

/**
 * git in the project folder as the folder's owner, so anything it writes is theirs. HOME is a private
 * tmpfs; the image's own git config is ignored. The folder is the only thing mounted.
 */
export function gitArgv(image: string, project: string, cwd: string, owner: ProjectOwner, args: string[], env: Record<string, string> = {}, name = helperName(), also: string[] = []): string[] {
  const vars = Object.entries({ HOME: "/tmp", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0", ...env }).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
  return [...helperBase(name), "--read-only", "--tmpfs", "/tmp", "--user", `${owner.uid}:${owner.gid}`, ...vars, ...folderMount(project), ...also.flatMap((p) => folderMount(p)), "-w", cwd, "--entrypoint", "git", image, ...args];
}

/** Lane checkouts of a project live beside it, in `<project folder>.lanes` (docs/V4.md 9.1). */
export const lanesFolder = (project: string) => `${project}.lanes`;

/**
 * Makes `<project>.lanes` the owner's. The helper mounts only that folder: Docker creates it when it is
 * missing (as root), and the helper, root with only CHOWN added back, hands it to the owner, but only an
 * empty folder owned by root, which is what Docker just made. A folder that exists is never changed.
 * Proven by the phase 1 spike (docs/V4.md 8b).
 */
export function lanesFolderArgv(image: string, folder: string, owner: ProjectOwner, name = helperName()): string[] {
  return [...helperBase(name), "--read-only", "--cap-add", "CHOWN", "--user", "0:0", "-v", `${folder}:${folder}`, "--entrypoint", "sh", image, "-c",
    'if [ "$(stat -c %u "$1")" = 0 ] && [ -z "$(ls -A "$1")" ]; then chown "$2" "$1"; fi; stat -c %u:%g "$1"', "sh", folder, `${owner.uid}:${owner.gid}`];
}

/** What `add` learns about a folder, read through helpers. */
export type FolderFacts = { root: string; owner: ProjectOwner };

/**
 * Project folders in the Docker runtime. The control service cannot see them, so everything it needs from
 * one runs in a short-lived helper container that has only that folder mounted.
 */
export class DockerFolders {
  /** Owners read during `add`, before the project is in the store. */
  private pending = new Map<string, ProjectOwner>();

  constructor(private readonly deps: { run: Runner; control: ControlInfo | (() => ControlInfo | null) | null; store: Store }) {}

  private control(): ControlInfo {
    const c = typeof this.deps.control === "function" ? this.deps.control() : this.deps.control;
    if (!c) throw new Refused("The control service could not read its own container from Docker, so it cannot start helper containers. Run contextlanes doctor.", 503, "docker_unreachable");
    return c;
  }

  /** Throws a clear refusal for a path no helper may mount. */
  checkPath(path: string): string {
    const c = this.control();
    return checkProjectPath(path, { data: c.data, socket: c.socket });
  }

  /** Runs one helper and removes it by name if the command is stopped (a killed client leaves the container running). */
  async helper(argv: string[], opts: { timeout?: number } = {}): Promise<{ stdout: string }> {
    const name = argv[argv.indexOf("--name") + 1]!;
    try {
      return await this.deps.run("docker", argv, { timeout: (opts.timeout ?? DEFAULT_TIMEOUT) + START_MS });
    } catch (err) {
      const e = err as { killed?: boolean; signal?: string };
      if (e.killed || e.signal) await this.deps.run("docker", ["rm", "--force", name], { timeout: 15_000 }).catch(() => {});
      throw err;
    }
  }

  /** The folder's owner, read once by a helper `stat`. */
  async owner(path: string): Promise<ProjectOwner> {
    const image = this.control().image;
    let out: string;
    try { out = (await this.helper(statArgv(image, this.checkPath(path)), { timeout: 15_000 })).stdout.trim(); }
    catch (err) {
      const said = String((err as Error).message);
      // UNVERIFIED: Docker's wording for a missing bind source, from memory; change MISSING_SOURCE if it differs.
      if (MISSING_SOURCE.test(said)) throw new Refused(`${path} does not exist on this machine.`, 400, "no_folder");
      throw new Refused(`A helper container could not read ${path}: ${said}`, 502, "helper_failed");
    }
    const m = /^(\d+):(\d+)$/.exec(out);
    if (!m) throw new Refused(`A helper container could not read the owner of ${path} (it said "${out.slice(0, 200)}").`, 502, "helper_failed");
    return { uid: Number(m[1]), gid: Number(m[2]) };
  }

  /**
   * What `add` needs: the owner, and proof that the folder is the top of a git repository whose .git is a
   * folder inside it. A subfolder, a worktree or a submodule cannot work with only that folder mounted.
   */
  async inspect(path: string): Promise<FolderFacts> {
    const root = this.checkPath(path);
    const owner = await this.owner(root);
    this.pending.set(root, owner);
    let out: string[];
    try {
      out = (await this.helper(gitArgv(this.control().image, root, root, owner, ["rev-parse", "--show-toplevel", "--absolute-git-dir"]), { timeout: 15_000 })).stdout.trim().split("\n");
    } catch {
      this.pending.delete(root);
      throw new Refused(`${root} is not the top folder of a Git repository. Run contextlanes add in the folder that holds .git (not a subfolder, a worktree or a submodule), or pass that folder: contextlanes add /path/to/repository`, 400, "not_a_repository");
    }
    if (out[0] !== root || out[1] !== `${root}/.git`) {
      this.pending.delete(root);
      throw new Refused(`${root} is not the top folder of a Git repository with its own .git folder (git says ${out[0] ?? "nothing"}). Add the main repository's top folder.`, 400, "not_a_repository");
    }
    return { root, owner };
  }

  /** The owner to run git as for a registered project: stored, or read now and stored (projects listed in config.toml). */
  async ownerOf(project: { id: string; path: string; owner?: ProjectOwner | null }): Promise<ProjectOwner> {
    if (project.owner) return project.owner;
    const owner = this.pending.get(project.path) ?? await this.owner(project.path);
    this.deps.store.setProjectOwner(project.id, owner);
    this.pending.delete(project.path);
    return owner;
  }

  /** Forgets an owner read during an `add` once the project is stored with it. */
  settled(path: string): void { this.pending.delete(path); }

  /**
   * The Runner the daemon's code gets in the Docker runtime. git with a working folder runs in a helper
   * that mounts the project holding that folder, as the folder's owner. Any other command with a working
   * folder would need the project's files, which the control service does not have: refused. Commands
   * without one (docker itself) run here.
   */
  runner(): Runner {
    const wrapped: Runner = async (cmd, args, opts = {}) => {
      if (!opts.cwd) return this.deps.run(cmd, args, opts);
      // A helper mounts one project (and its lanes folder). Worktrees the owner keeps anywhere else look
      // missing from inside it, and prune would delete their records from the owner's repository.
      if (cmd === "git" && args.includes("worktree") && args[args.indexOf("worktree") + 1] === "prune")
        throw new Refused("git worktree prune is never run from a helper container: it would drop the records of worktrees the helper cannot see.", 400, "no_prune");
      if (cmd !== "git") throw new Refused(`${cmd} would run in ${opts.cwd}, which the control service cannot see. In the Docker setup it runs in the lane's container; this one arrives in a later v4 phase.`, 501, "not_yet");
      const cwd = posix.normalize(opts.cwd);
      const known = [...this.deps.store.listProjects(), ...[...this.pending.keys()].map((path) => ({ id: "", path, owner: this.pending.get(path)! }))];
      const inside = (root: string) => cwd === root || cwd.startsWith(`${root}/`);
      // A lane checkout (in <project>.lanes) needs the project too: its .git file points at <project>/.git.
      const project = known.filter((p) => inside(p.path) || inside(lanesFolder(p.path))).sort((a, b) => b.path.length - a.path.length)[0];
      if (!project) throw new Refused(`${cwd} is not inside a project, so no helper container may mount it.`, 400, "not_a_project");
      const owner = project.id ? await this.ownerOf(project) : project.owner!;
      const timeout = opts.timeout === undefined ? {} : { timeout: opts.timeout };
      if (inside(project.path)) return this.helper(gitArgv(this.control().image, this.checkPath(project.path), cwd, owner, args, opts.env), timeout);
      // In a lane checkout: start in <project>.lanes and let git change folder (-C). Docker would create a
      // missing working folder, and on a bind mount that is a folder on the host.
      // UNVERIFIED: that docker run -w creates a missing folder through a bind mount (from memory); -C is safe either way.
      const lanes = this.checkPath(lanesFolder(project.path));
      return this.helper(gitArgv(this.control().image, this.checkPath(project.path), lanes, owner, cwd === lanes ? args : ["-C", cwd, ...args], opts.env, helperName(), [lanes]), timeout);
    };
    return wrapped;
  }
}
