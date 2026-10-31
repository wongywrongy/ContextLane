import { rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Config } from "./config.js";
import type { Store } from "./db/store.js";
import { attachmentDir } from "./attachments.js";

/** How long a finished lane's files stay after it was cleaned up or archived. */
export const KEEP_DAYS = 14;

/**
 * Daily housekeeping for a machine that runs for months. Lanes cleaned up or archived more than
 * KEEP_DAYS ago lose their attachments (pasted images, task files) and their checkpoints' screenshots;
 * their events, checkpoints and branches stay. Notification answer links for questions already
 * answered, or for lanes that ended, are forgotten.
 */
export async function tidyFiles(deps: { store: Store; config: Config }, now = Date.now()): Promise<string[]> {
  const { store, config } = deps;
  const done: string[] = [];
  const gone = async (path: string) => { if (await stat(path).then(() => true, () => false)) { await rm(path, { recursive: true, force: true }); return true; } return false; };
  for (const lane of store.listLanes().filter((l) => l.state === "cleaned" || l.state === "archived")) {
    const ended = store.eventsOfType(["lane.state"], { lanes: [lane.id] }).at(-1)?.at;
    if (!ended || now - Date.parse(ended) < KEEP_DAYS * 86_400_000) continue;
    if (await gone(attachmentDir(config, lane.id))) done.push(`${lane.id}: attachments removed`);
    for (const c of store.checkpoints(lane.project).filter((x) => x.lane === lane.id)) {
      if (await gone(join(config.paths.data, "checkpoints", c.id))) done.push(`${lane.id}: screenshots of checkpoint ${c.id.slice(0, 8)} removed`);
    }
  }
  const actions = store.pruneNotificationActions();
  if (actions) done.push(`${actions} old notification answer links forgotten`);
  return done;
}
