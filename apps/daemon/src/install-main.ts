import { realpath, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { installService } from "./install.js";
import { MANAGED_MARKER, layoutOf, setLink } from "./layout.js";
import { runCommand } from "./run.js";

/**
 * install.sh sets CONTEXTLANES_MANAGED=1: the service and commands then run <base>/current, which
 * `contextlanes update` moves from release to release. A plain source checkout runs from itself.
 */
const release = await realpath(fileURLToPath(new URL("../../../", import.meta.url)));
let root = release;
if (process.env.CONTEXTLANES_MANAGED === "1") {
  const layout = await layoutOf(release, homedir());
  await writeFile(join(layout.base, MANAGED_MARKER), "");
  await setLink(layout.current, release);
  // A branch chosen at install time is the one `contextlanes update` follows; otherwise it follows
  // the repository's default branch.
  const branch = process.env.CONTEXTLANES_BRANCH;
  if (branch) await writeFile(join(layout.base, "update.json"), `${JSON.stringify({ branch, history: [] }, null, 2)}\n`, { mode: 0o600 });
  root = layout.current;
}
await installService({ root, home: homedir(), node: process.execPath, run: runCommand });
console.log("Installed. Run ~/.local/bin/contextlanes setup for the single-use sign-in URL and QR code.");
