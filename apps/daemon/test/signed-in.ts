import type { FastifyInstance } from "fastify";
import type { Store } from "@contextlanes/daemon";

/** Sends the owner's session with every inject, as the signed-in web app does. A test's own authorization header wins. */
export function signedIn<T extends FastifyInstance>(app: T, store: Store): T {
  const authorization = `Bearer ${store.ownerSession()}`;
  const inject = app.inject.bind(app) as (o: unknown) => unknown;
  (app as { inject: unknown }).inject = (o: string | { headers?: object }) => inject(typeof o === "string" ? { url: o, headers: { authorization } } : { ...o, headers: { authorization, ...o.headers } });
  return app;
}
