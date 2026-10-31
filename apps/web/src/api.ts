import { createContext, useContext, useCallback, useEffect, useState } from "react";
import type { LaneEvent, InboxItem } from "@contextlanes/protocol";

export class RequestError extends Error {}

/**
 * Kept in localStorage, not a cookie: storage belongs to one host and port, so a lane preview on another
 * port cannot read it, while cookies are sent to every port. Storage can throw in a private window.
 */
const SESSION = "cl-session";
export function sessionToken(): string | null { try { return localStorage.getItem(SESSION); } catch { return null; } }
export function saveSession(token: string): void { try { localStorage.setItem(SESSION, token); } catch { throw new RequestError("This browser refused to keep the sign-in; turn off private browsing and try again."); } }
function dropSession(): void { try { localStorage.removeItem(SESSION); } catch { /* Nothing was stored. */ } }
function authorized(init?: RequestInit): RequestInit {
  const token = sessionToken();
  return { ...init, headers: { ...init?.headers, ...(token ? { authorization: `Bearer ${token}` } : {}) } };
}
export function errorMessage(error: unknown): string {
  if (error instanceof RequestError) return error.message;
  if (error instanceof DOMException && error.name === "NotAllowedError") return "Sign-in was cancelled or not allowed; try again when you are ready.";
  return "This action could not finish; check your connection and try again.";
}
export const apiFetch: typeof fetch = (input, init) => fetch(input, authorized(init));
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try { response = await fetch(path, authorized(init)); } catch { throw new RequestError("The daemon could not be reached; check your connection and try again."); }
  if (response.status === 401 && sessionToken()) { dropSession(); location.assign("/setup"); }
  // 204 and other empty answers (DELETE) carry no body to read.
  const text = await response.text().catch(() => null);
  if (text === null) throw new RequestError("The daemon returned an incomplete response; reload and try again.");
  if (!text) {
    if (!response.ok) throw new RequestError("This action could not finish; reload and try again.");
    return undefined as T;
  }
  let result;
  try { result = JSON.parse(text); } catch { throw new RequestError("The daemon returned an incomplete response; reload and try again."); }
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

/** A one-time address for a stream or terminal, which cannot send an Authorization header. */
export async function ticketUrl(path: string): Promise<string> {
  const { ticket } = await postJson<{ ticket: string }>("/api/tickets", { path });
  return `${path}?ticket=${encodeURIComponent(ticket)}`;
}

/** Tickets work once, so reconnecting needs a new one; EventSource alone would retry the spent address forever. */
function openStream(path: string, onEvent: (e: LaneEvent) => void, onOpen?: () => void): () => void {
  let source: EventSource | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  const connect = () => {
    void ticketUrl(path).then((url) => {
      if (closed) return;
      source = new EventSource(url);
      if (onOpen) source.onopen = onOpen;
      source.addEventListener("lane", (msg) => onEvent(JSON.parse((msg as MessageEvent<string>).data) as LaneEvent));
      source.onerror = () => { source?.close(); timer = setTimeout(connect, 2000); };
    }, () => { if (!closed) timer = setTimeout(connect, 2000); });
  };
  connect();
  return () => { closed = true; clearTimeout(timer); source?.close(); };
}

/** One server-sent-event stream per project; every lane event arrives here. */
export function useProjectStream(project: string, onEvent: (e: LaneEvent) => void, onOpen?: () => void): void {
  useEffect(() => openStream(`/api/projects/${project}/stream`, onEvent, onOpen), [project, onEvent, onOpen]);
}

/** An image behind the API, for <img>, which cannot send an Authorization header. */
export function useImage(path: string | null): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!path) return;
    let live = true;
    let created: string | null = null;
    void fetch(path, authorized()).then((r) => r.ok ? r.blob() : null).then((blob) => { if (live && blob) setUrl(created = URL.createObjectURL(blob)); }, () => {});
    return () => { live = false; if (created) URL.revokeObjectURL(created); };
  }, [path]);
  return url;
}

export function reviewLink(lane: string): string { return `/p/${lane.split("/")[0]}/review?lane=${encodeURIComponent(lane)}`; }

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
  useEffect(() => openStream("/api/stream", (event) => { if (/permission\.|recipe\.|collision\.|lane\.state/.test(event.type)) reload(); }, reload), [reload]);
  return result;
}
