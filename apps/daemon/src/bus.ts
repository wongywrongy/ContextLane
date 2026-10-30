import { EventEmitter } from "node:events";
import type { LaneEvent, ProjectId } from "@contextlanes/protocol";

/** Fan-out of new events to open streams (web, phone, CLI). The store stays the source of truth. */
export class EventBus {
  private readonly emitter = new EventEmitter().setMaxListeners(0);

  publish(event: LaneEvent): void {
    this.emitter.emit(projectOf(event.lane), event);
  }

  subscribe(project: ProjectId, fn: (e: LaneEvent) => void): () => void {
    this.emitter.on(project, fn);
    return () => this.emitter.off(project, fn);
  }
}

export function projectOf(lane: string): ProjectId {
  return lane.slice(0, lane.lastIndexOf("/"));
}
