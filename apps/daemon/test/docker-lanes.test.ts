import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Lane } from "@contextlanes/protocol";
import { buildServer, Config, EventBus, HostLinks, LaneManager, Store, confineGit } from "@contextlanes/daemon";
import { DockerFolders } from "../src/docker/folders.js";
import { DockerLanes, laneConfig, parseUp, unsafeConfig } from "../src/docker/lanes.js";
import { CliInputs } from "../src/lanes/input.js";
import { SetupManager } from "../src/setup.js";
import { CONTROL, laneDocker, type DockerCall } from "./docker-fakes.js";

const cleanups: (() => Promise<unknown> | void)[] = [];
afterEach(async () => { for (const clean of cleanups.splice(0).reverse()) await clean(); });
const temp = async () => { const dir = await mkdtemp(join(tmpdir(), "cl-dlanes-")); cleanups.push(() => rm(dir, { recursive: true, force: true })); return dir; };

const P = "/home/kyle/code/shop";
const WT = `${P}.lanes/01-fix-login`;
const PASSWD = "root:x:0:0:root:/root:/bin/bash\nnode:x:1000:1000::/home/node:/bin/bash\n";

async function setup(o: Parameters<typeof laneDocker>[0] = {}, owner = { uid: 1000, gid: 1000 }, settings: Record<string, unknown> = {}) {
  const root = await temp();
  const config = Config.parse({ runtime: { mode: "docker" }, paths: { data: join(root, "data"), lanes: join(root, "lanes") }, ...settings });
  const store = Store.open(":memory:"); cleanups.push(() => store.close());
  const { run: docker, calls } = laneDocker({ owner: `${owner.uid}:${owner.gid}`, ...o });
  const folders = new DockerFolders({ run: docker, control: CONTROL, store });
  const git = confineGit(folders.runner(), config);
  const bus = new EventBus();
  const files: Record<string, string> = {};
  const dockerLanes = new DockerLanes({ docker, git, folders, store, bus, config, control: () => CONTROL, socketGid: async () => 999, passwd: async () => PASSWD,
    dataFile: async (name, content) => { files[name] = content; return `/opt/stacks/contextlanes/data/${name}`; } });
  const lanes = new LaneManager({ store, bus, config, run: git, docker: dockerLanes });
  store.addProject({ id: "shop", name: "shop", path: P, owner });
  return { config, store, bus, calls, docker, git, folders, dockerLanes, lanes, files, root };
}

/** A short name for each docker call, to check the order of the steps. */
function kind(c: DockerCall): string {
  const a = c.args;
  if (a[0] === "run") {
    const e = a[a.indexOf("--entrypoint") + 1];
    if (e === "git") { const rest = a.slice(a.indexOf("--entrypoint") + 3).filter((x, i, all) => !(x === "-c" || all[i - 1] === "-c" || x === "-C" || all[i - 1] === "-C")); return `git ${rest.slice(0, 2).join(" ")}`; }
    if (a.includes("devcontainer")) return a.includes("read-configuration") ? "devcontainer read-configuration" : "devcontainer up";
    if (a.includes("-v")) return "lanes folder";
    return "look";
  }
  if (a[0] === "exec") {
    const at = a.findIndex((x) => x.startsWith("cl-shop-"));
    const argv = a.slice(at + 1);
    if (argv[0] === "tmux") return `tmux ${argv[3]}`;
    if (argv[0] === "sh" && argv[2]?.includes("cat >")) return `write ${argv[4]}`;
    if (argv[0] === "sh" && argv[2]?.includes("chown")) return "prepare";
    if (argv[0] === "sh" && argv[2]?.includes("id -u")) return "ids";
    return `exec ${argv[0]}`;
  }
  return a.slice(0, 2).join(" ");
}
const execs = (calls: DockerCall[]) => calls.filter((c) => c.args[0] === "exec");

describe("lane create in the Docker runtime", () => {
  it("makes checkout, container, mounts, network and terminal in that order, and the lane works", async () => {
    const { lanes, calls, store } = await setup();
    const lane = await lanes.start({ project: "shop", task: "Fix login", kind: "shell" });
    expect(lane).toMatchObject({ state: "working", branch: "lane/01-fix-login", worktree: WT, terminal: "cl-shop-01", hostUnit: null });
    expect(calls.map(kind)).toEqual([
      "ps -a", "git worktree list", "git branch --list",
      "lanes folder", "git rev-parse --verify", "git worktree add",
      "look", "devcontainer up",
      "inspect --type", "ids", "prepare",
      "network connect",
      "tmux new-session", "tmux set-option",
    ]);
    expect(store.eventsOfType(["lane.container"], { lanes: [lane.id] }).map((e) => e.payload)).toEqual([
      { state: "creating", name: "cl-shop-01" },
      { state: "running", name: "cl-shop-01", id: "f00dfeed1234", user: "vscode", uid: 1000, gid: 1000, path: "/opt/contextlanes/bin:/usr/local/bin:/usr/bin:/bin", image: "vsc-01-fix-login-0123abcd-uid" },
    ]);
  });

  it("gives the Docker socket to the Dev Container CLI helper only, run as the folder's owner with the socket's group", async () => {
    const { lanes, calls } = await setup();
    await lanes.start({ project: "shop", task: "Fix login", kind: "shell" });
    const up = calls.find((c) => kind(c) === "devcontainer up")!.args;
    expect(up.slice(0, 2)).toEqual(["run", "--rm"]);
    expect(up).toEqual(expect.arrayContaining(["--label", "contextlanes.helper=1", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--user", "1000:1000", "--group-add", "999", "-e", "HOME=/tmp",
      "-v", "/var/run/docker.sock:/var/run/docker.sock", "--mount", `type=bind,source=${WT},target=${WT}`, "--mount", `type=bind,source=${P}/.git,target=${P}/.git`, "--entrypoint", "sh", "sha256:image"]));
    // uid 1000 has a passwd entry in the control image (node): nothing extra is mounted.
    expect(up.join(" ")).not.toContain("/etc/passwd");
    const cli = up.slice(up.indexOf("devcontainer", up.indexOf("-c")) + 1);
    expect(cli).toEqual(["up", "--workspace-folder", WT, "--override-config", "/tmp/contextlanes/devcontainer.json",
      "--id-label", "contextlanes.lane=shop/01", "--id-label", "contextlanes.project=shop", "--id-label", expect.stringMatching(/^contextlanes\.instance=[0-9a-f]{12}$/),
      "--mount", `type=bind,source=${P}/.git,target=${P}/.git`, "--mount", "type=volume,source=contextlanes-agent-home-1000,target=/opt/contextlanes-home",
      "--remote-env", "PATH=/opt/contextlanes/bin:${containerEnv:PATH}", "--update-remote-user-uid-default", "on", "--remove-existing-container", "--no-lockfile", "--log-format", "text"]);
    const config = JSON.parse(up.find((a) => a.startsWith("CL_CONFIG="))!.slice("CL_CONFIG=".length)) as Record<string, unknown>;
    expect(config).toEqual({ name: "cl-shop-01", image: "mcr.microsoft.com/devcontainers/base:bookworm", remoteUser: "vscode", updateRemoteUserUID: true,
      workspaceMount: `type=bind,source=${WT},target=${WT}`, workspaceFolder: WT, mounts: ["type=volume,source=contextlanes-tools,target=/opt/contextlanes,readonly"], runArgs: ["--name", "cl-shop-01"] });
    // No other call mentions the socket; nothing is ever privileged; ./data reaches no container.
    expect(calls.filter((c) => c.args.join(" ").includes("docker.sock"))).toHaveLength(1);
    expect(calls.some((c) => c.args.includes("--privileged"))).toBe(false);
    expect(calls.some((c) => c.args.join(" ").includes("/opt/stacks/contextlanes/data"))).toBe(false);
    // Every other helper has no network; the git and look helpers mount the project and its lanes folder only.
    for (const c of calls.filter((c) => c.args[0] === "run" && !c.args.includes("devcontainer"))) expect(c.args).toEqual(expect.arrayContaining(["--network", "none", "--cap-drop", "ALL"]));
    const add = calls.find((c) => kind(c) === "git worktree add")!.args;
    expect(add).toEqual(expect.arrayContaining(["--user", "1000:1000", "--mount", `type=bind,source=${P},target=${P}`, "--mount", `type=bind,source=${P}.lanes,target=${P}.lanes`, "-w", `${P}.lanes`, "-C", P, "worktree", "add", "-b", "lane/01-fix-login", WT, "main", "core.hooksPath=/dev/null"]));
    const folder = calls.find((c) => kind(c) === "lanes folder")!.args;
    expect(folder).toEqual(expect.arrayContaining(["--user", "0:0", "--cap-add", "CHOWN", "-v", `${P}.lanes:${P}.lanes`, `${P}.lanes`, "1000:1000"]));
  });

  it("runs every command in the lane as its user, in the checkout, with PATH, the agent homes and the lane's variables", async () => {
    const { lanes, calls } = await setup();
    await lanes.start({ project: "shop", task: "Fix login", kind: "shell" });
    const env = ["-e", "PATH=/opt/contextlanes/bin:/usr/local/bin:/usr/bin:/bin", "-e", "TERM=xterm-256color", "-e", "CLAUDE_CONFIG_DIR=/opt/contextlanes-home/claude", "-e", "CODEX_HOME=/opt/contextlanes-home/codex",
      "-e", "CONTEXTLANES_LANE=shop/01", "-e", "CONTEXTLANES_URL=http://contextlanes:4600"];
    for (const c of execs(calls)) {
      expect(c.args).toEqual(expect.arrayContaining(env));
      if (kind(c) === "prepare") expect(c.args.slice(1, 5)).toEqual(["-u", "0", "-w", "/"]);
      else expect(c.args.slice(1, 5)).toEqual(["-u", "vscode", "-w", WT]);
    }
    const tmux = calls.find((c) => kind(c) === "tmux new-session")!.args;
    expect(tmux.slice(tmux.indexOf("cl-shop-01"))).toEqual(["cl-shop-01", "tmux", "-L", "contextlanes", "new-session", "-d", "-s", "cl-shop-01", "-x", "200", "-y", "50", "-c", WT]);
    const prepare = calls.find((c) => kind(c) === "prepare")!.args;
    expect(prepare.slice(-4)).toEqual(["sh", "/opt/contextlanes-home", "1000:1000", "/var/lib/contextlanes-lane"]);
    expect(calls.find((c) => kind(c) === "network connect")!.args).toEqual(["network", "connect", "--alias", "cl-shop-01", "contextlanes", "f00dfeed1234"]);
  });

  it("starts Claude Code from the tools volume with hooks and the toolbox, and never puts the token in an argument", async () => {
    const { lanes, calls, store } = await setup();
    const lane = await lanes.start({ project: "shop", task: "Fix login", agent: "claude-code" });
    expect(lane.state).toBe("working");
    const writes = Object.fromEntries(calls.filter((c) => kind(c).startsWith("write ")).map((c) => [kind(c).slice(6), c.input!]));
    expect(Object.keys(writes)).toEqual(["/var/lib/contextlanes-lane/token", "/var/lib/contextlanes-lane/agent/task.md", "/var/lib/contextlanes-lane/agent/hooks.json", "/var/lib/contextlanes-lane/agent/mcp.json", "/var/lib/contextlanes-lane/agent/launch.json"]);
    const token = writes["/var/lib/contextlanes-lane/token"]!;
    expect(store.laneForToken(token)).toBe("shop/01");
    expect(calls.some((c) => c.args.join(" ").includes(token))).toBe(false);
    const hooks = JSON.parse(writes["/var/lib/contextlanes-lane/agent/hooks.json"]!) as { hooks: Record<string, { hooks: { command: string }[] }[]> };
    expect(hooks.hooks.PermissionRequest![0]!.hooks[0]!.command).toBe("'/opt/contextlanes/bin/node' '/opt/contextlanes/cli/hook.mjs' PermissionRequest");
    expect(JSON.parse(writes["/var/lib/contextlanes-lane/agent/mcp.json"]!)).toMatchObject({ mcpServers: { contextlanes: { command: "/opt/contextlanes/bin/node", args: ["/opt/contextlanes/cli/toolbox.mjs"] } } });
    const launch = JSON.parse(writes["/var/lib/contextlanes-lane/agent/launch.json"]!) as { command: string; args: string[]; env: Record<string, string> };
    expect(launch.command).toBe("claude");
    expect(launch.args).toEqual(expect.arrayContaining(["--settings", "/var/lib/contextlanes-lane/agent/hooks.json", "--mcp-config", "/var/lib/contextlanes-lane/agent/mcp.json", "--permission-mode", "manual", "--", "Fix login"]));
    expect(launch.env).toMatchObject({ CONTEXTLANES_LANE_TOKEN: token, CONTEXTLANES_URL: "http://contextlanes:4600", PATH: "/opt/contextlanes/bin:/usr/local/bin:/usr/bin:/bin", CLAUDE_CONFIG_DIR: "/opt/contextlanes-home/claude" });
    const respawn = calls.find((c) => kind(c) === "tmux respawn-pane")!.args;
    expect(respawn.slice(respawn.indexOf("respawn-pane"))).toEqual(["respawn-pane", "-k", "-t", "=cl-shop-01:", "-c", WT, "/opt/contextlanes/bin/node", "/opt/contextlanes/cli/cli-agent.mjs", "/var/lib/contextlanes-lane/agent/launch.json"]);
  });

  it("starts Codex with its hooks, MCP entry and notes in the shared CODEX_HOME", async () => {
    const { lanes, calls } = await setup();
    await lanes.start({ project: "shop", task: "Fix login", agent: "codex" });
    const writes = calls.filter((c) => kind(c).startsWith("write ")).map((c) => kind(c).slice(6));
    expect(writes).toEqual(expect.arrayContaining(["/opt/contextlanes-home/codex/hooks.json", "/opt/contextlanes-home/codex/config.toml", "/opt/contextlanes-home/codex/AGENTS.md", "/var/lib/contextlanes-lane/agent/launch.json"]));
    const launch = JSON.parse(calls.find((c) => kind(c) === "write /var/lib/contextlanes-lane/agent/launch.json")!.input!) as { command: string; args: string[] };
    expect(launch.command).toBe("codex");
    expect(launch.args).toEqual(expect.arrayContaining(["--ask-for-approval", "on-request", "-c", 'mcp_servers.contextlanes.command="/opt/contextlanes/bin/node"']));
  });

  it("reads the project's own devcontainer.json through the CLI and keeps its settings, with build paths made absolute", async () => {
    const { lanes, calls } = await setup({ found: ".devcontainer/devcontainer.json", configuration: { build: { dockerfile: "Dockerfile", context: ".." }, remoteUser: "dev", mounts: ["type=volume,source=cache,target=/cache"], runArgs: ["--name=theirs", "--cpus", "2"], configFilePath: { fsPath: "x" } } });
    await lanes.start({ project: "shop", task: "Fix login", kind: "shell" });
    expect(calls.map(kind)).toContain("devcontainer read-configuration");
    const read = calls.find((c) => kind(c) === "devcontainer read-configuration")!.args;
    expect(read.slice(read.indexOf("read-configuration"))).toEqual(["read-configuration", "--workspace-folder", WT]);
    const up = calls.find((c) => kind(c) === "devcontainer up")!.args;
    const config = JSON.parse(up.find((a) => a.startsWith("CL_CONFIG="))!.slice(10)) as Record<string, unknown>;
    expect(config).toEqual({ build: { dockerfile: `${WT}/.devcontainer/Dockerfile`, context: WT }, remoteUser: "dev",
      mounts: ["type=volume,source=cache,target=/cache", "type=volume,source=contextlanes-tools,target=/opt/contextlanes,readonly"], runArgs: ["--cpus", "2", "--name", "cl-shop-01"],
      workspaceMount: `type=bind,source=${WT},target=${WT}`, workspaceFolder: WT });
  });

  it("uses the default image setting from config.toml", async () => {
    const { lanes, calls } = await setup({}, undefined, { lanes: { image: "debian:bookworm", imageUser: "dev" } });
    await lanes.start({ project: "shop", task: "Fix login", kind: "shell" });
    const up = calls.find((c) => kind(c) === "devcontainer up")!.args;
    expect(JSON.parse(up.find((a) => a.startsWith("CL_CONFIG="))!.slice(10))).toMatchObject({ image: "debian:bookworm", remoteUser: "dev" });
  });

  it("gives an owner without a passwd entry one line in a read-only file, and its own agent-login volume", async () => {
    const { lanes, calls, files } = await setup({}, { uid: 1001, gid: 1002 });
    const lane = await lanes.start({ project: "shop", task: "Fix login", kind: "shell" });
    expect(lane.state).toBe("working");
    expect(files["helpers/passwd-1001"]).toBe(`${PASSWD}contextlanes:x:1001:1002:ContextLanes project owner:/tmp:/bin/sh\n`);
    const up = calls.find((c) => kind(c) === "devcontainer up")!.args;
    expect(up).toEqual(expect.arrayContaining(["--user", "1001:1002", "--mount", "type=bind,source=/opt/stacks/contextlanes/data/helpers/passwd-1001,target=/etc/passwd,readonly", "--mount", "type=volume,source=contextlanes-agent-home-1001,target=/opt/contextlanes-home"]));
    expect(calls.find((c) => kind(c) === "prepare")!.args.slice(-2)).toEqual(["1001:1002", "/var/lib/contextlanes-lane"]);
  });

  describe("a failed step removes what the earlier ones made and says which step failed", () => {
    const cases: [string, Parameters<typeof laneDocker>[0], string[]][] = [
      ["checkout", { fail: /worktree add/ }, ["git worktree prune"]],
      ["environment", { fail: /devcontainer up/ }, ["rm --force", "git worktree remove", "git worktree prune", "git branch -D"]],
      ["mounts", { extraMounts: [{ Type: "bind", Source: "/var/run/docker.sock", Destination: "/var/run/docker.sock" }] }, ["image rm", "rm --force", "git worktree remove", "git worktree prune", "git branch -D"]],
      ["mounts", { uid: "1005:1005" }, ["image rm", "rm --force", "git worktree remove", "git worktree prune", "git branch -D"]],
      ["network", { fail: /^network connect/ }, ["image rm", "rm --force", "git worktree remove", "git worktree prune", "git branch -D"]],
      ["terminal", { fail: /new-session/ }, ["image rm", "rm --force", "git worktree remove", "git worktree prune", "git branch -D"]],
    ];
    for (const [step, opts, cleanup] of cases) {
      it(`${step}${opts.uid ? " (lane user is not the owner)" : opts.extraMounts ? " (socket mounted)" : ""}`, async () => {
        const { lanes, calls, store } = await setup(opts);
        const lane = await lanes.start({ project: "shop", task: "Fix login", kind: "shell" });
        expect(lane.state).toBe("failed");
        const failedAt = calls.findIndex((c) => (opts.fail?.test(c.args.join(" ")) ?? false) || (opts.extraMounts && c.args[0] === "inspect") || (opts.uid && kind(c) === "ids"));
        expect(calls.slice(failedAt + 1).map(kind)).toEqual(cleanup);
        const events = store.eventsOfType(["lane.container"], { lanes: [lane.id] });
        expect(events.at(-1)!.payload).toMatchObject({ state: "failed", step, message: expect.any(String) });
        const reason = store.eventsOfType(["lane.state"], { lanes: [lane.id] }).at(-1)!.payload.reason;
        expect(reason).toContain(`at the ${step} step`);
        if (opts.extraMounts) expect(reason).toContain("Docker socket");
        if (opts.uid) expect(reason).toContain("uid 1005");
      });
    }

    it("keeps a branch the lane did not make", async () => {
      const { lanes, calls } = await setup({ fail: /devcontainer up/, worktrees: "" });
      const lane = await lanes.start({ project: "shop", task: "Fix login", kind: "shell", branch: "feature" });
      expect(lane).toMatchObject({ state: "failed", branch: "feature" });
      expect(calls.map(kind)).not.toContain("git branch -D");
      expect(calls.find((c) => kind(c) === "git worktree add")!.args.slice(-2)).toEqual([WT, "feature"]);
    });

    it("refuses a Compose-based devcontainer.json clearly", async () => {
      const { lanes, store } = await setup({ found: ".devcontainer/devcontainer.json", configuration: { dockerComposeFile: "compose.yml", service: "app" } });
      const lane = await lanes.start({ project: "shop", task: "Fix login", kind: "shell" });
      expect(lane.state).toBe("failed");
      expect(store.eventsOfType(["lane.container"], { lanes: [lane.id] }).at(-1)!.payload).toMatchObject({ step: "environment", message: expect.stringContaining("Docker Compose") });
    });
  });

  it("refuses ACP lanes and --here in the Docker runtime", async () => {
    const { lanes } = await setup({}, undefined, { features: { acp: true } });
    await expect(lanes.start({ project: "shop", task: "x", agent: "gemini", kind: "acp" })).rejects.toMatchObject({ code: "needs_systemd" });
    await expect(lanes.start({ project: "shop", task: "x", kind: "shell", direct: true })).rejects.toMatchObject({ code: "not_yet" });
  });

  it("adds a suffix when the container name is already taken", async () => {
    const { lanes } = await setup({ names: "contextlanes\ncl-shop-01\n" });
    expect(await lanes.start({ project: "shop", task: "Fix login", kind: "shell" })).toMatchObject({ terminal: "cl-shop-01-2", worktree: `${WT}-2`, branch: "lane/01-fix-login-2" });
  });
});

describe("devcontainer.json checks", () => {
  it("refuses the socket, privileged containers and turning off seccomp", () => {
    expect(unsafeConfig({ mounts: ["source=/var/run/docker.sock,target=/var/run/docker.sock,type=bind"] })).toContain("socket");
    expect(unsafeConfig({ runArgs: ["--privileged"] })).toContain("privileged");
    expect(unsafeConfig({ privileged: true })).toContain("privileged");
    expect(unsafeConfig({ runArgs: ["--security-opt", "seccomp=unconfined"] })).toContain("seccomp");
    expect(unsafeConfig({ runArgs: ["--cpus", "2"], mounts: [] })).toBeNull();
    expect(() => laneConfig({ name: "n", worktree: "/w", image: "i", imageUser: "u", project: { configuration: { runArgs: ["--privileged"] }, file: "/w/.devcontainer.json" } })).toThrow(/privileged/);
  });

  it("reads the Dev Container CLI's answer from the last JSON line", () => {
    expect(parseUp('log line\n{"outcome":"success","containerId":"abc","remoteUser":"vscode","remoteWorkspaceFolder":"/w"}\n')).toMatchObject({ outcome: "success", containerId: "abc" });
    expect(parseUp("nothing")).toBeNull();
  });
});

describe("lane delete, attach, send and reconcile", () => {
  async function started(o: Parameters<typeof laneDocker>[0] = {}, task: Record<string, unknown> = { kind: "shell" }) {
    const s = await setup(o);
    const lane = await s.lanes.start({ project: "shop", task: "Fix login", ...task });
    s.calls.length = 0;
    return { ...s, lane };
  }

  async function server(s: Awaited<ReturnType<typeof setup>>) {
    const hosts = new HostLinks({ store: s.store, bus: s.bus });
    const setupManager = new SetupManager(s.config, s.store, s.git, { path: join(s.root, "config.toml"), folders: s.folders, home: "/root", find: async () => null });
    await setupManager.initialize();
    const app = buildServer({ config: s.config, store: s.store, bus: s.bus, hosts, lanes: s.lanes, setup: setupManager, run: s.git, version: "test" }); cleanups.push(() => app.close());
    const token = (await readFile(setupManager.controlFile, "utf8")).trim();
    return (method: "GET" | "POST", url: string, payload?: unknown) => app.inject({ method, url, headers: { authorization: `Bearer ${token}` }, ...(payload ? { payload } : {}) });
  }

  it("deletes the container, its image and the checkout, and the branch only when asked", async () => {
    const s = await started({ status: " M a.ts\n" });
    const as = await server(s);
    const preview = await as("GET", "/api/lanes/shop/01/discard");
    expect(preview.json()).toEqual({ uncommitted: 1, commits: 2, branch: "lane/01-fix-login", worktree: WT, present: true });
    const status = s.calls.find((c) => kind(c) === "git status --porcelain")!.args;
    expect(status).toEqual(expect.arrayContaining(["-w", `${P}.lanes`, "-C", WT]));
    s.calls.length = 0;
    const res = await as("POST", "/api/lanes/shop/01/discard", { deleteBranch: true });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ state: "archived" });
    expect(s.calls.map(kind)).toEqual(["rm --force", "image rm", "git worktree remove", "git worktree prune", "git branch -D"]);
    expect(s.calls[0]!.args).toEqual(["rm", "--force", "cl-shop-01"]);
    expect(s.calls[1]!.args).toEqual(["image", "rm", "vsc-01-fix-login-0123abcd-uid"]);
    expect(s.store.eventsOfType(["lane.container"], { lanes: ["shop/01"] }).at(-1)!.payload).toEqual({ state: "removed", name: "cl-shop-01" });
  });

  it("keeps the branch by default and never deletes a branch the lane did not make", async () => {
    const s = await started({}, { kind: "shell", branch: "feature" });
    const as = await server(s);
    expect((await as("POST", "/api/lanes/shop/01/discard", { deleteBranch: true })).json()).toMatchObject({ code: "own_branch" });
    expect(s.calls.map(kind)).not.toContain("rm --force");
    const kept = await as("POST", "/api/lanes/shop/01/discard", {});
    expect(kept.json()).toMatchObject({ state: "archived" });
    expect(s.calls.map(kind)).not.toContain("git branch -D");
  });

  it("never removes a base image", async () => {
    const s = await started({ image: "node:24" });
    const as = await server(s);
    await as("POST", "/api/lanes/shop/01/discard", {});
    expect(s.calls.map(kind)).not.toContain("image rm");
  });

  it("answers contextlanes open with the docker exec -it argv into the lane's tmux", async () => {
    const s = await started();
    const as = await server(s);
    const res = await as("GET", "/api/lanes/shop/01/attach?term=tmux-256color");
    expect(res.json()).toEqual({ runtime: "docker", session: "cl-shop-01", docker: expect.any(Array) });
    const argv = (res.json() as { docker: string[] }).docker;
    expect(argv.slice(0, 7)).toEqual(["exec", "-i", "-t", "-u", "vscode", "-w", WT]);
    expect(argv).toContain("TERM=tmux-256color");
    expect(argv.slice(argv.indexOf("cl-shop-01"))).toEqual(["cl-shop-01", "tmux", "-L", "contextlanes", "attach-session", "-t", "=cl-shop-01"]);
    // A gone tmux session (a restarted container) is started again first.
    expect(s.calls.map(kind)).toEqual(["tmux has-session"]);
  });

  it("delivers a message through a file written in the lane and tmux inside it", async () => {
    const s = await started({}, { agent: "claude-code" });
    const inputs = new CliInputs({ store: s.store, bus: s.bus, config: s.config, run: async () => { throw new Error("no host tmux in the Docker runtime"); }, lanes: s.lanes });
    cleanups.push(() => inputs.close());
    s.bus.publish(s.store.appendEvent("shop/01", { type: "agent.turn", payload: { active: false } }));
    s.bus.publish(s.store.appendEvent("shop/01", { type: "agent.command", payload: { commandId: "6f1d1a52-1df5-4d3e-9a1b-6b0f5b9f6a10", command: { kind: "prompt", text: "Also fix logout", images: [] } } }));
    for (let i = 0; i < 50 && !s.store.eventsOfType(["agent.command.result"], { lanes: ["shop/01"] }).length; i++) await new Promise((r) => setTimeout(r, 20));
    expect(s.store.eventsOfType(["agent.command.result"], { lanes: ["shop/01"] }).at(-1)!.payload).toMatchObject({ ok: true });
    const file = "/var/lib/contextlanes-lane/input-6f1d1a52-1df5-4d3e-9a1b-6b0f5b9f6a10.txt";
    expect(s.calls.map(kind)).toEqual([`write ${file}`, "tmux load-buffer", "tmux paste-buffer", "tmux send-keys", "exec rm", "tmux delete-buffer"]);
    expect(s.calls[0]!.input).toContain("Also fix logout");
  });

  it("finds lane containers again by label: running, stopped and missing, and reports strays", async () => {
    const s = await started();
    const lane = s.store.getLane("shop/01")! as Lane;
    const ps = (state: string) => `f00dfeed1234\tcl-shop-01\t${state}\nabc\tcl-old-07\trunning\n`;
    const again = new DockerLanes({ docker: laneDocker({ ps: ps("running") }).run, git: s.git, folders: s.folders, store: s.store, bus: s.bus, config: s.config, control: () => CONTROL });
    expect(await again.reconcile()).toEqual({ lines: [], strays: ["cl-old-07"], missing: [] });
    const stopped = new DockerLanes({ docker: laneDocker({ ps: ps("exited") }).run, git: s.git, folders: s.folders, store: s.store, bus: s.bus, config: s.config, control: () => CONTROL });
    expect((await stopped.reconcile()).lines).toEqual(["shop/01: container cl-shop-01 stopped"]);
    // Still reachable: the stopped event keeps the container's facts.
    expect(stopped.target(lane)).toMatchObject({ container: "cl-shop-01", user: "vscode" });
    expect((await stopped.reconcile({ record: false })).lines).toEqual([]);
    const gone = new DockerLanes({ docker: laneDocker({ ps: "" }).run, git: s.git, folders: s.folders, store: s.store, bus: s.bus, config: s.config, control: () => CONTROL });
    expect(await gone.reconcile({ record: false })).toMatchObject({ missing: ["shop/01"], lines: [] });
    expect(s.store.getLane("shop/01")!.state).toBe("working");
    expect(await gone.reconcile()).toMatchObject({ missing: ["shop/01"], lines: ["shop/01: container cl-shop-01 missing"] });
    expect(s.store.getLane("shop/01")!.state).toBe("failed");
  });

  it("refuses the lane's app and review in the Docker runtime until their phase", async () => {
    const s = await started();
    const as = await server(s);
    for (const url of ["/api/lanes/shop/01/env", "/api/lanes/shop/01/logs?service=web", "/api/lanes/shop/01/diff"]) expect((await as("GET", url)).json(), url).toMatchObject({ code: "not_yet" });
    // A lane's own token reaches its status but not its app yet.
    const token = s.store.mintLaneToken("shop/01");
    const app = buildServer({ config: s.config, store: s.store, bus: s.bus, hosts: new HostLinks({ store: s.store, bus: s.bus }), lanes: s.lanes, run: s.git, version: "test" }); cleanups.push(() => app.close());
    const tool = await app.inject({ method: "POST", url: "/api/lanes/shop/01/tools/env_start", headers: { authorization: `Bearer ${token}` }, payload: {} });
    expect(tool.json()).toMatchObject({ code: "not_yet" });
  });
});

describe("doctor for lanes", () => {
  it("checks the lane image, the agent-login volumes, and lanes and containers that lost each other", async () => {
    const { dockerChecks } = await import("../src/docker/doctor.js");
    const s = await setup();
    await s.lanes.start({ project: "shop", task: "Fix login", kind: "shell" });
    const fake = laneDocker({ ps: "abc\tcl-old-07\trunning\n" });
    const run: typeof fake.run = async (cmd, args, o) => {
      if (args[0] === "image" && args[1] === "inspect") throw new Error("No such image");
      if (args[0] === "volume") return { stdout: "contextlanes-agent-home-1000\n" };
      if (args[0] === "version") return { stdout: "29.9.3\n" };
      return fake.run(cmd, args, o);
    };
    const lanes = new DockerLanes({ docker: run, git: s.git, folders: s.folders, store: s.store, bus: s.bus, config: s.config, control: () => CONTROL });
    const checks = await dockerChecks(run, { control: () => CONTROL, lanes, config: s.config, toolsMount: s.root, toolsInImage: s.root });
    const check = (id: string) => checks.find((c) => c.id === id);
    expect(check("lane-image")).toMatchObject({ state: "warn", found: expect.stringContaining("mcr.microsoft.com/devcontainers/base:bookworm"), fix: "To pull it now: docker pull mcr.microsoft.com/devcontainers/base:bookworm" });
    expect(check("agent-logins")).toMatchObject({ state: "ok", found: expect.stringContaining("contextlanes-agent-home-1000") });
    expect(check("lanes")).toMatchObject({ state: "warn", found: expect.stringMatching(/cl-old-07.*shop\/01/) });
    // doctor only looks: the lane is not failed by it.
    expect(s.store.getLane("shop/01")!.state).toBe("working");
  });
});
