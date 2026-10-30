/** Thin client for the daemon API. On the machine it talks to loopback; elsewhere set CONTEXTLANES_URL. */
export function daemonUrl(): string {
  return process.env.CONTEXTLANES_URL ?? "http://127.0.0.1:4600";
}

export async function api<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const res = await fetch(`${daemonUrl()}${path}`, {
    method: init?.method ?? "GET",
    headers: init?.body ? { "content-type": "application/json" } : {},
    body: init?.body ? JSON.stringify(init.body) : null,
  });
  const data = (await res.json()) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? `${res.status} ${res.statusText}`);
  return data;
}
