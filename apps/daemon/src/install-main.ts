import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { installService } from "./install.js";
import { runCommand } from "./run.js";

await installService({ root: fileURLToPath(new URL("../../../", import.meta.url)), home: homedir(), node: process.execPath, run: runCommand });
console.log("Installed. Run ~/.local/bin/contextlanes setup for the single-use sign-in URL and QR code.");
