import { z } from "zod";
import type { ProjectOwner } from "@contextlanes/protocol";
import { Refused } from "../lanes/manager.js";
import { MAX_BYTES, type FoundFile } from "../recipes.js";
import { folderMount, helperBase, helperName } from "./folders.js";

/**
 * A lane's app in the Docker runtime (docs/V4.md 3.4): the control service cannot see a checkout, so the
 * recipe is read inside the lane (or, for the project's own, by a helper that mounts only the project,
 * read-only), and files the recipe copies from the main checkout go across in a helper that mounts the
 * project read-only and the lane's checkout, nothing else.
 */

/**
 * Prints the first of the files named that exists, as `file <name>` and its first MAX_BYTES + 1 bytes in
 * base64, or `link <name>` / `other <name>` for a symbolic link or something that is not a regular file
 * (never followed). Nothing at all when none is there. POSIX sh, head and base64 (coreutils).
 */
export const READ_SH = `for f in "$@"; do
  if [ -L "$f" ]; then printf 'link %s\\n' "$f"; exit 0; fi
  if [ -f "$f" ]; then printf 'file %s\\n' "$f"; head -c ${MAX_BYTES + 1} -- "$f" | base64; exit 0; fi
  if [ -e "$f" ]; then printf 'other %s\\n' "$f"; exit 0; fi
done
exit 0`;

/** READ_SH's answer, checked at the edge: only a file that was asked for, only base64 after it. */
export function parseFound(stdout: string, asked: readonly string[]): FoundFile | null {
  const text = stdout.replace(/\r/g, "");
  if (!text.trim()) return null;
  const nl = text.indexOf("\n");
  const head = nl < 0 ? text : text.slice(0, nl);
  const m = /^(file|link|other) (.+)$/.exec(head);
  if (!m || !asked.includes(m[2]!)) throw new Refused(`Reading the recipe gave an answer that is not one (${head.slice(0, 120)}).`, 502, "recipe_unreadable");
  const body = nl < 0 ? "" : text.slice(nl + 1).replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(body)) throw new Refused("Reading the recipe gave bytes that are not base64.", 502, "recipe_unreadable");
  const data = Buffer.from(body, "base64").subarray(0, MAX_BYTES + 1);
  return { file: m[2]!, kind: m[1] as FoundFile["kind"], data: m[1] === "file" ? data : Buffer.alloc(0) };
}

/** A no-network, no-capability, read-only helper that reads the files in the project folder, as its owner. */
export function readProjectArgv(image: string, project: string, owner: ProjectOwner, files: readonly string[], name = helperName()): string[] {
  return [...helperBase(name), "--read-only", "--user", `${owner.uid}:${owner.gid}`, ...folderMount(project, true), "-w", project, "--entrypoint", "sh", image, "-c", READ_SH, "sh", ...files];
}

/**
 * Copies the main checkout's ignored files that match the recipe's `copy` patterns into the lane's
 * checkout, never over a file there (as v3 did on the host). Paths with a symbolic link anywhere in the
 * main checkout are skipped. Run in a helper whose only writable mount is the lane's checkout, so a link
 * the lane's agent placed there can lead nowhere else. Prints the files copied as JSON.
 * process.argv: [node, project, checkout, ...patterns].
 */
export const COPY_JS = `const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const [project, checkout, ...patterns] = process.argv.slice(1);
const listed = execFileSync("git", ["ls-files", "--others", "--ignored", "--exclude-standard", "-z", "--", ...patterns.map((p) => ":(glob)" + p)], { cwd: project, maxBuffer: 16 * 1024 * 1024 });
const copied = [];
for (const file of listed.toString("utf8").split("\\0").filter(Boolean)) {
  if (file.startsWith("/") || file.split("/").includes("..")) continue;
  let at = project, linked = false;
  for (const part of file.split("/")) { at = path.join(at, part); if (fs.lstatSync(at).isSymbolicLink()) { linked = true; break; } }
  if (linked || !fs.lstatSync(path.join(project, file)).isFile()) continue;
  const target = path.join(checkout, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  try { fs.copyFileSync(path.join(project, file), target, fs.constants.COPYFILE_EXCL); } catch (err) { if (err.code !== "EEXIST") throw err; }
  copied.push(file);
}
process.stdout.write(JSON.stringify(copied));`;

export function copyIgnoredArgv(image: string, project: string, checkout: string, owner: ProjectOwner, patterns: readonly string[], name = helperName()): string[] {
  // UNVERIFIED: that `node -e <script> a b` gives the script process.argv [node, a, b] (from memory; true for Node 18 to 24).
  return [...helperBase(name), "--read-only", "--tmpfs", "/tmp", "--user", `${owner.uid}:${owner.gid}`,
    "-e", "HOME=/tmp", "-e", "GIT_CONFIG_NOSYSTEM=1", "-e", "GIT_OPTIONAL_LOCKS=0", "-e", "GIT_TERMINAL_PROMPT=0",
    ...folderMount(project, true), ...folderMount(checkout), "-w", project, "--entrypoint", "node", image, "-e", COPY_JS, project, checkout, ...patterns];
}

export const Copied = z.array(z.string().max(4096)).max(100_000);
