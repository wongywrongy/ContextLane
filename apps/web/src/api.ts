import { createContext, useContext, useCallback, useEffect, useState } from "react";
import type { LaneEvent, InboxItem } from "@contextlanes/protocol";

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
export function useProjectStream(project: string, onEvent: (e: LaneEvent) => void, onOpen?: () => void): void {
  useEffect(() => {
    const source = new EventSource(`/api/projects/${project}/stream`);
    if (onOpen) source.onopen = onOpen;
    source.addEventListener("lane", (msg) => onEvent(JSON.parse((msg as MessageEvent<string>).data) as LaneEvent));
    return () => source.close();
  }, [project, onEvent, onOpen]);
}

type InboxQuery = [InboxItem[] | null, Error | null, () => void];
export const InboxContext = createContext<InboxQuery | null>(null);
export function useInbox(): InboxQuery {
  const value = useContext(InboxContext);
  if (!value) throw new Error("Inbox must be inside the app shell");
  return value;
}
export function useLiveInbox(): InboxQuery {
  const result = useJson<InboxItem[]>("/api/inbox");
  const reload = result[2];
  useEffect(() => {
    const source = new EventSource("/api/stream");
    source.onopen = reload;
    source.addEventListener("lane", (message) => { if (/permission\.|lane.state/.test(JSON.parse((message as MessageEvent<string>).data).type)) reload(); });
    return () => source.close();
  }, [reload]);
  return result;
}
