# Previews behind your reverse proxy

ContextLanes listens for previews on one port, the **router** (`[previews] localPort`, default 4601). Every lane service and the web app itself are reached by name on that port:

| Address | Goes to |
|---|---|
| `https://<service>-<n>-<project>.<domain>` | a lane's service, e.g. `https://web-01-shop.root.example.dev` |
| `https://lanes.<domain>` | the ContextLanes web app |
| `http://<label>.localhost:4601` | the same, from a browser on this machine, with no setup at all |

So reaching lanes from your laptop or phone takes three things, done once:

1. **A wildcard DNS record**: `*.root.example.dev` pointing at this machine (its LAN or tailnet address).
2. **One wildcard entry in your proxy**: `*.root.example.dev` → the router port, with WebSockets on (hot reload needs them) and a wildcard certificate by DNS challenge. Your proxy must pass the original `Host` header through, which all of the proxies below do by default.
3. **The domain in ContextLanes**: in `~/.config/contextlanes/config.toml`

   ```toml
   [previews]
   domain = "root.example.dev"
   ```

   then restart ContextLanes and run `contextlanes doctor`. It sends a request through DNS, TLS and your proxy to a temporary route and tells you which step fails, if one does.

New lanes need nothing more: their names already match the wildcard.

## Where the router listens

By default the router binds `127.0.0.1`, which is right when the proxy runs on the same machine outside Docker. When the proxy runs in a container it cannot reach the host's loopback; bind the router to an address the container can reach:

```toml
[previews]
bind = "172.17.0.1"   # Docker's default bridge on Linux; the proxy then forwards to 172.17.0.1:4601
```

Only the router can leave loopback; the API on port 4600 never does. Anything that can reach the router can open your lane previews, which are dev servers without sign-in, so prefer the Docker bridge or your tailnet address over `0.0.0.0`.

## Nginx Proxy Manager

**Hosts → Proxy Hosts → Add Proxy Host**

- **Domain Names:** `*.root.example.dev`
- **Scheme:** `http` · **Forward Hostname / IP:** `172.17.0.1` (or the host's address; `127.0.0.1` only if NPM runs with host networking) · **Forward Port:** `4601`
- **Websockets Support:** on
- **SSL:** request a new certificate for `*.root.example.dev` with **Use a DNS Challenge** (wildcard certificates require it), choose your DNS provider and give it an API token; turn on **Force SSL**.

NPM sends the original `Host` header to the upstream by default; leave the Advanced tab empty.

## Caddy

A wildcard certificate needs a Caddy build with your DNS provider's module (for example `caddy-dns/cloudflare`, through `xcaddy` or a prebuilt image that includes it).

```caddyfile
*.root.example.dev {
	tls {
		dns cloudflare {env.CLOUDFLARE_API_TOKEN}
	}
	reverse_proxy 127.0.0.1:4601
}
```

`reverse_proxy` passes the `Host` header through unchanged and proxies WebSockets without further settings.

## Traefik

File provider (dynamic configuration), Traefik v3:

```yaml
http:
  routers:
    contextlanes:
      rule: "Host(`*.root.example.dev`)"
      entryPoints: [websecure]
      service: contextlanes
      tls:
        certResolver: letsencrypt      # a resolver using the DNS challenge
        domains:
          - main: "root.example.dev"
            sans: ["*.root.example.dev"]
  services:
    contextlanes:
      loadBalancer:
        servers:
          - url: "http://172.17.0.1:4601"
```

`Host(`*.example.com`)` matches exactly one label, which is what ContextLanes uses. Traefik passes the `Host` header and WebSockets through by default.

## Tailscale Serve, without a domain

If you only use ContextLanes over your tailnet and do not want a domain, `[previews] mode = "serve"` gives each running service its own HTTPS port on this machine's Tailscale name (`https://neo.<tailnet>.ts.net:4701`). Links are only known once a service is healthy, so the `LANE_URL` variables are not set in this mode.

## When it does not work

Run `contextlanes doctor` (or Settings → Health check). The chain check names the failing step:

| It says | Do this |
|---|---|
| does not resolve | add the wildcard DNS record, or wait for it to propagate |
| TLS failed | give the proxy a certificate for `*.<domain>` (DNS challenge) |
| did not answer | the proxy is not running, or is not reachable on that address |
| something other than the router answered | the wildcard entry points somewhere else, or at the wrong port |
| the router answered, but not for this name | the proxy rewrites `Host`; pass the original through |
| WebSockets: upgrade did not get through | turn on WebSocket support for the entry |

A dev server that refuses the name (Vite's "Blocked request", Next.js cross-origin warnings) is covered in [RECIPES.md](RECIPES.md#where-services-are-reached).
