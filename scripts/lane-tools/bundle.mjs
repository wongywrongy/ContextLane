#!/usr/bin/env node
// Builds what lanes run from the tools volume (docs/V4.md 3.3, 8c, 8d): the contextlanes command and the
// MCP toolbox as single files, plus the hook and the agent launcher, which need only Node's built-ins.
// Run after `pnpm build`:   node scripts/lane-tools/bundle.mjs <out-dir>
// The Dockerfile puts <out-dir> at /opt/contextlanes-tools/cli; a lane sees it at /opt/contextlanes/cli,
// read-only, and runs it with the volume's own Node (any glibc image, nothing installed in it).
import { copyFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = fileURLToPath(new URL("../../", import.meta.url));
const out = process.argv[2];
if (!out) { console.error("usage: node scripts/lane-tools/bundle.mjs <out-dir>"); process.exit(2); }
await mkdir(out, { recursive: true });
// Some dependencies are CommonJS and call require(); an ES module bundle gives them one.
const banner = { js: "import { createRequire as __contextlanesRequire } from 'node:module'; const require = __contextlanesRequire(import.meta.url);" };
for (const [entry, file] of [["apps/cli/dist/main.js", "cli.mjs"], ["packages/toolbox/dist/main.js", "toolbox.mjs"]]) {
  await build({ entryPoints: [join(root, entry)], outfile: join(out, file), bundle: true, platform: "node", format: "esm", target: "node22", banner, logLevel: "warning", legalComments: "none" });
}
await copyFile(join(root, "apps/cli/bin/hook.mjs"), join(out, "hook.mjs"));
await copyFile(join(root, "apps/daemon/bin/cli-agent.mjs"), join(out, "cli-agent.mjs"));
console.log(`lane tools written to ${out}: cli.mjs toolbox.mjs hook.mjs cli-agent.mjs`);
