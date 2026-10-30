import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Config } from "../config.js";
import type { Store } from "../db/store.js";

const TICKET_MS = 30_000;
const hash = (text: string) => createHash("sha256").update(text).digest("hex");

/** Owner credentials: a browser session token, the CLI's setup-token, or a ticket for one stream or terminal. */
export class Auth {
  private readonly tickets = new Map<string, { path: string; expires: number }>();
  constructor(private readonly store: Store, private readonly config: Config) {}

  async owner(bearer: string): Promise<boolean> {
    if (this.store.validOwnerSession(bearer)) return true;
    const actual = await readFile(join(this.config.paths.data, "setup-token"), "utf8").catch(() => "");
    return !!actual && timingSafeEqual(Buffer.from(hash(bearer)), Buffer.from(hash(actual.trim())));
  }

  /** EventSource and WebSocket cannot send headers, and a URL can leak, so this opens one path, once, briefly. */
  ticket(path: string): string {
    for (const [key, ticket] of this.tickets) if (ticket.expires < Date.now()) this.tickets.delete(key);
    const token = `cl-ticket-${randomBytes(32).toString("base64url")}`;
    this.tickets.set(hash(token), { path, expires: Date.now() + TICKET_MS });
    return token;
  }

  spendTicket(token: string, path: string): boolean {
    const key = hash(token);
    const ticket = this.tickets.get(key);
    this.tickets.delete(key);
    return !!ticket && ticket.expires >= Date.now() && ticket.path === path;
  }
}
