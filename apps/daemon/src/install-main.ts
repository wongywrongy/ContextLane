import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { installService } from "./install.js";
import { runCommand } from "./run.js";

await installService({ root: fileURLToPath(new URL("../../../", import.meta.url)), home: homedir(), node: process.execPath, run: runCommand });
console.log("Installed. Run ~/.local/bin/contextlanes setup for the URL and claim code.");
console.log("To keep user services running after logout: sudo loginctl enable-linger \"$USER\"");
