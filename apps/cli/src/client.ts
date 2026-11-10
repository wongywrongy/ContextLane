import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { basename } from "node:path";

/**
 * A failure the CLI reports and exits on. exit follows the contract every command keeps: 1 the action
 * failed, 2 wrong usage, 3 ContextLanes not reachable, 4 waiting on the owner.
 */
export class ClientError extends Error {
  readonly exit: number;
  readonly code: string;
  constructor(message: string, opts: { exit?: number; code?: string } = {}) {
    super(message);
    this.exit = opts.exit ?? 1;
    this.code = opts.code ?? "failed";
  }
}
export class UsageError extends ClientError {
  constructor(message: string) { super(message, { exit: 2, code: "usage" }); }
}
/** Reasons the daemon gives that only the owner can resolve. */
const OWNER_CODES = new Set(["recipe_unapproved"]);

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
      throw new ClientError(`Something other than ContextLanes is answering on ${daemonUrl()}, or ContextLanes is older than this command. Restart it (systemctl --user restart contextlanes); if this repeats, stop whatever else uses that port.`, { exit: 3, code: "unreachable" });
    return token;
  })();
}

export async function api<T>(path: string, init?: { method?: string; body?: unknown; token?: string }): Promise<T> {
  const token = init?.token ?? (PUBLIC.includes(path) ? undefined : await shellToken());
  const res = await fetch(`${daemonUrl()}${path}`, {
    method: init?.method ?? "GET",
    headers: { ...(init?.body ? { "content-type": "application/json" } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: init?.body ? JSON.stringify(init.body) : null,
  }).catch(() => { throw new ClientError(`ContextLanes is not answering at ${daemonUrl()}; start it and try again.`, { exit: 3, code: "unreachable" }); });
  const text = await res.text();
  let data: (T & { error?: string; code?: string }) | null = null;
  try { data = JSON.parse(text) as T & { error?: string; code?: string }; } catch { /* not JSON */ }
  if (!res.ok) {
    const code = data?.code ?? (res.status === 401 ? "unauthorized" : res.status === 404 ? "not_found" : "failed");
    throw new ClientError(data?.error ?? `${res.status} ${res.statusText}`, { exit: OWNER_CODES.has(code) ? 4 : 1, code });
  }
  return data as T;
}
