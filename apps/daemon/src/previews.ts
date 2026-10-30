import type { Lane } from "@contextlanes/protocol";
import type { Config } from "./config.js";
import { Refused } from "./lanes/manager.js";
import { slugify } from "./lanes/naming.js";
import type { Runner } from "./run.js";

type Options = { config: Config; run: Runner; fetch?: typeof fetch };
type Serving = { TCP?: Record<string, unknown>; Web?: Record<string, { Handlers?: Record<string, { Proxy?: string }> }> };

/** One DNS label per lane service, unique because project and lane number are. */
export function previewLabel(lane: Pick<Lane, "id">, service: string): string {
  return slugify(`${service}-${lane.id.replace("/", "-")}`).slice(0, 63).replace(/-+$/, "");
}

/**
 * One private link per lane service, always on its own origin so single-page apps and hot reload
 * work; never a path. serve: a device HTTPS port, works on any signed-in tailnet machine.
 * services: a named Tailscale Service, needs a tagged host and an admin definition per name.
 * caddy: a subdomain of a wildcard certificate, through Caddy's loopback admin API.
 * This class only adds and removes its own routes; other Serve routes are left alone.
 */
export class Previews {
  private queue: Promise<unknown> = Promise.resolve();
  private readonly fetch: typeof fetch;

  constructor(private readonly options: Options) { this.fetch = options.fetch ?? fetch; }

  private get settings() { return this.options.config.previews; }

  /** Tailscale keeps one serve configuration, so changes to it run one at a time. */
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work);
    this.queue = next.catch(() => {});
    return next;
  }

  publish(lane: Pick<Lane, "id">, service: string, port: number): Promise<string> {
    return this.serial(async () => {
      const label = previewLabel(lane, service);
      if (this.settings.mode === "caddy") return this.addCaddy(label, port);
      return this.settings.mode === "services" ? this.addService(label, port) : this.addServe(port);
    });
  }

  unpublish(url: string): Promise<void> {
    return this.serial(async () => {
      const { hostname, port } = new URL(url);
      const label = hostname.split(".")[0]!;
      if (this.settings.mode === "caddy") await this.fetch(`${this.settings.caddy!.admin}/id/cl-${label}`, { method: "DELETE" });
      else if (this.settings.mode === "services") await this.options.run("tailscale", ["serve", "clear", `svc:${label}`], { timeout: 30_000 });
      else await this.options.run("tailscale", ["serve", `--https=${port}`, "off"], { timeout: 30_000 });
    });
  }

  private async status(): Promise<{ dns: string; suffix: string }> {
    const status = JSON.parse((await this.options.run("tailscale", ["status", "--json"], { timeout: 5000 })).stdout) as { BackendState?: string; MagicDNSSuffix?: string; Self?: { DNSName?: string } };
    const dns = status.Self?.DNSName?.replace(/\.$/, "");
    if (status.BackendState !== "Running" || !dns) throw new Refused("Tailscale is not signed in on this machine.");
    return { dns, suffix: status.MagicDNSSuffix?.replace(/\.$/, "") ?? dns.slice(dns.indexOf(".") + 1) };
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

  private async addService(label: string, port: number): Promise<string> {
    const { suffix } = await this.status();
    await this.options.run("tailscale", ["serve", `--service=svc:${label}`, "--https=443", "--yes", `http://127.0.0.1:${port}`], { timeout: 30_000 });
    return `https://${label}.${suffix}`;
  }

  private async addCaddy(label: string, port: number): Promise<string> {
    const caddy = this.settings.caddy!;
    await this.fetch(`${caddy.admin}/id/cl-${label}`, { method: "DELETE" });
    const host = `${label}.${caddy.domain}`;
    const response = await this.fetch(`${caddy.admin}/config/apps/http/servers/${caddy.server}/routes`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ "@id": `cl-${label}`, match: [{ host: [host] }], handle: [{ handler: "reverse_proxy", upstreams: [{ dial: `127.0.0.1:${port}` }] }], terminal: true }),
    });
    if (!response.ok) throw new Refused(`Caddy refused the route (${response.status}).`);
    return `https://${host}`;
  }
}
