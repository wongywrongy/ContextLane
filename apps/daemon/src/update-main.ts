#!/usr/bin/env node
import { readdir, readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { configPath, loadConfig } from "./config.js";
import { layoutOf } from "./layout.js";
import { runCommand } from "./run.js";
import { Updater, UpdateError } from "./update.js";

/** Run by `contextlanes update` and by install.sh on an existing copy. */
const { values } = parseArgs({
  args: process.argv.slice(2),
  options: { check: { type: "boolean" }, rollback: { type: "boolean" }, yes: { type: "boolean" }, branch: { type: "string" }, adopt: { type: "string" } },
});
const self = await realpath(fileURLToPath(new URL("../../../", import.meta.url)));
const config = loadConfig();
const updater = new Updater({
  run: runCommand, fetch, log: (line) => console.log(line), sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  processes: async () => {
    const lines: string[] = [];
    for (const pid of (await readdir("/proc").catch(() => [])).filter((p) => /^\d+$/.test(p))) {
      lines.push(await readFile(`/proc/${pid}/cmdline`, "utf8").then((s) => s.replace(/\0/g, " "), () => ""));
    }
    return lines;
  },
  home: homedir(), node: process.execPath, layout: await layoutOf(self, homedir()),
  data: config.paths.data, port: config.listen.port, config: configPath(),
});
try {
  process.exitCode = values.rollback ? await updater.rollback({ yes: values.yes ?? false })
    : values.adopt ? await updater.adopt(await realpath(values.adopt))
    : await updater.update({ check: values.check ?? false, ...(values.branch ? { branch: values.branch } : {}) });
} catch (err) {
  console.error(err instanceof UpdateError ? err.message : `The update stopped unexpectedly: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
}
