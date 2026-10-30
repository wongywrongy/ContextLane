import { z } from "zod";
import { LaneId, ProjectId } from "./ids.js";

export const ServiceProposal = z.object({
  pid: z.number().int().positive(), bootId: z.uuid(), startTicks: z.string().regex(/^\d+$/), cwd: z.string().startsWith("/").max(4096),
  command: z.array(z.string().max(4096)).min(1).max(100), port: z.number().int().min(1).max(65535),
});
export type ServiceProposal = z.infer<typeof ServiceProposal>;
export const OutsideService = ServiceProposal.extend({
  name: z.string(), address: z.string(), bind: z.enum(["localhost only", "all addresses", "specific address"]), adoptedLane: LaneId.nullable(),
});
export type OutsideService = z.infer<typeof OutsideService>;
export const RunFacts = z.object({
  lanes: z.array(z.object({ lane: LaneId, diskBytes: z.number().int().nonnegative().nullable(), certificateDays: z.number().int().nullable() })),
  outside: z.array(OutsideService).nullable(),
});
export type RunFacts = z.infer<typeof RunFacts>;
export const Gpu = z.object({ name: z.string().min(1), usePct: z.number().min(0).max(100).nullable(), memoryUsedMiB: z.number().nonnegative().nullable(), memoryTotalMiB: z.number().nonnegative().nullable() });
export type Gpu = z.infer<typeof Gpu>;
export const ResourcesOverview = z.object({
  projects: z.array(z.object({ project: ProjectId, up: z.number().int().nonnegative(), down: z.number().int().nonnegative() })),
  gpus: z.array(Gpu).nullable(),
});
export type ResourcesOverview = z.infer<typeof ResourcesOverview>;
