import { chmod, mkdir, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { exists } from "./layout.js";

/** VACUUM INTO takes a consistent copy while the daemon continues writing. */
export async function backupDatabase(database: string, directory: string, label: string, keep: number): Promise<{ file: string; userVersion: number } | null> {
  if (!(await exists(database))) return null;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const file = join(directory, `${new Date().toISOString().replace(/[:.]/g, "-")}-${label}-${randomUUID()}.sqlite`);
  const db = new DatabaseSync(database, { readOnly: true });
  let userVersion: number;
  try {
    userVersion = Number((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version);
    db.prepare("VACUUM INTO ?").run(file);
    await chmod(file, 0o600);
  } catch (err) {
    await unlink(file).catch(() => {});
    throw err;
  } finally { db.close(); }
  const old = (await readdir(directory)).filter((f) => f.endsWith(".sqlite")).sort();
  for (const f of old.slice(0, Math.max(0, old.length - keep))) await unlink(join(directory, f));
  return { file, userVersion };
}
