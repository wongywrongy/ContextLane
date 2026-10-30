import { randomUUID } from "node:crypto";
import { mkdir, realpath, stat, writeFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import type { Lane, PromptCommand, PromptRequest } from "@contextlanes/protocol";
import type { z } from "zod";
import type { Config } from "./config.js";
import { Refused } from "./lanes/manager.js";
import type { Runner } from "./run.js";

const EXT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" };

/** Where a lane's pictures wait for its host: inside the lanes folder, which the sandbox can read. */
export const attachmentDir = (config: Config, lane: string) => join(config.paths.lanes, ".attachments", lane.replace("/", "-"));

/**
 * Checks each @ file is a file inside the lane's checkout (symlinks included), and saves pictures as files,
 * so the event log keeps a path rather than megabytes of base64.
 */
export async function attach(config: Config, lane: Lane, body: z.output<typeof PromptRequest>): Promise<z.output<typeof PromptCommand>> {
  const root = body.files.length ? await realpath(lane.worktree).catch(() => { throw new Refused("This lane's checkout is gone, so files cannot be attached."); }) : "";
  for (const file of body.files) {
    const real = await realpath(join(root, file)).catch(() => null);
    if (!real || (real !== root && !real.startsWith(root + sep)) || !(await stat(real)).isFile()) throw new Refused(`${file} is not a file in this lane's checkout.`);
  }
  const images: { mimeType: (typeof body.images)[number]["mimeType"]; path: string }[] = [];
  if (body.images.length) {
    const dir = attachmentDir(config, lane.id);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    for (const image of body.images) {
      const bytes = Buffer.from(image.data, "base64");
      if (bytes.length > 5 * 1024 * 1024) throw new Refused("Pictures can be at most 5 MB.");
      const path = join(dir, `${randomUUID()}.${EXT[image.mimeType]}`);
      await writeFile(path, bytes, { mode: 0o600 });
      images.push({ mimeType: image.mimeType, path });
    }
  }
  return { text: body.text, immediate: body.immediate, files: body.files, images };
}

/** Files for @ file: tracked and untracked-but-not-ignored, filtered by a substring, at most 50. */
export async function laneFiles(run: Runner, lane: Lane, query: string): Promise<string[]> {
  const out = await run("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: lane.worktree, timeout: 10_000 }).catch(() => ({ stdout: "" }));
  const q = query.toLowerCase();
  const all = [...new Set(out.stdout.split("\0").filter(Boolean))];
  const hits = q ? all.filter((f) => f.toLowerCase().includes(q)).sort((a, b) => (a.toLowerCase().split("/").at(-1)!.startsWith(q) ? 0 : 1) - (b.toLowerCase().split("/").at(-1)!.startsWith(q) ? 0 : 1) || a.length - b.length) : all;
  return hits.slice(0, 50).map((f) => relative(".", f));
}
