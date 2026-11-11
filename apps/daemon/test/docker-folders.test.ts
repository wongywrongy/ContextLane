import { describe, expect, it } from "vitest";
import { Config, confineGit, GIT_GUARDS, Store, type Runner } from "@contextlanes/daemon";
import { checkProjectPath } from "../src/docker/paths.js";
import { DockerFolders, gitArgv, statArgv } from "../src/docker/folders.js";
import { parseInspect, inspectSelf } from "../src/docker/control.js";
import { CONTROL, fakeDocker } from "./docker-fakes.js";

describe("project paths in the Docker runtime", () => {
  const ok = (p: string) => checkProjectPath(p, { data: CONTROL.data, socket: CONTROL.socket });
  const refused = (p: string) => { try { ok(p); return null; } catch (err) { return err as { code: string; statusCode: number; message: string }; } };

  it("accepts an absolute, normal path and returns it unchanged", () => {
    expect(ok("/home/kyle/code/ShuttleWorks")).toBe("/home/kyle/code/ShuttleWorks");
    expect(ok("/srv/repos/a b")).toBe("/srv/repos/a b");
  });

  it("refuses relative, ~, .., repeated or trailing slashes, control characters and mount-breaking characters", () => {
    for (const p of ["code/shop", "~/code/shop", "/home/kyle/../root", "/home/kyle/./x", "/home//kyle", "/home/kyle/", "/home/kyle/x\ny", "/home/kyle/a,b", '/home/kyle/a"b', ""]) {
      expect(refused(p), JSON.stringify(p)).toMatchObject({ code: "bad_path", statusCode: 400 });
    }
  });

  it("refuses /, system folders, the Docker socket and the stack's own data folder, above or below", () => {
    for (const p of ["/", "/proc", "/proc/1", "/etc", "/dev/shm", "/run/user/1000", "/var/run", "/var", "/var/lib/docker/volumes", "/var/lib",
      "/opt/stacks/contextlanes/data", "/opt/stacks/contextlanes/data/home", "/opt/stacks/contextlanes", "/opt/stacks", "/opt"]) {
      expect(refused(p), p).toMatchObject({ code: "bad_path" });
    }
    expect(refused("/opt/stacks/contextlanes")!.message).toContain("own data folder");
    expect(refused("/opt/stacks/other")).toBeNull();
  });
});

describe("helper containers", () => {
  it("stat reads the owner as root with only that folder mounted, read-only, no network, no socket", () => {
    expect(statArgv("sha256:image", "/home/kyle/code/shop", "contextlanes-helper-1")).toEqual([
      "run", "--rm", "--name", "contextlanes-helper-1", "--label", "contextlanes.helper=1", "--network", "none", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
      "--read-only", "--user", "0:0", "--mount", "type=bind,source=/home/kyle/code/shop,target=/home/kyle/code/shop,readonly",
      "--entrypoint", "stat", "sha256:image", "-c", "%u:%g", "--", "/home/kyle/code/shop",
    ]);
  });

  it("git runs as the folder's owner with the project at the same path and nothing else", () => {
    const argv = gitArgv("sha256:image", "/home/kyle/code/shop", "/home/kyle/code/shop/src", { uid: 1001, gid: 1002 }, ["status", "--porcelain"], {}, "contextlanes-helper-2");
    expect(argv).toEqual([
      "run", "--rm", "--name", "contextlanes-helper-2", "--label", "contextlanes.helper=1", "--network", "none", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
      "--read-only", "--tmpfs", "/tmp", "--user", "1001:1002", "-e", "HOME=/tmp", "-e", "GIT_CONFIG_NOSYSTEM=1", "-e", "GIT_TERMINAL_PROMPT=0",
      "--mount", "type=bind,source=/home/kyle/code/shop,target=/home/kyle/code/shop", "-w", "/home/kyle/code/shop/src",
      "--entrypoint", "git", "sha256:image", "status", "--porcelain",
    ]);
    const joined = argv.join(" ");
    expect(joined).not.toContain("docker.sock");
    expect(joined).not.toContain("--privileged");
    expect(argv.filter((a) => a === "--mount")).toHaveLength(1);
  });

  it("routes git with a working folder through a helper for the project holding it, with the guards, as its owner", async () => {
    const store = Store.open(":memory:");
    store.addProject({ id: "shop", name: "Shop", path: "/home/kyle/code/shop", owner: { uid: 1001, gid: 1002 } });
    const { run, calls } = fakeDocker();
    const folders = new DockerFolders({ run, control: CONTROL, store });
    const git = confineGit(folders.runner(), Config.parse({ runtime: { mode: "docker" } }));
    await git("git", ["branch", "--show-current"], { cwd: "/home/kyle/code/shop/src", timeout: 5000 });
    const [call] = calls;
    expect(call!.cmd).toBe("docker");
    expect(call!.args.slice(call!.args.indexOf("--entrypoint"))).toEqual(["--entrypoint", "git", "sha256:image", ...GIT_GUARDS, "branch", "--show-current"]);
    expect(call!.args).toEqual(expect.arrayContaining(["--user", "1001:1002", "-w", "/home/kyle/code/shop/src", "--mount", "type=bind,source=/home/kyle/code/shop,target=/home/kyle/code/shop"]));
    expect(call!.args[0]).not.toBe("bwrap");
    // The container start is added to the command's own time.
    expect(call!.timeout).toBe(20_000);
  });

  it("refuses git outside every project, and any other command in a project folder; runs docker itself as it is", async () => {
    const store = Store.open(":memory:");
    store.addProject({ id: "shop", name: "Shop", path: "/home/kyle/code/shop", owner: { uid: 1000, gid: 1000 } });
    const { run, calls } = fakeDocker();
    const r = new DockerFolders({ run, control: CONTROL, store }).runner();
    await expect(r("git", ["status"], { cwd: "/home/kyle/code/other" })).rejects.toMatchObject({ code: "not_a_project" });
    await expect(r("git", ["status"], { cwd: "/home/kyle/code/shopping" })).rejects.toMatchObject({ code: "not_a_project" });
    await expect(r("npm", ["test"], { cwd: "/home/kyle/code/shop" })).rejects.toMatchObject({ code: "not_yet", statusCode: 501 });
    // A helper cannot see the owner's other worktrees, so prune would drop their records.
    await expect(r("git", ["worktree", "prune"], { cwd: "/home/kyle/code/shop" })).rejects.toMatchObject({ code: "no_prune" });
    await expect(r("git", ["-C", "/home/kyle/code/shop", "worktree", "prune", "--expire", "now"], { cwd: "/home/kyle/code/shop" })).rejects.toMatchObject({ code: "no_prune" });
    expect(calls).toEqual([]);
    await r("docker", ["version"]);
    expect(calls).toEqual([{ cmd: "docker", args: ["version"] }]);
  });

  it("reads the owner of a project listed in config.toml once, and records it as a project event", async () => {
    const store = Store.open(":memory:");
    store.addProject({ id: "shop", name: "Shop", path: "/home/kyle/code/shop" });
    const { run, calls } = fakeDocker({ owner: "1005:1006" });
    const r = new DockerFolders({ run, control: CONTROL, store }).runner();
    await r("git", ["status"], { cwd: "/home/kyle/code/shop" });
    await r("git", ["status"], { cwd: "/home/kyle/code/shop" });
    expect(calls.filter((c) => c.args.includes("stat"))).toHaveLength(1);
    expect(store.getProject("shop")!.owner).toEqual({ uid: 1005, gid: 1006 });
    expect(store.projectEvents("shop")).toMatchObject([{ seq: 1, type: "project.owner", payload: { uid: 1005, gid: 1006 } }]);
    expect(calls.at(-1)!.args).toEqual(expect.arrayContaining(["--user", "1005:1006"]));
  });

  it("removes a helper by name when its command is stopped", async () => {
    const calls: string[][] = [];
    const run: Runner = async (cmd, args) => {
      calls.push(args);
      if (args[0] === "run") throw Object.assign(new Error("docker run timed out"), { killed: true, signal: "SIGTERM" });
      return { stdout: "" };
    };
    const store = Store.open(":memory:");
    store.addProject({ id: "shop", name: "Shop", path: "/srv/shop", owner: { uid: 1000, gid: 1000 } });
    await expect(new DockerFolders({ run, control: CONTROL, store }).runner()("git", ["fetch"], { cwd: "/srv/shop" })).rejects.toThrow("timed out");
    const name = calls[0]![calls[0]!.indexOf("--name") + 1]!;
    expect(name).toMatch(/^contextlanes-helper-[0-9a-f]{12}$/);
    expect(calls[1]).toEqual(["rm", "--force", name]);
  });

  it("refuses a subfolder, a worktree or submodule, and a folder that does not exist", async () => {
    const store = Store.open(":memory:");
    const sub = new DockerFolders({ run: fakeDocker({ top: "/srv/shop" }).run, control: CONTROL, store });
    await expect(sub.inspect("/srv/shop/src")).rejects.toMatchObject({ code: "not_a_repository", message: expect.stringContaining("top folder") });
    const worktree = new DockerFolders({ run: fakeDocker({ gitDir: "/srv/shop/.git/worktrees/x" }).run, control: CONTROL, store });
    await expect(worktree.inspect("/srv/x")).rejects.toMatchObject({ code: "not_a_repository" });
    const missing = new DockerFolders({ run: fakeDocker({ fail: /stat/ }).run, control: CONTROL, store });
    await expect(missing.inspect("/srv/gone")).rejects.toMatchObject({ code: "no_folder" });
    const noControl = new DockerFolders({ run: fakeDocker().run, control: () => null, store });
    await expect(noControl.inspect("/srv/shop")).rejects.toMatchObject({ code: "docker_unreachable" });
  });
});

describe("the control container", () => {
  const inspect = JSON.stringify([{
    Id: "c0ffee1234", Name: "/contextlanes", Image: "sha256:abc",
    Config: { Labels: { "contextlanes.control": "1" } },
    Mounts: [{ Type: "bind", Source: "/opt/stacks/contextlanes/data", Destination: "/data" }, { Type: "bind", Source: "/var/run/docker.sock", Destination: "/var/run/docker.sock" },
      { Type: "volume", Name: "contextlanes-tools", Source: "/var/lib/docker/volumes/contextlanes-tools/_data", Destination: "/var/lib/contextlanes-tools" }],
    NetworkSettings: { Ports: { "4600/tcp": null, "4601/tcp": [{ HostIp: "127.0.0.1", HostPort: "4601" }] }, Networks: { contextlanes: {} } },
  }]);

  it("reads its image, data folder, socket, mounts, published ports and networks from docker inspect", () => {
    expect(parseInspect(inspect)).toEqual({
      id: "c0ffee1234", name: "contextlanes", image: "sha256:abc", data: "/opt/stacks/contextlanes/data", socket: "/var/run/docker.sock",
      mounts: [{ type: "bind", source: "/opt/stacks/contextlanes/data", destination: "/data" }, { type: "bind", source: "/var/run/docker.sock", destination: "/var/run/docker.sock" },
        { type: "volume", source: "contextlanes-tools", destination: "/var/lib/contextlanes-tools" }],
      published: [{ port: "4601/tcp", host: "127.0.0.1:4601" }], networks: ["contextlanes"],
    });
  });

  it("finds itself by hostname, then by name, and only with the control label", async () => {
    const asked: string[] = [];
    const run: Runner = async (_cmd, args) => {
      asked.push(args.at(-1)!);
      if (args.at(-1) === "abc123") return { stdout: JSON.stringify([{ Id: "x", Image: "i", Config: { Labels: {} } }]) };
      return { stdout: inspect };
    };
    expect((await inspectSelf(run, "abc123")).name).toBe("contextlanes");
    expect(asked).toEqual(["abc123", "contextlanes"]);
    await expect(inspectSelf(async () => { throw new Error("Cannot connect to the Docker daemon"); }, "h")).rejects.toThrow("Cannot connect to the Docker daemon");
  });
});
