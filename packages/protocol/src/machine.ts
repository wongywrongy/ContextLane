import { z } from "zod";

export const MachineInfo = z.object({
  host: z.string(), os: z.string(), user: z.string(), version: z.string(), address: z.string(),
  linger: z.boolean().nullable(), service: z.boolean().nullable(),
  /** How lane services run, and whether agents are confined; "off" only when the owner set it. */
  supervisor: z.enum(["systemd", "process"]).default("systemd"), sandbox: z.enum(["bwrap", "off"]).default("bwrap"),
  backups: z.object({ scheduled: z.boolean().nullable(), lastRun: z.iso.datetime().nullable(), result: z.string().nullable(), directory: z.string() }),
});
export type MachineInfo = z.infer<typeof MachineInfo>;
export const UpdateCheck = z.object({ lines: z.array(z.string()), command: z.literal("cl update") });
export type UpdateCheck = z.infer<typeof UpdateCheck>;
export const DataExport = z.object({
  at: z.iso.datetime(), version: z.string(), settings: z.unknown(), tables: z.record(z.string(), z.array(z.record(z.string(), z.unknown()))),
});
export type DataExport = z.infer<typeof DataExport>;
