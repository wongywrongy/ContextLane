import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, readlink, symlink, type FileHandle } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { Refused } from "./lanes/manager.js";

const DIRECTORY = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const READ = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const fdPath = (handle: FileHandle) => `/proc/self/fd/${handle.fd}`;
const within = (root: string, full: string) => full === root || full.startsWith(root + sep);

function parts(root: string, file: string): string[] {
  const base = resolve(root), full = resolve(base, file);
  if (!within(base, full)) throw new Refused(`${file} leaves the checkout.`);
  return relative(base, full).split(sep).filter(Boolean);
}

/** Linux directory descriptors pin every parent, including the checkout root. No realpath/open gap. */
async function rootHandle(root: string): Promise<FileHandle> {
  let handle = await open("/", DIRECTORY);
  try {
    for (const part of resolve(root).split(sep).filter(Boolean)) {
      const next = await open(join(fdPath(handle), part), DIRECTORY);
      await handle.close(); handle = next;
    }
    return handle;
  } catch (err) { await handle.close(); throw err; }
}

async function directory(root: FileHandle, names: string[], create = false): Promise<FileHandle> {
  let handle = await open(fdPath(root), constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    for (const part of names) {
      const path = join(fdPath(handle), part);
      if (create) await mkdir(path).catch((err: NodeJS.ErrnoException) => { if (err.code !== "EEXIST") throw err; });
      const next = await open(path, DIRECTORY).catch((err: NodeJS.ErrnoException) => {
        if (err.code === "ELOOP" || err.code === "ENOTDIR") throw new Refused(`${part} is a symlink or not a folder, so nothing was written through it.`);
        throw err;
      });
      await handle.close(); handle = next;
    }
    return handle;
  } catch (err) { await handle.close(); throw err; }
}

/** The callback path is a pinned directory, valid only during this callback and only in this process. */
export async function withDirectoryInside<T>(root: string, sub: string, action: (path: string) => Promise<T>, create = false): Promise<T> {
  const names = parts(root, sub), base = await rootHandle(root);
  try {
    const handle = await directory(base, names, create);
    try { return await action(fdPath(handle)); } finally { await handle.close(); }
  } finally { await base.close(); }
}

/** Internal final-file aliases are resolved explicitly; intermediate directories never follow links. */
async function readable(root: string, base: FileHandle, file: string, links = 0): Promise<FileHandle | null> {
  if (links > 40) return null;
  const names = parts(root, file), name = names.pop();
  if (!name) return null;
  const parent = await directory(base, names);
  try {
    const path = join(fdPath(parent), name);
    try {
      const handle = await open(path, READ);
      try {
        if ((await handle.stat()).isFile()) return handle;
      } catch (err) { await handle.close(); throw err; }
      await handle.close(); return null;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ELOOP") throw err;
      const link = await readlink(path);
      const target = isAbsolute(link) ? link : resolve(root, ...names, link);
      // Re-enter through the same pinned root; never open the symlink's target directly.
      return await readable(root, base, target, links + 1);
    }
  } finally { await parent.close(); }
}

/** Reads only a bounded regular file. Missing, unsafe, symlinked-parent and special paths return null. */
export async function readBytesInside(root: string, file: string, max: number): Promise<{ data: Buffer; size: number } | null> {
  const base = await rootHandle(root).catch(() => null);
  if (!base) return null;
  try {
    const handle = await readable(root, base, file).catch(() => null);
    if (!handle) return null;
    try {
      const info = await handle.stat(), buffer = Buffer.alloc(Math.min(info.size, max));
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
        if (!bytesRead) break;
        length += bytesRead;
      }
      return { data: buffer.subarray(0, length), size: info.size };
    } finally { await handle.close(); }
  } finally { await base.close(); }
}

export async function readInside(root: string, file: string, max: number): Promise<{ text: string; size: number } | null> {
  const result = await readBytesInside(root, file, max);
  return result ? { text: result.data.toString("utf8"), size: result.size } : null;
}

/** Copies a regular file or the symlink itself; neither source nor destination follows parent links. */
export async function copyInside(fromRoot: string, toRoot: string, file: string, links = true): Promise<boolean> {
  const names = (() => { try { return parts(fromRoot, file); } catch { return []; } })(), name = names.pop();
  if (!name) return false;
  const sourceRoot = await rootHandle(fromRoot).catch(() => null);
  if (!sourceRoot) return false;
  try {
    const parent = await directory(sourceRoot, names).catch(() => null);
    if (!parent) return false;
    try {
      const source = join(fdPath(parent), name), info = await lstat(source).catch(() => null);
      if (!info) return false;
      if (info.isSymbolicLink()) {
        if (!links) return false;
        const link = await readlink(source);
        await withDirectoryInside(toRoot, names.join(sep), (path) => symlink(link, join(path, name)), true);
        return true;
      }
      if (!info.isFile()) return false;
      const from = await open(source, READ).catch(() => null);
      if (!from) return false;
      try {
        const snapshot = await from.stat();
        if (!snapshot.isFile()) return false;
        await withDirectoryInside(toRoot, names.join(sep), async (path) => {
          const to = await open(join(path, name), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, snapshot.mode & 0o777);
          try {
            // Bounded chunks avoid reading an arbitrarily large untracked file into daemon memory.
            const buffer = Buffer.alloc(64 * 1024);
            let remaining = snapshot.size;
            while (remaining > 0) {
              const { bytesRead } = await from.read(buffer, 0, Math.min(buffer.length, remaining), null);
              if (!bytesRead) break;
              await to.writeFile(buffer.subarray(0, bytesRead));
              remaining -= bytesRead;
            }
          } finally { await to.close(); }
        }, true);
        return true;
      } finally { await from.close(); }
    } finally { await parent.close(); }
  } finally { await sourceRoot.close(); }
}

/** Copies only a regular file, refusing source links and exclusively creating the destination. */
export function copyFileInside(fromRoot: string, toRoot: string, file: string): Promise<boolean> {
  return copyInside(fromRoot, toRoot, file, false);
}

/** An independent dependency copy. Symlinks stay links; regular files never share mutable inodes. */
export async function copyTreeInside(fromRoot: string, toRoot: string, file: string): Promise<boolean> {
  return copyTreeEntry(fromRoot, toRoot, file, false);
}

async function copyTreeEntry(fromRoot: string, toRoot: string, file: string, links: boolean): Promise<boolean> {
  const names = parts(fromRoot, file), name = names.at(-1);
  if (!name) return false;
  const entries = await withDirectoryInside(fromRoot, names.join(sep), (path) => readdir(path)).catch((err: NodeJS.ErrnoException) => {
    if (["ENOTDIR", "ELOOP", "ENOENT"].includes(err.code ?? "") || err instanceof Refused) return null;
    throw err;
  });
  if (!entries) return copyInside(fromRoot, toRoot, file, links).catch((err: NodeJS.ErrnoException) => { if (err.code === "EEXIST") return false; throw err; });
  const made = await withDirectoryInside(toRoot, names.slice(0, -1).join(sep), async (path) => {
    try { await mkdir(join(path, name)); return true; }
    catch (err) { if ((err as NodeJS.ErrnoException).code === "EEXIST") return false; throw err; }
  }, true);
  if (!made) return false;
  for (const entry of entries) await copyTreeEntry(fromRoot, toRoot, join(file, entry), true);
  return true;
}

/** Creates folders safely. Further file operations must use withDirectoryInside, not this returned path. */
export async function mkdirInside(root: string, sub: string): Promise<string> {
  await withDirectoryInside(root, sub, async () => {}, true);
  return resolve(root, sub);
}

/** Writes through pinned parents, checking the final file before truncating it. */
export async function writeInside(root: string, file: string, text: string): Promise<void> {
  const names = parts(root, file), name = names.pop();
  if (!name) throw new Refused(`${file} is not a file inside this checkout.`);
  await withDirectoryInside(root, names.join(sep), async (path) => {
    const handle = await open(join(path, name), constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o644)
      .catch((err: NodeJS.ErrnoException) => { throw err.code === "ELOOP" ? new Refused(`${file} is a symlink, so nothing was written through it.`) : err; });
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.nlink !== 1) throw new Refused(`${file} is not an unshared regular file.`);
      await handle.truncate(0); await handle.writeFile(text);
    } finally { await handle.close(); }
  }, true);
}
