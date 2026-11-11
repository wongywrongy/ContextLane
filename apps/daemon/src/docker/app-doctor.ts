import { request } from "node:http";
import type { DoctorCheck, Lane } from "@contextlanes/protocol";
import type { Config } from "../config.js";
import type { Store } from "../db/store.js";
import { ROUTER_NOT_FOUND } from "../preview-router.js";
import { previewLabel } from "../previews.js";
import type { Runner } from "../run.js";
import type { Runtime } from "../runtime.js";
import { loopbackDetail } from "../runtime.js";
import type { ControlInfo } from "./control.js";
import type { DockerLanes } from "./lanes.js";
import { CONTROL_LABEL, HELPER_PREFIX, LANE_LABEL, NETWORK } from "./names.js";

/** One plain GET: `host` is the Host header (the router picks a route by it), the URL says where to connect. */
export type HostGet = (url: string, host?: string) => Promise<{ status: number; body: string }>;

export const hostGet: HostGet = (url, host) => new Promise((resolve, reject) => {
  const u = new URL(url);
  const req = request({ hostname: u.hostname, port: u.port, path: `${u.pathname}${u.search}`, method: "GET", timeout: 5000, headers: host ? { host } : {} }, (res) => {
    let body = ""; res.setEncoding("utf8");
    res.on("data", (d: string) => { if (body.length < 4096) body += d; });
    res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
  });
  req.on("timeout", () => req.destroy(new Error("timed out after 5 seconds")));
  req.on("error", reject);
  req.end();
});

export type AppDoctorDeps = { config: Config; store: Store; runtime: Runtime; lanes: DockerLanes; get?: HostGet };

const open = (store: Store, lanes: DockerLanes) => store.listLanes().filter((l) => !["cleaned", "archived"].includes(l.state) && lanes.isDocker(l));

/**
 * Phase 4's checks (docs/V4.md 3.4): each running lane service is reached by its container's name and
 * through the router with its own Host header; a service that listens only on loopback inside its lane is
 * named; lanes waiting for a recipe approval are listed.
 */
export async function appChecks(deps: AppDoctorDeps): Promise<DoctorCheck[]> {
  const { config, store, runtime, lanes } = deps;
  const get = deps.get ?? hostGet;
  const checks: DoctorCheck[] = [];
  const healthy: { lane: Lane; name: string; port: number; path: string; status: number }[] = [];
  const loopback: string[] = [];
  for (const lane of open(store, lanes)) {
    for (const s of store.environment(lane.id)?.services ?? []) {
      if (s.state === "stopped") continue;
      if (s.state === "healthy") healthy.push({ lane, name: s.name, port: s.port, path: s.healthPath, status: s.healthStatus });
      const seen = await runtime.listening(lane.id, s.name).catch(() => null);
      if (seen?.loopbackOnly) loopback.push(`${lane.id} ${s.name}: ${loopbackDetail(seen.addresses, s.port)}`);
    }
  }

  if (!healthy.length) checks.push({ id: "app-links", title: "Lane app links", state: "ok", found: "no lane service is healthy right now, so there is nothing to reach; start one with contextlanes app start <lane>" });
  else {
    const bad: string[] = [], good: string[] = [];
    const router = `http://127.0.0.1:${config.previews.localPort}`;
    for (const h of healthy) {
      const where = runtime.addressOf(h.lane, h.port);
      const direct = await get(`http://${where}${h.path}`).catch((err: Error) => ({ status: 0, body: err.message }));
      if (direct.status !== h.status) { bad.push(`${h.lane.id} ${h.name}: ${where}${h.path} ${direct.status ? `answered ${direct.status}` : `did not answer (${direct.body.slice(0, 120)})`} from the control service`); continue; }
      const label = previewLabel(h.lane, h.name);
      const routed = await get(`${router}${h.path}`, `${label}.localhost`).catch((err: Error) => ({ status: 0, body: err.message }));
      if (routed.status === 404 && routed.body.startsWith(ROUTER_NOT_FOUND)) bad.push(`${h.lane.id} ${h.name}: the router has no route for ${label}`);
      else if (routed.status !== h.status) bad.push(`${h.lane.id} ${h.name}: through the router (${label}.localhost) it answered ${routed.status || "nothing"}`);
      else good.push(`${h.lane.id} ${h.name} at ${where}`);
    }
    checks.push(bad.length
      ? { id: "app-links", title: "Lane app links", state: "fail", found: bad.join("; "), fix: "Read the service's logs (contextlanes logs <service> <lane>) and restart it (contextlanes app restart <lane> <service>). A lane container that is not on the contextlanes network is not reachable by name: contextlanes doctor lists lane containers." }
      : { id: "app-links", title: "Lane app links", state: "ok", found: `reached by name and through the router: ${good.join(", ")}` });
  }

  checks.push(loopback.length
    ? { id: "loopback", title: "Services on loopback only", state: "warn", found: loopback.join(" ") }
    : { id: "loopback", title: "Services on loopback only", state: "ok", found: "no running lane service listens only on 127.0.0.1" });

  const waiting = open(store, lanes).flatMap((lane) => {
    const asked = store.eventsOfType(["recipe.requested"], { lanes: [lane.id] }).at(-1)?.payload.hash;
    return asked && !store.recipeApproved(lane.project, asked) ? [`${lane.id} (recipe ${asked.slice(0, 7)})`] : [];
  });
  checks.push(waiting.length
    ? { id: "recipes", title: "Recipes waiting for you", state: "warn", found: `${waiting.join(", ")}: the app cannot start until you approve`, fix: "Read it first, then approve: contextlanes recipe <lane>, then contextlanes approve <lane>" }
    : { id: "recipes", title: "Recipes waiting for you", state: "ok", found: "no lane waits for a recipe approval" });
  return checks;
}

const ALL = /^(0\.0\.0\.0|\[?::\]?):/;

/**
 * How a reverse proxy can reach the router (docs/PROXY.md): (a) a proxy container on the contextlanes
 * network reaches contextlanes:4601; (b) with the port published on every address, anything that reaches
 * this machine does. Published on 127.0.0.1 only, the router is for processes on this machine outside
 * containers (or with host networking).
 */
export async function proxyCheck(run: Runner, control: ControlInfo, config: Config): Promise<DoctorCheck> {
  // UNVERIFIED: the {{.Label "…"}} template of docker ps and --filter network=, from memory.
  const out = await run("docker", ["ps", "--filter", `network=${NETWORK}`, "--format", `{{.Names}}\t{{.Label "${LANE_LABEL}"}}\t{{.Label "${CONTROL_LABEL}"}}`], { timeout: 15_000 }).then((r) => r.stdout, () => null);
  const others = (out ?? "").split("\n").map((l) => l.split("\t")).filter(([name, lane, ctl]) => name && !lane && ctl !== "1" && name !== control.name && !name.startsWith(HELPER_PREFIX)).map(([name]) => name!);
  const published = control.published.filter((p) => p.port === `${config.previews.localPort}/tcp` || p.port === "4601/tcp").map((p) => p.host);
  const everywhere = published.filter((h) => ALL.test(h));
  const a = others.length
    ? `(a) on the ${NETWORK} network: ${others.join(", ")}; a proxy there reaches the router at contextlanes:4601`
    : out === null ? `(a) could not list the containers on the ${NETWORK} network` : `(a) no other container is on the ${NETWORK} network`;
  const b = everywhere.length
    ? `(b) the router is published on ${everywhere.join(", ")}: a proxy anywhere that reaches this machine uses <this machine's address>:4601`
    : published.length ? `(b) the router is published on ${published.join(", ")} only: processes on this machine reach it, a proxy in a container does not` : "(b) the router is not published";
  const works = others.length > 0 || everywhere.length > 0;
  return {
    id: "proxy", title: "Reverse proxy to the router", state: works || !config.previews.domain ? "ok" : "warn", found: `${a}. ${b}.`,
    ...(works ? {} : { fix: `For a proxy in a container (Nginx Proxy Manager): docker network connect ${NETWORK} <proxy container>, then point the wildcard entry at contextlanes:4601. Or publish the router on every address: change "127.0.0.1:4601:4601" to "4601:4601" in compose.yaml and run docker compose up -d. docs/PROXY.md has both.` }),
  };
}
