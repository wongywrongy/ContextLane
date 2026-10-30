import { EventEmitter } from "node:events";
import type { LaneEvent, ProjectId } from "@contextlanes/protocol";

/** Fan-out of new events to open streams (web, phone, CLI). The store stays the source of truth. */
export class EventBus {
  private readonly emitter = new EventEmitter().setMaxListeners(0);

  publish(event: LaneEvent): void {
    this.emitter.emit(projectOf(event.lane), event);
    this.emitter.emit("*", event);
  }

  // Each listener runs on its own: one that throws is logged, and the publisher and the others go on.
  subscribeAll(fn: (event: LaneEvent) => void): () => void {
    const safe = guard(fn);
    this.emitter.on("*", safe);
    return () => this.emitter.off("*", safe);
  }

  subscribe(project: ProjectId, fn: (e: LaneEvent) => void): () => void {
    const safe = guard(fn);
    this.emitter.on(project, safe);
    return () => this.emitter.off(project, safe);
  }
}

export function projectOf(lane: string): ProjectId {
  return lane.slice(0, lane.lastIndexOf("/"));
}

function guard(fn: (e: LaneEvent) => void): (e: LaneEvent) => void {
  return (e) => { try { fn(e); } catch (err) { console.error(`Event listener failed on ${e.type}:`, err); } };
}
