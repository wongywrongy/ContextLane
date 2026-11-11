import type { Config } from "../config.js";
import { Refused } from "../lanes/manager.js";

const SKILLS = "Project skills are copied from the project's files, which the Docker setup does not do yet (a later v4 phase).";
const REVIEW = "Review, checkpoints, diffs and hand-offs read the lane's files, and do not run in the Docker setup yet (a later v4 phase). Look at the lane's branch from the host.";

/**
 * Routes that read or write a project's files, or the machine's home folder, directly. In the Docker
 * runtime the control service has neither, so until the phase that moves each one into a container they
 * answer 501 `not_yet` instead of half working. Matched against the registered route pattern.
 */
const NOT_YET: [RegExp, string][] = [
  [/^\/api\/projects\/:project\/skills(\/|$)/, SKILLS],
  [/^\/api\/lanes\/:project\/:n\/(diff|files|checkpoint|approve|cleanup|fork|handoff|request-changes)$/, REVIEW],
  [/^\/api\/setup\/projects\/(scan|folders)$/, "The control service cannot browse this machine's folders. In the repository: contextlanes add"],
  [/^\/api\/setup\/github\/clone$/, "Cloning from the control service arrives in a later v4 phase. Clone on the host, then: contextlanes add"],
];

/** Lane tools (the MCP toolbox and the lane's own `contextlanes`) that need review or the checkout's files from the control side. */
const TOOLS_NOT_YET = new Set(["checkpoint", "split_lanes", "get_brief", "delegate"]);

/** Throws for a route the Docker runtime does not do yet; nothing in the host runtime. */
export function refuseInDocker(config: Config, _method: string, route: string | undefined): void {
  if (config.runtime.mode !== "docker" || !route) return;
  const hit = NOT_YET.find(([pattern]) => pattern.test(route));
  if (hit) throw new Refused(hit[1], 501, "not_yet");
}

/** The same for one lane tool, called by the tool route. */
export function refuseToolInDocker(config: Config, tool: string): void {
  if (config.runtime.mode !== "docker" || !TOOLS_NOT_YET.has(tool)) return;
  throw new Refused(REVIEW, 501, "not_yet");
}
