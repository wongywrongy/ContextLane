import { randomBytes } from "node:crypto";
import { lookup } from "node:dns/promises";
import { createServer, request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { userInfo } from "node:os";
import type { DoctorCheck, DoctorReport } from "@contextlanes/protocol";
import type { Config } from "./config.js";
import { ROUTER_NOT_FOUND } from "./preview-router.js";
import type { Previews } from "./previews.js";
import { routerUrl } from "./previews.js";
import type { Runner } from "./run.js";
import { checkSandbox } from "./sandbox.js";
import { findExecutable } from "./setup.js";

type Check = DoctorCheck;

/** How the chain is reached, injectable so each failing hop can be tested. */
export type Net = {
  resolve: (host: string) => Promise<string[]>;
  get: (url: string) => Promise<{ status: number; body: string }>;
  upgrade: (url: string) => Promise<{ status: number; echoed: boolean }>;
};

export type DoctorDeps = { config: Config; run: Runner; version: string; previews: Previews; find?: (name: string) => Promise<string | null>; net?: Partial<Net> };

const MIN_NODE = [22, 13];

export async function doctor(deps: DoctorDeps): Promise<DoctorReport> {
  const { config, run } = deps;
  const find = deps.find ?? findExecutable;
  const checks: Check[] = [];
  const add = (check: Check) => { checks.push(check); };

  const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
  const nodeOk = major > MIN_NODE[0]! || (major === MIN_NODE[0] && minor >= MIN_NODE[1]!);
  add({ id: "node", title: "Node.js", state: nodeOk ? "ok" : "fail", found: process.versions.node, ...(nodeOk ? {} : { fix: "Install Node.js 22.13 or newer (24 recommended)." }) });

  for (const [name, why] of [["git", "lanes are git worktrees"], ["tmux", "lane terminals"], ["python3", "the browser terminal"]] as const) {
    const path = await find(name);
    add({ id: name, title: name, state: path ? "ok" : "fail", found: path ?? "not found", ...(path ? {} : { fix: `Install ${name} (${why}).` }) });
  }

  const agents = (await Promise.all(["claude", "codex"].map(async (n) => (await find(n)) ? n : null))).filter(Boolean);
  add({ id: "agents", title: "Agent CLIs", state: agents.length ? "ok" : "warn", found: agents.length ? agents.join(", ") : "neither claude nor codex",
    ...(agents.length ? {} : { fix: "Install Claude Code or Codex to run agents in lanes. Lanes without an agent work without them." }) });

  const driver = config.supervisor.driver === "process" ? "process" : "systemd";
  if (driver === "systemd") {
    const linger = await run("loginctl", ["show-user", userInfo().username, "--property=Linger", "--value"], { timeout: 5000 }).then((r) => r.stdout.trim(), () => "");
    add({ id: "supervisor", title: "Lane services", state: linger === "no" ? "warn" : "ok", found: `systemd user units${linger === "yes" ? ", keeps running after logout" : ""}`,
      ...(linger === "no" ? { fix: `Keep services running after you log out: sudo loginctl enable-linger ${userInfo().username}` } : {}) });
  } else {
    add({ id: "supervisor", title: "Lane services", state: "ok", found: "process groups watched by the daemon (no systemd user session)" });
  }

  if (config.sandbox.mode === "off") {
    add({ id: "sandbox", title: "Sandbox", state: "warn", found: "off: agents run with your full access", fix: 'Where bubblewrap works, set [sandbox] mode = "bwrap".' });
  } else {
    const works = await checkSandbox(run, config).catch(() => false);
    add({ id: "sandbox", title: "Sandbox", state: works ? "ok" : "fail", found: works ? "bubblewrap hides ContextLanes' data from lanes" : "bubblewrap is missing or not working",
      ...(works ? {} : { fix: `Install bubblewrap (sudo apt install bubblewrap). Where it cannot run, [sandbox] mode = "off" lets agents start unconfined.` }) });
  }

  const p = config.previews;
  if (p.mode === "serve") {
    const tailscale = await run("tailscale", ["status", "--json"], { timeout: 5000 }).then((r) => (JSON.parse(r.stdout) as { BackendState?: string }).BackendState === "Running", () => false);
    add({ id: "router", title: "Preview links", state: tailscale ? "ok" : "fail", found: tailscale ? "Tailscale Serve" : "Tailscale is not running", ...(tailscale ? {} : { fix: "Sign in to Tailscale, or use mode = \"router\" with your own reverse proxy." }) });
  } else {
    add(await routerCheck(config, deps.net?.get ?? get));
    if (p.domain) checks.push(...await chainChecks(deps, { ...defaultNet(), ...deps.net }));
    else add({ id: "domain", title: "Links from other devices", state: "warn", found: "no domain: links work only on this machine", fix: "Set [previews] domain and add one wildcard entry in your reverse proxy (docs/PROXY.md)." });
  }

  return {
    version: deps.version, node: process.versions.node, platform: `${process.platform}-${process.arch}`, supervisor: driver, sandbox: config.sandbox.mode,
    previews: { mode: p.mode, domain: p.domain ?? null, bind: p.bind, port: p.localPort }, checks,
  };
}

/** The router answers on its own port with its own 404 for a name it does not know. */
async function routerCheck(config: Config, fetchText: Net["get"]): Promise<Check> {
  const { bind, localPort } = config.previews;
  const host = bind === "0.0.0.0" || bind === "::" ? "127.0.0.1" : bind.includes(":") ? `[${bind}]` : bind;
  const reply = await fetchText(`http://${host}:${localPort}/`).catch(() => null);
  const ours = reply?.status === 404 && reply.body.startsWith(ROUTER_NOT_FOUND);
  return { id: "router", title: "Preview router", state: ours ? "ok" : "fail", found: ours ? `listening on ${bind}:${localPort}` : reply ? `something else answers on ${bind}:${localPort}` : `nothing answers on ${bind}:${localPort}`,
    ...(ours ? {} : { fix: `Restart ContextLanes and read its log; another program may hold port ${localPort} ([previews] localPort).` }) };
}

/**
 * A temporary route to a responder that answers with a nonce, then the same request through DNS, TLS and
 * the owner's proxy. Where it breaks says what to fix. Then once more as a WebSocket, which hot reload needs.
 */
async function chainChecks(deps: DoctorDeps, net: Net): Promise<Check[]> {
  const { config } = deps;
  const domain = config.previews.domain!;
  const label = `cl-doctor-${randomBytes(4).toString("hex")}`;
  const nonce = randomBytes(12).toString("hex");
  const url = routerUrl(config, label);
  const host = new URL(url).hostname;
  const responder = createServer((_req, res) => res.end(nonce));
  responder.on("upgrade", (req, socket) => {
    socket.write("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: contextlanes-doctor\r\n\r\n");
    socket.on("data", (d) => socket.end(d));
  });
  await new Promise<void>((resolve) => responder.listen(0, "127.0.0.1", resolve));
  deps.previews.publishLabel(label, (responder.address() as { port: number }).port);
  try {
    const addresses = await net.resolve(host).catch(() => []);
    if (!addresses.length) return [{ id: "chain", title: `Links at *.${domain}`, state: "fail", found: `${host} does not resolve`, fix: `Add a wildcard DNS record *.${domain} pointing at this machine (or its tailnet address).` }];
    let reply: { status: number; body: string };
    try { reply = await net.get(url); } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const tls = /certificate|ssl|tls|self.signed|altname|CERT_|ERR_TLS/i.test(message);
      return [{ id: "chain", title: `Links at *.${domain}`, state: "fail", found: tls ? `TLS failed for ${host}: ${message}` : `${host} (${addresses[0]}) did not answer: ${message}`,
        fix: tls ? `Give your proxy a certificate for *.${domain} (a wildcard certificate by DNS challenge).` : `Check that your reverse proxy is running and reachable from this machine on ${addresses[0]}.` }];
    }
    if (reply.body === nonce) {
      const ws = await net.upgrade(url).catch(() => ({ status: 0, echoed: false }));
      return [
        { id: "chain", title: `Links at *.${domain}`, state: "ok", found: `DNS, TLS and your proxy reach the router (${addresses[0]})` },
        ws.status === 101 && ws.echoed
          ? { id: "websocket", title: "WebSockets (hot reload)", state: "ok", found: "pass through your proxy" }
          : { id: "websocket", title: "WebSockets (hot reload)", state: "warn", found: ws.status ? `your proxy answered ${ws.status} to an upgrade` : "the upgrade did not get through", fix: "Turn on WebSocket support for the wildcard entry in your proxy." },
      ];
    }
    if (reply.status === 404 && reply.body.startsWith(ROUTER_NOT_FOUND)) {
      return [{ id: "chain", title: `Links at *.${domain}`, state: "fail", found: "the router answered, but not for this name", fix: "Your proxy changes the Host header. Pass the original Host through to the router." }];
    }
    return [{ id: "chain", title: `Links at *.${domain}`, state: "fail", found: `something other than the router answered (${reply.status})`,
      fix: `Point the wildcard entry *.${domain} in your proxy at this machine's router port ${config.previews.localPort} (docs/PROXY.md).` }];
  } finally {
    deps.previews.unpublishLabel(label);
    responder.close();
    responder.closeAllConnections();
  }
}

function get(url: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = (url.startsWith("https:") ? httpsRequest : httpRequest)(url, { method: "GET", timeout: 8000 }, (res) => {
      let body = ""; res.setEncoding("utf8");
      res.on("data", (d: string) => { if (body.length < 4096) body += d; });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("timeout", () => req.destroy(new Error("timed out after 8 seconds")));
    req.on("error", reject);
    req.end();
  });
}

function upgrade(url: string): Promise<{ status: number; echoed: boolean }> {
  return new Promise((resolve, reject) => {
    const req = (url.startsWith("https:") ? httpsRequest : httpRequest)(url, { headers: { Connection: "Upgrade", Upgrade: "contextlanes-doctor" }, timeout: 8000 });
    req.on("upgrade", (res, socket) => {
      socket.once("data", (d) => { resolve({ status: res.statusCode ?? 0, echoed: d.toString() === "ping" }); socket.destroy(); });
      socket.write("ping");
      setTimeout(() => { resolve({ status: res.statusCode ?? 0, echoed: false }); socket.destroy(); }, 4000).unref();
    });
    req.on("response", (res) => { res.resume(); resolve({ status: res.statusCode ?? 0, echoed: false }); });
    req.on("timeout", () => req.destroy(new Error("timed out")));
    req.on("error", reject);
    req.end();
  });
}

function defaultNet(): Net {
  return { resolve: async (host) => (await lookup(host, { all: true })).map((a) => a.address), get, upgrade };
}
