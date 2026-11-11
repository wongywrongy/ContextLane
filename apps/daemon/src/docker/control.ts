import { hostname } from "node:os";
import { z } from "zod";
import type { Runner } from "../run.js";
import { CONTROL_CONTAINER, CONTROL_LABEL, DATA_MOUNT, SOCKET } from "./names.js";

/** What the control service learns about its own container from Docker, once at start. */
export type ControlInfo = {
  id: string;
  name: string;
  /** The image id the control runs; helper containers run the same one. */
  image: string;
  /** Host path of the stack's data folder (mounted at /data), when Docker says. */
  data: string | null;
  /** Host path of the Docker socket it was given. */
  socket: string;
  mounts: { type: string; source: string; destination: string }[];
  /** Container ports published on the host, as "4601/tcp" → host addresses. */
  published: { port: string; host: string }[];
  networks: string[];
};

/** `docker inspect` output, only the fields used, checked at the edge. */
const Inspect = z.array(z.object({
  Id: z.string(),
  Name: z.string().default(""),
  Image: z.string(),
  Config: z.object({ Labels: z.record(z.string(), z.string()).nullable().default({}) }).prefault({}),
  Mounts: z.array(z.object({ Type: z.string().default(""), Source: z.string().default(""), Name: z.string().optional(), Destination: z.string() })).nullable().default([]),
  NetworkSettings: z.object({
    Ports: z.record(z.string(), z.array(z.object({ HostIp: z.string().default(""), HostPort: z.string().default("") })).nullable()).nullable().default({}),
    Networks: z.record(z.string(), z.unknown()).nullable().default({}),
  }).prefault({}),
})).min(1);

export function parseInspect(stdout: string): ControlInfo {
  const [c] = Inspect.parse(JSON.parse(stdout));
  const mounts = (c!.Mounts ?? []).map((m) => ({ type: m.Type, source: m.Type === "volume" ? m.Name ?? m.Source : m.Source, destination: m.Destination }));
  const published = Object.entries(c!.NetworkSettings.Ports ?? {}).flatMap(([port, bindings]) => (bindings ?? []).filter((b) => b.HostPort).map((b) => ({ port, host: `${b.HostIp || "0.0.0.0"}:${b.HostPort}` })));
  return {
    id: c!.Id, name: c!.Name.replace(/^\//, ""), image: c!.Image,
    data: mounts.find((m) => m.type === "bind" && m.destination === DATA_MOUNT)?.source ?? null,
    socket: mounts.find((m) => m.destination === SOCKET)?.source ?? SOCKET,
    mounts, published, networks: Object.keys(c!.NetworkSettings.Networks ?? {}),
  };
}

/**
 * Finds this container: by its hostname (Docker sets it to the short container id unless compose sets
 * one), then by its fixed name. Only a container carrying the control label counts.
 */
export async function inspectSelf(run: Runner, host = hostname()): Promise<ControlInfo> {
  let last: unknown;
  for (const ref of [host, CONTROL_CONTAINER]) {
    try {
      const { stdout } = await run("docker", ["inspect", "--type", "container", ref], { timeout: 15_000 });
      const raw = JSON.parse(stdout) as { Config?: { Labels?: Record<string, string> | null } }[];
      if (raw[0]?.Config?.Labels?.[CONTROL_LABEL] !== "1") { last = new Error(`${ref} has no ${CONTROL_LABEL}=1 label`); continue; }
      return parseInspect(stdout);
    } catch (err) { last = err; }
  }
  throw new Error(`The control service could not find its own container through the Docker socket: ${last instanceof Error ? last.message : String(last)}`);
}
