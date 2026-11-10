// Prints the npm packages for the agents that run as their own CLI in a lane, at the versions pinned
// in packages/protocol. Used by the Dockerfile so the image and the host install agree.
import { AGENTS } from "../packages/protocol/dist/index.js";

const wanted = new Set(["claude-code", "codex"]);
const packages = AGENTS.filter((agent) => wanted.has(agent.id)).flatMap((agent) => "npm" in agent.install ? agent.install.npm : []);
if (!packages.length) { console.error("No agent packages found in packages/protocol."); process.exit(1); }
console.log(packages.join(" "));
