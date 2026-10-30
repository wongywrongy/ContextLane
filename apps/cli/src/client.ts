export class ClientError extends Error {}

/** Thin client for the daemon API. On the machine it talks to loopback; elsewhere set CONTEXTLANES_URL. */
export function daemonUrl(): string {
  return process.env.CONTEXTLANES_URL ?? "http://127.0.0.1:4600";
}

export async function api<T>(path: string, init?: { method?: string; body?: unknown; token?: string }): Promise<T> {
  const res = await fetch(`${daemonUrl()}${path}`, {
    method: init?.method ?? "GET",
    headers: { ...(init?.body ? { "content-type": "application/json" } : {}), ...(init?.token ? { authorization: `Bearer ${init.token}` } : {}) },
    body: init?.body ? JSON.stringify(init.body) : null,
  }).catch(() => { throw new ClientError("The daemon could not be reached; start ContextLanes and try again."); });
  const data = (await res.json()) as T & { error?: string };
  if (!res.ok) throw new ClientError(data.error ?? `${res.status} ${res.statusText}`);
  return data;
}
