import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const repo = fileURLToPath(new URL("../../../", import.meta.url));
const cleanups: string[] = [];
afterEach(async () => { for (const dir of cleanups.splice(0)) await rm(dir, { recursive: true, force: true }); });

const has = (cmd: string) => spawnSync("sh", ["-c", `command -v ${cmd}`]).status === 0;
const SH = ["install-command", "image/entrypoint.sh", "image/mkwrappers.sh"];
const BASH = ["scripts/v4-check/phase2.sh", "scripts/v4-spike/v4-spike.sh"];

describe("shell scripts", () => {
  it("parse with sh -n and bash -n", () => {
    for (const f of SH) expect(spawnSync("sh", ["-n", join(repo, f)], { encoding: "utf8" }).stderr, f).toBe("");
    for (const f of BASH) expect(spawnSync("bash", ["-n", join(repo, f)], { encoding: "utf8" }).stderr, f).toBe("");
  });

  it.skipIf(!has("shellcheck"))("pass shellcheck", () => {
    const sh = spawnSync("shellcheck", ["-s", "sh", ...SH.map((f) => join(repo, f))], { encoding: "utf8" });
    expect(sh.stdout, sh.stdout).toBe("");
    const bash = spawnSync("shellcheck", [join(repo, "scripts/v4-check/phase2.sh")], { encoding: "utf8" });
    expect(bash.stdout, bash.stdout).toBe("");
  });
});

describe("the host command", () => {
  async function install() {
    const root = await realpath(await mkdtemp(join(tmpdir(), "cl-host-")));
    cleanups.push(root);
    const bin = join(root, "bin"), fake = join(root, "fake"), work = join(root, "work", "shop");
    await mkdir(fake); await mkdir(work, { recursive: true });
    const done = spawnSync("sh", [join(repo, "install-command"), "--to", bin], { encoding: "utf8", env: { ...process.env, PATH: "/usr/bin:/bin" } });
    expect(done.status, done.stderr).toBe(0);
    return { root, bin, fake, work };
  }
  /** A docker that answers inspect with STATE and records exec's arguments, exiting with CODE. */
  async function fakeDocker(dir: string, state: string, code = 0) {
    const script = `#!/bin/sh
if [ "$1" = inspect ]; then [ -n "${state}" ] && echo "${state}"; [ -n "${state}" ]; exit; fi
printf '%s\\n' "$@" > "${dir}/args"
echo out-of-the-container
exit ${code}
`;
    await writeFile(join(dir, "docker"), script);
    await chmod(join(dir, "docker"), 0o755);
  }
  const call = (t: Awaited<ReturnType<typeof install>>, args: string[], pathFirst: string[] = [t.fake]) =>
    spawnSync(join(t.bin, "contextlanes"), args, { cwd: t.work, encoding: "utf8", input: "", env: { ...process.env, PATH: [...pathFirst, "/usr/bin", "/bin"].join(":") } });

  it("runs the command in the control container with this folder as text, plain streams off a terminal, and its exit code", async () => {
    const t = await install();
    await fakeDocker(t.fake, "true 1", 4);
    const done = call(t, ["approve", "2", "--json"]);
    expect(done.status).toBe(4);
    expect(done.stdout).toBe("out-of-the-container\n");
    const args = (await readFile(join(t.fake, "args"), "utf8")).trim().split("\n");
    expect(args).toEqual(["exec", "-i", "-e", `CONTEXTLANES_CWD=${t.work}`, "contextlanes", "contextlanes", "approve", "2", "--json"]);
    expect(args).not.toContain("-t");
  });

  it("exits 3 with a clear message when ContextLanes is not running, is another container, or Docker is missing", async () => {
    const t = await install();
    await fakeDocker(t.fake, "false 1");
    expect(call(t, ["projects"])).toMatchObject({ status: 3, stdout: "", stderr: expect.stringContaining("docker compose up -d") });
    await fakeDocker(t.fake, "");
    expect(call(t, ["projects"])).toMatchObject({ status: 3, stderr: expect.stringContaining("no container named contextlanes") });
    await fakeDocker(t.fake, "true <no value>");
    expect(call(t, ["projects"])).toMatchObject({ status: 3, stderr: expect.stringContaining("not the ContextLanes v4 control service") });
    const empty = join(t.root, "empty"); await mkdir(empty);
    const none = spawnSync("/bin/sh", [join(t.bin, "contextlanes"), "projects"], { cwd: t.work, encoding: "utf8", env: { PATH: empty } });
    expect(none).toMatchObject({ status: 3, stderr: expect.stringContaining("docker command is not installed") });
  });

  it("never overwrites a contextlanes it did not write", async () => {
    const t = await install();
    await writeFile(join(t.bin, "contextlanes"), "#!/bin/sh\necho v3\n");
    const again = spawnSync("sh", [join(repo, "install-command"), "--to", t.bin], { encoding: "utf8" });
    expect(again.status).toBe(1);
    expect(again.stderr).toContain("was not written by install-command");
    expect(await readFile(join(t.bin, "contextlanes"), "utf8")).toContain("echo v3");
  });
});
