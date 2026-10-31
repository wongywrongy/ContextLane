import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { basename } from "node:path";

export class ClientError extends Error {}

/** Thin client for the daemon API. On the machine it talks to loopback; elsewhere set CONTEXTLANES_URL. */
export function daemonUrl(): string {
  return process.env.CONTEXTLANES_URL ?? "http://127.0.0.1:4600";
}

const PUBLIC = ["/api/health", "/api/setup/status", "/api/setup/prove"];
let shell: Promise<string | undefined> | undefined;

/**
 * Reading <data>/setup-token is what proves this command runs as the owner, on this machine. Before the
 * token is sent anywhere, whatever answers on the port must show it can read the same file (an HMAC of a
 * fresh nonce): another program on the port while the daemon restarts never gets the owner's credential.
 * The file must be the setup token: a regular file of ours called setup-token, not a link.
 */
export function shellToken(): Promise<string | undefined> {
  return shell ??= (async () => {
    const status = await api<{ controlFile?: string }>("/api/setup/status").catch(() => ({ controlFile: undefined }));
    if (!status.controlFile) return undefined;
    const info = await lstat(status.controlFile).catch(() => null);
    if (!info || basename(status.controlFile) !== "setup-token" || !info.isFile() || (process.getuid && info.uid !== process.getuid())) return undefined;
    const token = (await readFile(status.controlFile, "utf8").catch(() => "")).trim();
    if (!token) return undefined;
    const nonce = randomBytes(32).toString("base64url");
    const { proof } = await api<{ proof?: string }>("/api/setup/prove", { method: "POST", body: { nonce } }).catch(() => ({ proof: undefined }));
    const expected = createHmac("sha256", token).update(`contextlanes-cli:${nonce}`).digest("base64url");
    if (!proof || proof.length !== expected.length || !timingSafeEqual(Buffer.from(proof), Buffer.from(expected)))
      throw new ClientError(`Something other than ContextLanes is answering on ${daemonUrl()}, or ContextLanes is older than this command. Restart it (systemctl --user restart contextlanes); if this repeats, stop whatever else uses that port.`);
    return token;
  })();
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
