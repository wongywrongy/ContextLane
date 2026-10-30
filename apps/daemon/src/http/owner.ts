import type { FastifyReply, FastifyRequest } from "fastify";
import type { Config } from "../config.js";
import type { Store } from "../db/store.js";

/**
 * Stricter than the general API check: agents run on this machine, so a loopback request proves
 * nothing. Decisions need a signed-in owner cookie or a Tailscale identity arriving through Serve.
 */
export function ownerSession(req: FastifyRequest, store: Store, config: Config): boolean {
  const token = req.headers.cookie?.split(";").map((p) => p.trim()).find((p) => p.startsWith("cl-owner="))?.slice(9);
  if (token && store.validOwnerSession(token)) return true;
  const login = req.headers["tailscale-user-login"];
  return typeof login === "string" && login === config.access.owner && !["127.0.0.1", "localhost", "::1"].includes(req.hostname);
}

export function refuseUnlessOwner(req: FastifyRequest, reply: FastifyReply, store: Store, config: Config): boolean {
  if (ownerSession(req, store, config)) return false;
  void reply.code(403).send({ error: "Only the owner's signed-in session can decide this. Open ContextLanes in your browser." });
  return true;
}
