import { z } from "zod";

export const MachineInfo = z.object({
  host: z.string(), os: z.string(), user: z.string(), version: z.string(), address: z.string(),
  linger: z.boolean().nullable(), service: z.boolean().nullable(),
  backups: z.object({ scheduled: z.boolean().nullable(), lastRun: z.iso.datetime().nullable(), result: z.string().nullable(), directory: z.string() }),
});
export type MachineInfo = z.infer<typeof MachineInfo>;
export const UpdateCheck = z.object({ lines: z.array(z.string()), command: z.literal("contextlanes update") });
export type UpdateCheck = z.infer<typeof UpdateCheck>;
export const DataExport = z.object({
  at: z.iso.datetime(), version: z.string(), settings: z.unknown(), tables: z.record(z.string(), z.array(z.record(z.string(), z.unknown()))),
});
export type DataExport = z.infer<typeof DataExport>;
