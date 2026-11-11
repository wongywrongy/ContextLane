import { posix } from "node:path";
import { Refused } from "../lanes/manager.js";
import { SOCKET } from "./names.js";

/** Host folders that are never a project: the kernel's and the system's own, where a mount would mean the machine. */
const SYSTEM = ["/proc", "/sys", "/dev", "/run", "/var/run", "/boot", "/etc", "/var/lib/docker"];

/** A project path the Docker runtime refuses, and why. Code reads `code`; people read `message`. */
export class PathRefused extends Refused {
  constructor(message: string) { super(message, 400, "bad_path"); }
}

const under = (path: string, root: string) => path === root || path.startsWith(`${root}/`);

/**
 * Checks a host folder before any helper container mounts it. The control service cannot look at the host,
 * so this is all text: an absolute, already normal path, not `/`, not a system folder, and neither inside
 * nor above anything the helper must not see (the stack's data folder, the Docker socket). Commas and
 * quotes are refused because `docker run --mount` reads its value as CSV. Returns the path unchanged.
 *
 * Docker follows a symlink in a bind source on the host, and this sees only the text: a link is mounted as
 * the folder it points to. That folder must still pass the git check in folders.ts (a repository's top
 * with its own .git), and only the owner can add a project.
 */
export function checkProjectPath(path: string, protect: { data: string | null; socket?: string }): string {
  const refuse = (message: string) => { throw new PathRefused(message); };
  if (typeof path !== "string" || !path) refuse("Give the folder's full path.");
  if (path.length > 4000) refuse("That path is too long.");
  if (/[\u0000-\u001f\u007f]/.test(path)) refuse("That path contains control characters.");
  if (path.startsWith("~")) refuse("Give the folder's full path, starting with /. The control service runs in a container and cannot expand ~.");
  if (!path.startsWith("/")) refuse("Give the folder's full path, starting with /.");
  if (posix.normalize(path) !== path || (path.length > 1 && path.endsWith("/"))) refuse(`Give the path without "..", "." or repeated or trailing slashes: ${posix.normalize(path).replace(/(.)\/$/, "$1")}`);
  if (/[,"]/.test(path)) refuse("Folders whose path contains a comma or a double quote cannot be mounted into a container. Rename or move the folder.");
  if (path === "/") refuse("The root folder cannot be a project.");
  for (const root of SYSTEM) if (under(path, root)) refuse(`${root} is a system folder and cannot be a project.`);
  const sockets = [...new Set([SOCKET, "/run/docker.sock", protect.socket].filter((s): s is string => !!s))];
  for (const socket of sockets) if (under(socket, path)) refuse(`${path} holds the Docker socket (${socket}), which no helper container may see.`);
  if (under("/var/lib/docker", path)) refuse(`${path} holds Docker's own data (/var/lib/docker), which no helper container may see.`);
  if (protect.data) {
    if (under(path, protect.data)) refuse(`${path} is inside ContextLanes' own data folder (${protect.data}).`);
    if (under(protect.data, path)) refuse(`${path} holds ContextLanes' own data folder (${protect.data}), which no helper container may see. Add a folder that does not contain the stack.`);
  }
  return path;
}
