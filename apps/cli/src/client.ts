import { readFile } from "node:fs/promises";

export class ClientError extends Error {}

/** Thin client for the daemon API. On the machine it talks to loopback; elsewhere set CONTEXTLANES_URL. */
export function daemonUrl(): string {
  return process.env.CONTEXTLANES_URL ?? "http://127.0.0.1:4600";
}

const PUBLIC = ["/api/health", "/api/setup/status"];
let shell: Promise<string | undefined> | undefined;

/** Reading <data>/setup-token is what proves this command runs as the owner, on this machine. */
function shellToken(): Promise<string | undefined> {
  return shell ??= api<{ controlFile?: string }>("/api/setup/status").then((s) => s.controlFile ? readFile(s.controlFile, "utf8") : undefined).then((t) => t?.trim(), () => undefined);
}

export async function api<T>(path: string, init?: { method?: string; body?: unknown; token?: string }): Promise<T> {
  const token = init?.token ?? (PUBLIC.includes(path) ? undefined : await shellToken());
  const res = await fetch(`${daemonUrl()}${path}`, {
    method: init?.method ?? "GET",
    headers: { ...(init?.body ? { "content-type": "application/json" } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: init?.body ? JSON.stringify(init.body) : null,
  }).catch(() => { throw new ClientError("The daemon could not be reached; start ContextLanes and try again."); });
  const data = (await res.json()) as T & { error?: string };
  if (!res.ok) throw new ClientError(data.error ?? `${res.status} ${res.statusText}`);
  return data;
}
