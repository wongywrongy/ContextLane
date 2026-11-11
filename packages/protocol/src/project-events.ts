import { z } from "zod";
import { ProjectOwner } from "./api.js";
import { ProjectId } from "./ids.js";

/**
 * Events that belong to a project rather than a lane. Lane events keep their own log (events.ts); this one
 * is small and holds what is learned about the project's folder.
 */
const payloads = {
  /** The folder's owner on the host, read by a helper container when the project is added. */
  "project.owner": ProjectOwner,
};
export type ProjectEventType = keyof typeof payloads;
export const PROJECT_EVENT_TYPES = Object.keys(payloads) as ProjectEventType[];
export type ProjectEventPayload<T extends ProjectEventType> = z.infer<(typeof payloads)[T]>;
export type ProjectEvent = { [T in ProjectEventType]: { project: ProjectId; seq: number; at: string; type: T; payload: ProjectEventPayload<T> } }[ProjectEventType];
export type NewProjectEvent = { [T in ProjectEventType]: { type: T; payload: ProjectEventPayload<T> } }[ProjectEventType];

export function parseProjectPayload<T extends ProjectEventType>(type: T, payload: unknown): ProjectEventPayload<T> {
  const schema = payloads[type];
  if (!schema) throw new Error(`unknown project event type ${String(type)}`);
  return schema.parse(payload) as ProjectEventPayload<T>;
}
