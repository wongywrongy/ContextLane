import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import type { Config, Store } from "@contextlanes/daemon";

/** The command line's credential for this data folder, made if it is not there yet. */
export function cliToken(config: Config): string {
  const file = join(config.paths.data, "setup-token");
  try { return readFileSync(file, "utf8").trim(); } catch { /* not written yet */ }
  mkdirSync(config.paths.data, { recursive: true });
  const token = randomBytes(24).toString("base64url");
  writeFileSync(file, token, { mode: 0o600 });
  return token;
}

/**
 * Sends the owner's credential with every inject. With a config it is the command line's, which may do
 * everything; without one it is a browser session, which only views and decides. A test's own header wins.
 */
export function signedIn<T extends FastifyInstance>(app: T, store: Store, config?: Config): T {
  const authorization = `Bearer ${config ? cliToken(config) : store.ownerSession()}`;
  const inject = app.inject.bind(app) as (o: unknown) => unknown;
  (app as { inject: unknown }).inject = (o: string | { headers?: object }) => inject(typeof o === "string" ? { url: o, headers: { authorization } } : { ...o, headers: { authorization, ...o.headers } });
  return app;
}
