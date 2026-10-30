import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Runner } from "./run.js";

const systemdQuote = (text: string) => `"${text.replace(/%/g, "%%").replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\r/g, "\\r")}"`;
const systemdExecQuote = (text: string) => systemdQuote(text.replace(/\$/g, () => "$$"));
const shellQuote = (text: string) => `'${text.replace(/'/g, "'\\''")}'`;

export async function installService(options: { root: string; home: string; node: string; run: Runner; config?: string }): Promise<void> {
  const { root, home, node, run } = options;
  if (/[\0\r\n]/.test(root)) throw new Error("Use an installation path without line breaks or null characters.");
  const config = options.config ?? join(home, ".config/contextlanes/config.toml");
  const bin = join(home, ".local/bin");
  const unit = join(home, ".config/systemd/user/contextlanes.service");
  const content = `# Installed by ContextLanes\n[Unit]\nDescription=ContextLanes daemon\nAfter=network.target\n\n[Service]\nType=simple\nWorkingDirectory=${root.replace(/%/g, "%%")}\nExecStart=${systemdExecQuote(node)} ${systemdExecQuote(join(root, "apps/daemon/dist/main.js"))}\nEnvironment=${systemdQuote(`CONTEXTLANES_CONFIG=${config}`)}\nEnvironment=${systemdQuote(`PATH=${bin}:${dirname(node)}:/usr/local/bin:/usr/bin:/bin`)}\nRestart=on-failure\nRestartSec=2\nUMask=0077\n\n[Install]\nWantedBy=default.target\n`;
  await mkdir(dirname(unit), { recursive: true, mode: 0o700 });
  await mkdir(bin, { recursive: true });
  await writeOwned(unit, content, 0o600);
  for (const [name, entry] of [["contextlanes", "apps/cli"], ["contextlanes-lanehost", "apps/lanehost"], ["contextlanes-toolbox", "packages/toolbox"]]) {
    const script = `#!/bin/sh\n# Installed by ContextLanes\nexec ${shellQuote(node)} ${shellQuote(join(root, entry!, "dist/main.js"))} "$@"\n`;
    await writeOwned(join(bin, name!), script, 0o755);
  }
  await run("systemctl", ["--user", "daemon-reload"]);
  await run("systemctl", ["--user", "enable", "--now", "contextlanes.service"]);
}
async function writeOwned(path: string, content: string, mode: number): Promise<void> {
  try {
    const current = await readFile(path, "utf8");
    if (current === content) return;
    throw new Error(`Refusing to overwrite ${path}; move it aside before installing`);
  } catch (err) { if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err; }
  await writeFile(path, content, { mode, flag: "wx" });
}
