import { createContext, useContext, useCallback, useEffect, useState } from "react";
import type { LaneEvent, InboxItem } from "@contextlanes/protocol";

export class RequestError extends Error {}
export function errorMessage(error: unknown): string {
  if (error instanceof RequestError) return error.message;
  if (error instanceof DOMException && error.name === "NotAllowedError") return "Sign-in was cancelled or not allowed; try again when you are ready.";
  return "This action could not finish; check your connection and try again.";
}
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try { response = await fetch(path, init); } catch { throw new RequestError("The daemon could not be reached; check your connection and try again."); }
  let result;
  try { result = await response.json(); } catch { throw new RequestError("The daemon returned an incomplete response; reload and try again."); }
  if (!response.ok) throw new RequestError(typeof result.error === "string" ? result.error : "This action could not finish; reload and try again.");
  return result as T;
}
export async function getJson<T>(path: string): Promise<T> { return request<T>(path); }

/** Load once; returns [data, error]. Screens re-render from the live stream, not by polling. */
export function useJson<T>(path: string | null): [T | null, Error | null, () => void] {
  const [data, setData] = useState<T | null>(null);
  const [loadedPath, setLoadedPath] = useState<string | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [version, setVersion] = useState(0);
  const reload = useCallback(() => setVersion((n) => n + 1), []);
  useEffect(() => {
    if (!path) return;
    let live = true;
    getJson<T>(path).then((d) => { if (live) { setData(d); setLoadedPath(path); setError(null); } }, (e: Error) => live && setError(e));
    return () => {
      live = false;
    };
  }, [path, version]);
  return [loadedPath === path ? data : null, error, reload];
}

export async function postJson<T>(path: string, body: unknown, method = "POST"): Promise<T> {
  return request<T>(path, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
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

/** Answer one inbox item with one of its options. Only the owner's session can do this. */
export async function answerItem(item: InboxItem, optionId: string | null): Promise<void> {
  await postJson("/api/answers", { lane: item.lane, requestId: item.id.slice(item.id.indexOf("#") + 1), optionId, via: window.matchMedia("(max-width: 760px)").matches ? "phone" : "web" });
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
