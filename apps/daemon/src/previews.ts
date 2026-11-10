import { createHash } from "node:crypto";
import type { Lane } from "@contextlanes/protocol";
import type { Config } from "./config.js";
import { Refused } from "./lanes/manager.js";
import { PreviewRouter } from "./preview-router.js";
import type { Runner } from "./run.js";

type Options = { config: Config; run: Runner };
type Serving = { TCP?: Record<string, unknown>; Web?: Record<string, { Handlers?: Record<string, { Proxy?: string }> }> };

const LABEL_MAX = 63;

/**
 * One DNS label per lane service: `<service>-<n>-<project>`. A wildcard certificate covers exactly one
 * label, so this never nests. The lane number comes before the project, so a long project name is what
 * gets cut, and a cut name ends in a hash of the whole, so two lanes never share a label.
 */
export function previewLabel(lane: Pick<Lane, "id">, service: string): string {
  const [project = "", n = ""] = lane.id.split("/");
  const clean = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const full = [clean(service), clean(n), clean(project)].filter(Boolean).join("-") || "preview";
  if (full.length <= LABEL_MAX) return full;
  const hash = createHash("sha256").update(full).digest("hex").slice(0, 6);
  return `${full.slice(0, LABEL_MAX - 7).replace(/-+$/, "")}-${hash}`;
}

/** Host suffixes the router answers: the configured domain, and always `localhost` for this machine. */
export function routerSuffixes(config: Config): string[] {
  const { domain } = config.previews;
  return domain ? [domain, "localhost"] : ["localhost"];
}

/** Where a label is reached from a browser. */
export function routerUrl(config: Config, label: string): string {
  const p = config.previews;
  if (p.domain) return `${p.scheme ?? "https"}://${label}.${p.domain}`;
  return `http://${label}.localhost:${p.localPort}`;
}

/** The web app's own address through the router, when a domain is set. */
export function appOrigin(config: Config): string | null {
  return config.previews.mode === "router" && config.previews.domain ? routerUrl(config, config.previews.appLabel) : null;
}

/**
 * Hostnames the web app may be opened on besides localhost. Origin checks accept only these, so a page
 * on another name (a preview, or DNS rebinding) can never act as the owner's browser.
 */
export function appHostnames(config: Config): string[] {
  if (config.previews.mode !== "router") return [];
  return routerSuffixes(config).map((suffix) => `${config.previews.appLabel}.${suffix}`);
}

/**
 * Private links for lane services, each on its own origin so single-page apps and hot reload work;
 * never a path. router: one port answers every `<label>.<domain>` (behind the owner's own reverse
 * proxy and wildcard entry) and `<label>.localhost`. serve: a Tailscale Serve HTTPS port per service.
 */
export class Previews {
  private router?: PreviewRouter;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: Options) {}

  private get settings() { return this.options.config.previews; }

  /** The router, created on first use. The web app is always routed under its reserved label. */
  private get routes(): PreviewRouter {
    if (!this.router) {
      this.router = new PreviewRouter(this.settings.localPort, this.settings.bind, () => routerSuffixes(this.options.config));
      this.router.set(this.settings.appLabel, this.options.config.listen.port);
    }
    return this.router;
  }

  /** Opens the router port. Called at daemon start so the web app is reachable before any lane runs. */
  async start(): Promise<number | null> {
    return this.settings.mode === "router" ? this.routes.listen() : null;
  }

  /** A service's address, known before it starts. Null in serve mode, where the port is chosen on publish. */
  urlFor(lane: Pick<Lane, "id">, service: string): string | null {
    return this.settings.mode === "router" ? routerUrl(this.options.config, previewLabel(lane, service)) : null;
  }

  /** Tailscale keeps one serve configuration, so changes to it run one at a time. */
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work);
    this.queue = next.catch(() => {});
    return next;
  }

  async publish(lane: Pick<Lane, "id">, service: string, port: number): Promise<string> {
    if (this.settings.mode === "router") {
      // A table entry only: the port itself is opened once, at daemon start (start()).
      this.routes.set(previewLabel(lane, service), port);
      return this.urlFor(lane, service)!;
    }
    return this.serial(() => this.addServe(port));
  }

  async unpublish(url: string): Promise<void> {
    const { hostname, port } = new URL(url);
    if (this.settings.mode === "router") {
      const label = this.routes.labelOf(hostname);
      if (label && label !== this.settings.appLabel) this.routes.delete(label);
      return;
    }
    await this.serial(() => this.options.run("tailscale", ["serve", `--https=${port}`, "off"], { timeout: 30_000 }));
  }

  /** A raw label, for the doctor's temporary route. Router mode only. */
  publishLabel(label: string, port: number): void { if (this.settings.mode === "router") this.routes.set(label, port); }
  unpublishLabel(label: string): void { if (this.settings.mode === "router" && label !== this.settings.appLabel) this.routes.delete(label); }

  /** True when the router currently sends this lane service somewhere. */
  routed(lane: Pick<Lane, "id">, service: string): boolean {
    return this.settings.mode === "router" && !!this.router?.has(previewLabel(lane, service));
  }

  close(): void { this.router?.close(); }

  private async status(): Promise<{ dns: string }> {
    const status = JSON.parse((await this.options.run("tailscale", ["status", "--json"], { timeout: 5000 })).stdout) as { BackendState?: string; Self?: { DNSName?: string } };
    const dns = status.Self?.DNSName?.replace(/\.$/, "");
    if (status.BackendState !== "Running" || !dns) throw new Refused("Tailscale is not signed in on this machine.");
    return { dns };
  }

  private async addServe(port: number): Promise<string> {
    const { dns } = await this.status();
    const serving = JSON.parse((await this.options.run("tailscale", ["serve", "status", "--json"], { timeout: 5000 })).stdout || "{}") as Serving;
    const target = `http://127.0.0.1:${port}`;
    for (const [host, value] of Object.entries(serving.Web ?? {})) if (host.startsWith(`${dns}:`) && value.Handlers?.["/"]?.Proxy === target) return `https://${host}`;
    for (let candidate = this.settings.ports.from; candidate <= this.settings.ports.to; candidate++) {
      if (serving.TCP?.[candidate]) continue;
      await this.options.run("tailscale", ["serve", "--bg", `--https=${candidate}`, "--yes", target], { timeout: 30_000 });
      return `https://${dns}:${candidate}`;
    }
    throw new Refused(`Every preview port from ${this.settings.ports.from} to ${this.settings.ports.to} is in use. Stop an environment or widen [previews.ports].`);
  }
}
