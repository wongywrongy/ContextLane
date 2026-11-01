// This trusted launcher runs outside bubblewrap; only the sandboxed CLI inherits its lane token.
import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
const spec = JSON.parse(readFileSync(process.argv[2], "utf8"));
const child = spawn(spec.command, spec.args, { stdio: "inherit", env: { ...process.env, ...spec.env } });
child.on("error", (err) => { console.error(err.message); process.exitCode = 1; });
child.on("exit", (code) => { process.exitCode = code ?? 1; });
process.on("SIGTERM", () => child.kill("SIGTERM"));
