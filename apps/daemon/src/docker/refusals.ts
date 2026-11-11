import type { Config } from "../config.js";
import { Refused } from "../lanes/manager.js";

/**
 * Routes that read or write a project's files, or the machine's home folder, directly. In the Docker
 * runtime the control service has neither, so until the phase that moves each one into a container they
 * answer 501 `not_yet` instead of half working. Matched against the registered route pattern.
 */
const NOT_YET: [RegExp, string][] = [
  [/^\/api\/lanes$/, "Lanes do not run in the Docker setup yet (v4 phase 3). Projects, branches and doctor work; for lanes use the v3 host install for now."],
  [/^\/api\/projects\/:project\/(recipe|environments|skills)(\/|$)/, "Reading a project's files from the control service arrives with lanes (v4 phase 3)."],
  [/^\/api\/setup\/projects\/(scan|folders)$/, "The control service cannot browse this machine's folders. In the repository: contextlanes add"],
  [/^\/api\/setup\/github\/clone$/, "Cloning from the control service arrives in a later v4 phase. Clone on the host, then: contextlanes add"],
];

/** Throws for a route the Docker runtime does not do yet; nothing in the host runtime. */
export function refuseInDocker(config: Config, method: string, route: string | undefined): void {
  if (config.runtime.mode !== "docker" || !route) return;
  if (route === "/api/lanes" && method !== "POST") return;
  const hit = NOT_YET.find(([pattern]) => pattern.test(route));
  if (hit) throw new Refused(hit[1], 501, "not_yet");
}
