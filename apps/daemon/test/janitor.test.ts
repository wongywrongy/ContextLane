import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { Config, Store } from "@contextlanes/daemon";
import { KEEP_DAYS, tidyFiles } from "../src/janitor.js";
import { attachmentDir } from "../src/attachments.js";

const roots: string[] = [];
afterEach(async () => { for (const r of roots.splice(0)) await rm(r, { recursive: true, force: true }); });
const exists = (p: string) => stat(p).then(() => true, () => false);

it("removes a finished lane's attachments and screenshots after two weeks, and spent answer links", async () => {
  const root = await mkdtemp(join(tmpdir(), "cl-janitor-")); roots.push(root);
  const config = Config.parse({ paths: { data: join(root, "data"), lanes: join(root, "lanes") } });
  const store = Store.open(":memory:");
  store.addProject({ id: "shop", name: "Shop", path: "/code/shop" });
  const lane = (n: number, state: "working" | "archived") => {
    const id = `shop/0${n}`;
    store.insertLane({ id, n, project: "shop", goal: null, task: "T", agent: "codex", model: null, mode: "ask", branch: `lane/0${n}`, worktree: join(root, `w${n}`), terminal: `t${n}`, hostUnit: null, base: "main", state: "working", colour: "lc1" });
    if (state === "archived") store.setLaneState(id, "archived", "done");
    return id;
  };
  const done = lane(1, "archived"), busy = lane(2, "working");
  const checkpoint = "11111111-2222-4333-8444-555555555555";
  store.insertCheckpoint({ id: checkpoint, lane: done, base: "a", head: "b", summary: "s", checks: [], screenshots: [], files: [], plan: [], unplanned: [], process: [], signal: "strong", decision: null, prUrl: null, createdAt: new Date().toISOString() });
  for (const id of [done, busy]) { await mkdir(attachmentDir(config, id), { recursive: true }); await writeFile(join(attachmentDir(config, id), "task.md"), "x"); }
  await mkdir(join(config.paths.data, "checkpoints", checkpoint), { recursive: true });
  store.action(done, "r1", "yes", "ntfy");
  const live = store.action(busy, "r2", "yes", "ntfy");

  expect(await tidyFiles({ store, config })).toEqual(["1 old notification answer links forgotten"]);
  expect(await exists(attachmentDir(config, done))).toBe(true);

  const later = Date.now() + (KEEP_DAYS + 1) * 86_400_000;
  expect(await tidyFiles({ store, config }, later)).toEqual([`${done}: attachments removed`, `${done}: screenshots of checkpoint 11111111 removed`]);
  expect(await exists(attachmentDir(config, done))).toBe(false);
  expect(await exists(attachmentDir(config, busy))).toBe(true);
  expect(store.notificationAction(live)).not.toBeNull();
  store.close();
});
