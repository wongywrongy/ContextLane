import { constants } from "node:fs";
import { lstat, mkdir, open, readlink, realpath, symlink, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { Refused } from "./lanes/manager.js";

/**
 * File access for folders an agent controls (lane checkouts). The daemon runs outside the lane sandbox,
 * so it must not follow a symlink an agent planted to its data or config folder, block on a FIFO, or read
 * a device. Every read resolves the real path, checks it stays inside the folder, opens without following
 * a final symlink and without blocking, and reads only a regular file, at most `max` bytes.
 */
function within(root: string, full: string): boolean { return full === root || full.startsWith(root + sep); }

export async function insideReal(root: string, file: string): Promise<string> {
  const realRoot = await realpath(root);
  const full = await realpath(resolve(realRoot, file)).catch(() => null);
  if (!full || !within(realRoot, full)) throw new Refused(`${file} is not a file inside this checkout.`);
  return full;
}

/** A regular file inside `root`, or null when it is missing, outside, or not a regular file. */
export async function readInside(root: string, file: string, max: number): Promise<{ text: string; size: number } | null> {
  const full = await insideReal(root, file).catch(() => null);
  if (!full) return null;
  const handle = await open(full, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch(() => null);
  if (!handle) return null;
  try {
    const info = await handle.stat();
    if (!info.isFile()) return null;
    const buffer = Buffer.alloc(Math.min(info.size, max));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return { text: buffer.subarray(0, bytesRead).toString("utf8"), size: info.size };
  } finally { await handle.close(); }
}

/**
 * Copies one untracked path from one checkout to another as it is: a symlink stays a symlink (its target is
 * not read), a regular file is copied, anything else is skipped. Returns whether something was copied.
 */
export async function copyInside(fromRoot: string, toRoot: string, file: string): Promise<boolean> {
  const realFrom = await realpath(fromRoot);
  const source = resolve(realFrom, file);
  if (!within(realFrom, source)) return false;
  // Every folder on the way must be a real folder inside the checkout, not a link out of it.
  const parent = await realpath(dirname(source)).catch(() => null);
  if (!parent || !within(realFrom, parent)) return false;
  const target = resolve(toRoot, relative(realFrom, source));
  if (!within(resolve(toRoot), target)) return false;
  const info = await lstat(source).catch(() => null);
  if (!info) return false;
  await mkdirInside(toRoot, dirname(relative(realFrom, source)));
  if (info.isSymbolicLink()) { await symlink(await readlink(source), target); return true; }
  if (!info.isFile()) return false;
  const handle = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (!(await handle.stat()).isFile()) return false;
    await writeFile(target, await handle.readFile(), { mode: info.mode & 0o777, flag: "wx" });
    return true;
  } finally { await handle.close(); }
}

/** Creates `sub` under `root`, refusing when any existing part of it is a symlink. */
export async function mkdirInside(root: string, sub: string): Promise<string> {
  let at = resolve(root);
  for (const part of sub.split(/[\\/]+/).filter((p) => p && p !== ".")) {
    if (part === "..") throw new Refused(`${sub} leaves the checkout.`);
    at = join(at, part);
    const info = await lstat(at).catch(() => null);
    if (info?.isSymbolicLink()) throw new Refused(`${relative(root, at)} is a symlink, so nothing was written through it.`);
    if (!info) await mkdir(at);
    else if (!info.isDirectory()) throw new Refused(`${relative(root, at)} is not a folder.`);
  }
  return at;
}

/** Writes `file` under `root` without following a symlink anywhere on the way, including the file itself. */
export async function writeInside(root: string, file: string, text: string): Promise<void> {
  const dir = await mkdirInside(root, dirname(file));
  const handle = await open(join(dir, file.split(/[\\/]+/).at(-1)!), constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o644)
    .catch((err: NodeJS.ErrnoException) => { throw err.code === "ELOOP" ? new Refused(`${file} is a symlink, so nothing was written through it.`) : err; });
  try { await handle.writeFile(text); } finally { await handle.close(); }
}
