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
3. **The domain in ContextLanes**: in `~/.config/contextlanes/config.toml` (Docker: `data/config.toml` in the stack folder, then `docker compose restart`)

   ```toml
   [previews]
   domain = "root.example.dev"
   ```

   then restart ContextLanes and run `contextlanes doctor`. It sends a request through DNS, TLS and your proxy to a temporary route and tells you which step fails, if one does.

New lanes need nothing more: their names already match the wildcard.

## Where the router listens in Docker

The router runs inside the control container and listens on port 4601 there. `compose.yaml` publishes it on `127.0.0.1:4601` only, so a proxy that runs on this machine outside Docker (or in a container with host networking) forwards to `127.0.0.1:4601` with nothing more to do. A proxy that runs in its own container, such as Nginx Proxy Manager, cannot reach the host's `127.0.0.1`. Use one of these two; `contextlanes doctor` says which one this machine allows now (its "Reverse proxy to the router" line).

**(a) Put the proxy's container on the `contextlanes` network.** Nothing more is published.

```sh
docker ps --format '{{.Names}}'                                 # find your proxy's container name
docker network connect contextlanes nginx-proxy-manager-app-1   # your name here
```

Then point the wildcard entry at **`contextlanes`**, port **`4601`**, scheme `http`. `docker network connect` lasts until that container is recreated; to keep it, add the network to the proxy's own `compose.yaml`:

```yaml
services:
  app:                      # your proxy's service name
    networks: [default, contextlanes]
networks:
  contextlanes:
    external: true
```

On that network the proxy can also reach the API (`contextlanes:4600`, which still answers only with a token) and each lane's services by container name (`cl-<project>-<NN>:<port>`), as the router does. Lane services are dev servers without sign-in.

**(b) Publish the router on every address.** In `compose.yaml` change

```yaml
    ports:
      - "127.0.0.1:4601:4601"
```

to

```yaml
    ports:
      - "4601:4601"
```

then run `docker compose up -d` in the stack folder. The proxy then forwards to this machine's LAN or tailnet address, port `4601`. So does anything else that can reach this machine on 4601, and it reaches every running lane preview; keep 4601 closed to networks you do not trust.

In Docker `[previews] bind` is not used for this: the router listens on every address inside its container, and `compose.yaml` decides what reaches it from outside.

A lane's service must listen on `0.0.0.0` inside its lane (ContextLanes sets `HOST=0.0.0.0` and `PORT`): the router reaches it as `cl-<project>-<NN>:<port>` over the `contextlanes` network. A dev server that listens only on `127.0.0.1` (Vite and Next.js do by default) cannot be reached; `contextlanes app status` and `doctor` say so. Pass `--host $HOST` to Vite, `-H $HOST` to `next dev`.

## Where the router listens on the host

By default the router binds `127.0.0.1`, which is right when the proxy runs on the same machine outside Docker. When the proxy runs in a container it cannot reach the host's loopback; bind the router to an address the container can reach:

```toml
[previews]
bind = "172.17.0.1"   # Docker's default bridge on Linux; the proxy then forwards to 172.17.0.1:4601
```

Only the router can leave loopback; the API on port 4600 never does. Anything that can reach the router can open your lane previews, which are dev servers without sign-in, so prefer the Docker bridge or your tailnet address over `0.0.0.0`.

## Nginx Proxy Manager

**Hosts → Proxy Hosts → Add Proxy Host**

- **Domain Names:** `*.root.example.dev`
- **Scheme:** `http` · **Forward Hostname / IP:** in Docker, `contextlanes` with (a) above, or this machine's address with (b); on the host runtime, `172.17.0.1` (or the host's address; `127.0.0.1` only if NPM runs with host networking) · **Forward Port:** `4601`
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

Host runtime only (the Docker runtime has no Tailscale in its container). If you only use ContextLanes over your tailnet and do not want a domain, `[previews] mode = "serve"` gives each running service its own HTTPS port on this machine's Tailscale name (`https://neo.<tailnet>.ts.net:4701`). Links are only known once a service is healthy, so the `LANE_URL` variables are not set in this mode.

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
| Reverse proxy to the router: neither (a) nor (b) | a proxy in a container cannot reach `127.0.0.1:4601`; see [Where the router listens in Docker](#where-the-router-listens-in-docker) |
| Services on loopback only | the lane's dev server listens on `127.0.0.1`; make it listen on `$HOST` (`0.0.0.0` in a lane) |

A dev server that refuses the name (Vite's "Blocked request", Next.js cross-origin warnings) is covered in [RECIPES.md](RECIPES.md#where-services-are-reached).
