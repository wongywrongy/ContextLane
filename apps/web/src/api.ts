import { useEffect, useState } from "react";
import type { LaneEvent } from "@contextlanes/protocol";

export async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return (await res.json()) as T;
}

/** Load once; returns [data, error]. Screens re-render from the live stream, not by polling. */
export function useJson<T>(path: string | null): [T | null, Error | null] {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<Error | null>(null);
  useEffect(() => {
    if (!path) return;
    let live = true;
    getJson<T>(path).then((d) => live && setData(d), (e: Error) => live && setError(e));
    return () => {
      live = false;
    };
  }, [path]);
  return [data, error];
}

/** One server-sent-event stream per project; every lane event arrives here. */
export function useProjectStream(project: string, onEvent: (e: LaneEvent) => void): void {
  useEffect(() => {
    const source = new EventSource(`/api/projects/${project}/stream`);
    source.addEventListener("lane", (msg) => onEvent(JSON.parse((msg as MessageEvent<string>).data) as LaneEvent));
    return () => source.close();
  }, [project, onEvent]);
}
