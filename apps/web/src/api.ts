import { useCallback, useEffect, useState } from "react";
import type { LaneEvent } from "@contextlanes/protocol";

export async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return (await res.json()) as T;
}

/** Load once; returns [data, error]. Screens re-render from the live stream, not by polling. */
export function useJson<T>(path: string | null): [T | null, Error | null, () => void] {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [version, setVersion] = useState(0);
  const reload = useCallback(() => setVersion((n) => n + 1), []);
  useEffect(() => {
    if (!path) return;
    let live = true;
    getJson<T>(path).then((d) => { if (live) { setData(d); setError(null); } }, (e: Error) => live && setError(e));
    return () => {
      live = false;
    };
  }, [path, version]);
  return [data, error, reload];
}

export async function postJson<T>(path: string, body: unknown, method = "POST"): Promise<T> {
  const response = await fetch(path, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? `Request failed (${response.status})`);
  return result as T;
}

/** One server-sent-event stream per project; every lane event arrives here. */
export function useProjectStream(project: string, onEvent: (e: LaneEvent) => void): void {
  useEffect(() => {
    const source = new EventSource(`/api/projects/${project}/stream`);
    source.addEventListener("lane", (msg) => onEvent(JSON.parse((msg as MessageEvent<string>).data) as LaneEvent));
    return () => source.close();
  }, [project, onEvent]);
}
