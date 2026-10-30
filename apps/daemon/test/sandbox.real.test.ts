import { describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { checkSandbox, Config, runCommand, sandbox, serviceArgs } from "@contextlanes/daemon";

const exec = promisify(execFile);
const enabled = process.env.CONTEXTLANES_REAL_SANDBOX === "1";

/** Runs in a real user unit, the way lane services run. Each probe prints only sealed or open. */
describe.skipIf(!enabled)("real sandbox", () => {
  const inUnit = async (config: Config, script: string) => {
    const { stdout } = await exec("systemd-run", ["--user", "--wait", "--pipe", "--collect", "--quiet", "--", ...sandbox(config), "/bin/sh", "-c", script.replaceAll("$", "$$$$")]);
    return stdout.trim();
  };
  const probe = (test: string) => `if ${test} >/dev/null 2>&1; then echo open; else echo sealed; fi`;

  it("cannot read the owner's token or reach another way out", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "cl-sandbox-")));
    const data = join(root, "data");
    await mkdir(join(data, "releases/r1"), { recursive: true });
    await writeFile(join(data, "setup-token"), "owner-secret");
    await writeFile(join(data, "releases/r1/main.js"), "code");
    const config = Config.parse({ paths: { data, lanes: join(root, "lanes") } });
    try {
      expect(await checkSandbox(runCommand, config)).toBe(true);
      expect(await inUnit(config, probe(`cat ${join(data, "setup-token")}`))).toBe("sealed");
      expect(await inUnit(config, `cat ${join(data, "releases/r1/main.js")}`)).toBe("code");
      expect(await inUnit(config, probe("systemctl --user is-system-running"))).toBe("sealed");
      expect(await inUnit(config, probe("docker version --format x"))).toBe("sealed");
      expect(await inUnit(config, probe("tailscale status"))).toBe("sealed");
      expect(await inUnit(config, probe("tmux list-sessions"))).toBe("sealed");
      const { stdout } = await exec("systemctl", ["--user", "show", "-p", "MainPID", "--value", "dbus.service"]);
      const pid = stdout.trim();
      expect(await inUnit(config, probe(`cat /proc/${pid}/environ`))).toBe("sealed");
      expect(await inUnit(config, probe(`ls /proc/${pid}/root/`))).toBe("sealed");
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 60_000);

  it("wraps a real service the same way", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "cl-sandbox-")));
    const config = Config.parse({ paths: { data: join(root, "data"), lanes: join(root, "lanes") } });
    await mkdir(config.paths.data);
    await writeFile(join(config.paths.data, "setup-token"), "owner-secret");
    const unit = `cl-sandbox-${process.pid}`;
    const out = join(root, "seen");
    try {
      await exec("systemd-run", serviceArgs(unit, root, { name: "web", command: ["/bin/sh", "-c", `cat ${join(config.paths.data, "setup-token")} > ${out} 2>&1; sleep 30`], env: {} } as never, {}, sandbox(config)));
      await new Promise((resolve) => setTimeout(resolve, 500));
      const seen = await exec("cat", [out]);
      expect(seen.stdout).not.toContain("owner-secret");
    } finally {
      await exec("systemctl", ["--user", "stop", unit]).catch(() => {});
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});
