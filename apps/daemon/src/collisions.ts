import type { Collision, Lane, LaneEvent, ProjectId } from "@contextlanes/protocol";
import type { EventBus } from "./bus.js";
import type { CodeMaps } from "./codemap.js";
import type { Store } from "./db/store.js";
import type { HostLinks } from "./hosts.js";
import { NotFound, Refused } from "./lanes/manager.js";

const OPEN: Lane["state"][] = ["setting_up", "working", "needs_you", "in_review", "failed", "paused"];
/** Lanes nearer review go first: a checkpoint waiting beats work in progress. */
const NEARNESS: Partial<Record<Lane["state"], number>> = { in_review: 0, needs_you: 1, working: 2, paused: 3, setting_up: 4, failed: 5 };

/**
 * Suggested merge order. If one lane's changes are used by another lane's changed modules (code map
 * links), that lane goes first, since the other builds on it. Otherwise the lane nearer review, then
 * the smaller change.
 */
export function mergeOrder(lanes: { lane: Lane; modules: string[]; files: number }[], links: { source: string; target: string }[]): { order: string[]; reason: string } {
  const uses = (a: { modules: string[] }, b: { modules: string[] }) => links.some((l) => a.modules.includes(l.source) && b.modules.includes(l.target) && !a.modules.includes(l.target));
  const sorted = [...lanes].sort((a, b) => {
    if (uses(b, a) && !uses(a, b)) return -1;
    if (uses(a, b) && !uses(b, a)) return 1;
    return (NEARNESS[a.lane.state] ?? 9) - (NEARNESS[b.lane.state] ?? 9) || a.files - b.files || a.lane.id.localeCompare(b.lane.id);
  });
  const [first, second] = sorted;
  const reason = uses(second!, first!) && !uses(first!, second!) ? `${second!.lane.id} builds on code ${first!.lane.id} changes`
    : (NEARNESS[first!.lane.state] ?? 9) < (NEARNESS[second!.lane.state] ?? 9) ? `${first!.lane.id} is nearer review`
    : first!.files < second!.files ? `${first!.lane.id} is the smaller change` : `${first!.lane.id} started first`;
  return { order: sorted.map((x) => x.lane.id), reason };
}

/**
 * Watches open lanes for two or more changing one module. Each new overlap is recorded once on every
 * lane in it (collision.detected), shown in the Inbox to the lane that should wait, and cleared when it
 * goes away. Agents are told nothing unless the owner presses the action, and then only once the first
 * lane merges.
 */
export class Collisions {
  private timer: NodeJS.Timeout | null = null;
  constructor(private deps: { store: Store; bus: EventBus; codemaps: CodeMaps; hosts: HostLinks }) {}

  start(everyMs = 30_000): void {
    // One pass at a time: a slow git on a big repository must not stack passes up and repeat events.
    let busy = false;
    const tick = () => { if (busy) return; busy = true; void this.check().catch((err) => console.error("Collision check failed:", err)).finally(() => { busy = false; }); };
    this.timer = setInterval(tick, everyMs);
    this.timer.unref();
    setTimeout(tick, 5_000).unref();
  }
  close(): void { if (this.timer) clearInterval(this.timer); }

  /** One pass over every project with two or more open lanes. */
  async check(): Promise<void> {
    const { store } = this.deps;
    for (const project of store.listProjects()) {
      const lanes = store.listLanes(project.id);
      const open = lanes.filter((l) => OPEN.includes(l.state));
      await this.deliver(lanes);
      const active = this.active(project.id);
      if (open.length < 2 && !active.length) continue;
      const { map } = open.length >= 2 ? await this.deps.codemaps.map(project.id) : { map: null };
      const overlay = map ? await this.deps.codemaps.overlay(project.id, map) : [];
      const byModule = new Map<string, { lane: Lane; files: string[] }[]>();
      for (const o of overlay) {
        const lane = open.find((l) => l.id === o.lane);
        if (lane) for (const [module, files] of Object.entries(o.modules)) byModule.set(module, [...(byModule.get(module) ?? []), { lane, files }]);
      }
      const now = new Set<string>();
      for (const [module, editing] of byModule) {
        if (editing.length < 2) continue;
        const ids = editing.map((e) => e.lane.id).sort();
        const key = `${module}\0${ids.join(",")}`;
        now.add(key);
        if (active.some((c) => `${c.module}\0${[...c.lanes].sort().join(",")}` === key)) continue;
        const { order, reason } = mergeOrder(editing.map((e) => ({ lane: e.lane, files: Object.values(overlay.find((o) => o.lane === e.lane.id)!.modules).flat().length,
          modules: Object.keys(overlay.find((o) => o.lane === e.lane.id)!.modules) })), map?.links ?? []);
        const files = Object.fromEntries(editing.map((e) => [e.lane.id, e.files]));
        for (const id of ids) this.emit(store.appendEvent(id, { type: "collision.detected", payload: { module, lanes: ids, files, order, reason } }));
      }
      for (const c of active) {
        const key = `${c.module}\0${[...c.lanes].sort().join(",")}`;
        if (now.has(key) && c.lanes.every((id) => open.some((l) => l.id === id))) continue;
        for (const id of c.lanes) this.emit(store.appendEvent(id, { type: "collision.cleared", payload: { module: c.module, lanes: c.lanes } }));
      }
    }
  }

  /** Open collisions in a project, newest state of each from the lanes' own events. */
  active(project: ProjectId): Collision[] {
    const found = new Map<string, Collision>();
    const planned = new Set<string>();
    for (const lane of this.deps.store.listLanes(project)) {
      for (const e of this.events(lane.id)) {
        if (e.type === "collision.detected") found.set(`${e.payload.module}\0${[...e.payload.lanes].sort().join(",")}`, { module: e.payload.module, lanes: e.payload.lanes, order: e.payload.order, files: e.payload.files, reason: e.payload.reason, since: e.at, planned: false });
        else if (e.type === "collision.cleared") found.delete(`${e.payload.module}\0${[...e.payload.lanes].sort().join(",")}`);
        else if (e.type === "collision.planned") planned.add(`${lane.id}\0${e.payload.module}\0${e.payload.first}`);
      }
    }
    for (const c of found.values()) c.planned = c.order.slice(1).some((id) => planned.has(`${id}\0${c.module}\0${c.order[0]}`));
    return [...found.values()];
  }

  /**
   * The owner's action: tell the waiting lane, once `first` merges, to rebase onto it. Recorded now,
   * sent by the next check after the merge.
   */
  plan(project: ProjectId, module: string, waiting: string): { planned: true } {
    const c = this.active(project).find((x) => x.module === module && x.order.slice(1).includes(waiting));
    if (!c) throw new NotFound("That collision is no longer open.");
    const first = c.order[0]!;
    const lane = this.deps.store.getLane(waiting)!;
    if (this.events(waiting).some((e) => e.type === "collision.planned" && e.payload.module === module && e.payload.first === first)) throw new Refused("That note is already set to go.");
    const message = `Lane ${first} also changed ${module}, and goes first (${c.reason}). It has now merged into ${lane.base ?? "the base branch"}. Rebase this branch onto ${lane.base ?? "it"}, resolve any conflicts in ${module}, run the checks, then carry on.`;
    this.emit(this.deps.store.appendEvent(waiting, { type: "collision.planned", payload: { module, first, message } }));
    return { planned: true };
  }

  /** Sends planned notes whose first lane has merged. */
  private async deliver(lanes: Lane[]): Promise<void> {
    for (const lane of lanes.filter((l) => OPEN.includes(l.state))) {
      const events = this.events(lane.id);
      for (const p of events.filter((e): e is Extract<LaneEvent, { type: "collision.planned" }> => e.type === "collision.planned")) {
        if (events.some((e) => e.type === "collision.told" && e.payload.module === p.payload.module && e.payload.first === p.payload.first)) continue;
        if (this.deps.store.getLane(p.payload.first)?.state !== "merged") continue;
        this.deps.hosts.command(lane.id, { kind: "prompt", text: p.payload.message, immediate: false, files: [], images: [] });
        this.emit(this.deps.store.appendEvent(lane.id, { type: "agent.message", payload: { text: p.payload.message, role: "user" } }));
        this.emit(this.deps.store.appendEvent(lane.id, { type: "collision.told", payload: { module: p.payload.module, first: p.payload.first } }));
      }
    }
  }

  private events(lane: string): LaneEvent[] {
    return this.deps.store.eventsOfType(["collision.detected", "collision.cleared", "collision.planned", "collision.told"], { lanes: [lane] }).sort((a, b) => a.seq - b.seq);
  }
  private emit(e: LaneEvent): void { this.deps.bus.publish(e); }
}
