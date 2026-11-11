import { posix } from "node:path";
import { UsageError } from "./client.js";

/**
 * The folder this command was run in. On the host that is the process's own folder. In the Docker setup
 * the command runs inside the control container, where the host's folder does not exist, so the host
 * command (install-command) passes it as text in CONTEXTLANES_CWD. That is the one input for it: lane
 * numbers, `new "<task>"`, `add` and the menus all read it from here. It must be an absolute, normal path.
 */
export function hereFolder(env: Record<string, string | undefined> = process.env, cwd: () => string = () => process.cwd()): string {
  const given = env.CONTEXTLANES_CWD;
  if (given === undefined || given === "") return cwd();
  if (given.length > 4000 || /[\u0000-\u001f\u007f]/.test(given) || !given.startsWith("/") || posix.normalize(given) !== given || (given.length > 1 && given.endsWith("/")))
    throw new UsageError(`CONTEXTLANES_CWD must be an absolute path without "..", "." or repeated or trailing slashes; it was ${JSON.stringify(given.slice(0, 200))}.`);
  return given;
}

/** A folder named on the command line: absolute as given, relative to where the command was run otherwise. */
export function folderArg(folder: string | undefined, here: string): string {
  if (!folder) return here;
  if (folder.startsWith("/") || folder.startsWith("~")) return folder;
  return posix.resolve(here, folder);
}
