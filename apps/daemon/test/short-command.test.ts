import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { ensureShortCommand } from "../src/install.js";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const fn of cleanups.splice(0)) await fn(); });
async function home(files: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), "cl-short-")); cleanups.push(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, ".local/bin"), { recursive: true });
  for (const [name, text] of Object.entries(files)) await writeFile(join(root, ".local/bin", name), text, { mode: 0o755 });
  return root;
}
const OURS = "#!/bin/sh\n# Installed by ContextLanes\nexec 'node' '/app/current/apps/cli/dist/main.js' \"$@\"\n";

it("adds cl beside our contextlanes after an update from a version that had none", async () => {
  const root = await home({ contextlanes: OURS });
  expect(await ensureShortCommand(root)).toBe(true);
  expect(await readFile(join(root, ".local/bin/cl"), "utf8")).toBe(OURS);
  expect(await ensureShortCommand(root)).toBe(false);
});

it("leaves someone else's cl, and a contextlanes it did not install, alone", async () => {
  const foreign = await home({ contextlanes: OURS, cl: "#!/bin/sh\necho common lisp\n" });
  expect(await ensureShortCommand(foreign)).toBe(false);
  expect(await readFile(join(foreign, ".local/bin/cl"), "utf8")).toContain("common lisp");
  const dev = await home({ contextlanes: "#!/bin/sh\nexec node ./main.js\n" });
  expect(await ensureShortCommand(dev)).toBe(false);
  expect(await ensureShortCommand(await home({}))).toBe(false);
});
