import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { DoctorCheck } from "@contextlanes/protocol";
import type { Runner } from "../run.js";
import type { ControlInfo } from "./control.js";
import { helperBase, helperName } from "./folders.js";
import { API_PORT, DATA_MOUNT, NETWORK, SOCKET, TOOLS_IN_IMAGE, TOOLS_MARKER, TOOLS_MOUNT, TOOLS_VOLUME } from "./names.js";

export type DockerDoctorDeps = {
  /** Read once at start; null when the control service could not find its own container. */
  control: () => ControlInfo | null;
  /** The two tools folders, injectable for tests. */
  toolsMount?: string;
  toolsInImage?: string;
};

const readMarker = (dir: string) => readFile(join(dir, TOOLS_MARKER), "utf8").then((t) => t.trim(), () => null);

/** The Docker runtime's checks: Docker, the network, the tools volume, what is published and mounted. */
export async function dockerChecks(run: Runner, deps: DockerDoctorDeps): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  const add = (c: DoctorCheck) => { checks.push(c); };

  const server = await run("docker", ["version", "--format", "{{.Server.Version}}"], { timeout: 15_000 }).then((r) => r.stdout.trim(), (err: Error) => ({ error: err.message }));
  if (typeof server !== "string" || !server) {
    add({ id: "docker", title: "Docker", state: "fail", found: `not reachable through ${SOCKET}${typeof server === "string" ? "" : `: ${server.error.slice(0, 300)}`}`,
      fix: "compose.yaml mounts /var/run/docker.sock into the control container. Check that Docker runs on the host, then: docker compose up -d" });
  } else add({ id: "docker", title: "Docker", state: "ok", found: `server ${server}, reached through ${SOCKET}` });

  const control = deps.control();
  if (!control) add({ id: "control", title: "Control container", state: "fail", found: "could not find its own container through the Docker socket", fix: "Start it with docker compose up -d in the stack folder; the container must be named contextlanes." });

  const network = await run("docker", ["network", "inspect", "--format", "{{.Name}}", NETWORK], { timeout: 15_000 }).then((r) => r.stdout.trim() === NETWORK, () => false);
  const joined = !!control?.networks.includes(NETWORK);
  add(network && (joined || !control)
    ? { id: "network", title: "Network", state: "ok", found: `${NETWORK} exists${joined ? " and the control service is on it" : ""}` }
    : { id: "network", title: "Network", state: "fail", found: network ? `${NETWORK} exists, but the control service is not on it` : `no Docker network named ${NETWORK}`, fix: "Start the stack with docker compose up -d; compose.yaml creates and joins the network." });

  const [have, want] = await Promise.all([readMarker(deps.toolsMount ?? TOOLS_MOUNT), readMarker(deps.toolsInImage ?? TOOLS_IN_IMAGE)]);
  if (!want) add({ id: "tools", title: "Tools volume", state: "fail", found: `this image has no ${TOOLS_IN_IMAGE}/${TOOLS_MARKER}`, fix: "Rebuild the image: docker compose up -d --build" });
  else if (!have) add({ id: "tools", title: "Tools volume", state: "fail", found: `${TOOLS_VOLUME} is empty or not mounted at ${TOOLS_MOUNT}`, fix: "Restart the control service (docker compose restart); it fills the volume when it starts." });
  else if (have !== want) add({ id: "tools", title: "Tools volume", state: "fail", found: `${TOOLS_VOLUME} holds ${have}; this image has ${want}`, fix: "Restart the control service (docker compose restart); it refills the volume when the versions differ." });
  else add({ id: "tools", title: "Tools volume", state: "ok", found: `${TOOLS_VOLUME}: ${have}` });

  if (control) {
    const api = control.published.filter((p) => p.port === `${API_PORT}/tcp`);
    add(api.length
      ? { id: "api", title: "API", state: "fail", found: `port ${API_PORT} is published on ${api.map((p) => p.host).join(", ")}`, fix: `Remove the ${API_PORT} entry from ports in compose.yaml. The API is for the contextlanes network only.` }
      : { id: "api", title: "API", state: "ok", found: `port ${API_PORT} is not published; it answers only on the ${NETWORK} network and inside the container` });
    const router = control.published.filter((p) => p.port === "4601/tcp");
    add(router.length
      ? { id: "published", title: "Published ports", state: "ok", found: `preview router on ${router.map((p) => p.host).join(", ")}` }
      : { id: "published", title: "Published ports", state: "warn", found: "the preview router (4601) is not published", fix: "Links work only from inside the network. Keep the 4601 entry under ports in compose.yaml." });
    const extra = control.mounts.filter((m) => !(m.destination === DATA_MOUNT || m.destination === SOCKET || m.destination === TOOLS_MOUNT));
    add(extra.length
      ? { id: "mounts", title: "Mounts", state: "warn", found: `the control container mounts more than its data, the socket and the tools: ${extra.map((m) => `${m.source} → ${m.destination}`).join(", ")}`, fix: "Remove those volumes from compose.yaml. Project folders are mounted only into helper containers, one at a time." }
      : { id: "mounts", title: "Mounts", state: "ok", found: `only ${control.data ?? "./data"} → ${DATA_MOUNT}, the Docker socket and ${TOOLS_VOLUME}; none of your folders` });

    const helper = await run("docker", [...helperBase(helperName()), "--read-only", "--entrypoint", "true", control.image], { timeout: 60_000 }).then(() => null, (err: Error) => err.message);
    add(helper === null
      ? { id: "helpers", title: "Helper containers", state: "ok", found: "start and are removed (no network, no capabilities, one folder each)" }
      : { id: "helpers", title: "Helper containers", state: "fail", found: `could not start one: ${helper.slice(0, 300)}`, fix: "Read the message above; the helper uses the control service's own image." });
  }

  add({ id: "socket", title: "Docker socket", state: "ok",
    found: "The control service holds the Docker socket, which is root-equivalent on this host. Only it has the socket; helper containers and lanes never get it." });
  return checks;
}
