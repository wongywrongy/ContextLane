import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, basename } from "node:path";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { generateRegistrationOptions, verifyRegistrationResponse, generateAuthenticationOptions, verifyAuthenticationResponse } from "@simplewebauthn/server";
import { AddProjectRequest, AgentId, ClaimCode, LoginOwnerRequest, ProjectId, RegisterOwnerRequest, SetupSettings } from "@contextlanes/protocol";
import webPush from "web-push";
import { Config, configPath, saveConfig } from "./config.js";
import type { Store } from "./db/store.js";
import type { Runner } from "./run.js";
import { slugify } from "./lanes/naming.js";

export class SetupError extends Error { constructor(message: string, readonly statusCode = 400) { super(message); } }
const agents = {
  "claude-code": { cli: "claude", adapter: "claude-agent-acp", login: "claude-agent-acp --cli, then /login", package: "@agentclientprotocol/claude-agent-acp@0.99.1" },
  codex: { cli: "codex", adapter: "codex-acp", login: "codex login --device-auth", package: "@agentclientprotocol/codex-acp@2.5.0" },
  opencode: { cli: "opencode", adapter: "opencode", login: "opencode auth login", package: null },
};

export async function findExecutable(name: string): Promise<string | null> {
  if (isAbsolute(name)) {
    try { await access(name, constants.X_OK); return name; } catch { return null; }
  }
  for (const directory of [...(process.env.PATH ?? "").split(":"), join(homedir(), ".local/bin")]) {
    const path = join(directory, name);
    try { await access(path, constants.X_OK); return path; } catch { /* Try the next PATH entry. */ }
  }
  return null;
}

type Challenge = { value: string; origin: string; rpId: string; expires: number; kind: "register" | "login" };
export class SetupManager {
  readonly claimFile: string;
  private challenges = new Map<string, Challenge>();
  private writing = Promise.resolve();
  private claiming = false;
  constructor(readonly config: Config, private store: Store, private run: Runner,
    private options: { path?: string; find?: typeof findExecutable; fetch?: typeof fetch; changed?: () => Promise<void> } = {}) {
    this.claimFile = join(config.paths.data, "claim-code");
  }
  get claimed(): boolean { return !!(this.config.access.owner || this.config.access.passkey); }
  async initialize(): Promise<void> {
    if (!this.claimed) {
      await mkdir(this.config.paths.data, { recursive: true, mode: 0o700 });
      try { await writeFile(this.claimFile, randomBytes(24).toString("base64url"), { mode: 0o600, flag: "wx" }); }
      catch (err) { if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err; }
    }
    for (const p of this.config.projects) {
      const id = ProjectId.parse(slugify(p.name ?? basename(p.path)));
      if (!this.store.getProject(id)) this.store.addProject({ id, name: p.name ?? basename(p.path), path: p.path });
    }
  }
  authorized(login: unknown, cookie: string | undefined, hostname = "127.0.0.1"): boolean {
    if (!this.claimed) return false;
    if (typeof login === "string") return login === this.config.access.owner;
    const token = cookie?.split(";").map((p) => p.trim()).find((p) => p.startsWith("cl-owner="))?.slice(9);
    return !!(token && this.store.validOwnerSession(token)) || (this.config.access.allowLocal && ["127.0.0.1", "localhost"].includes(hostname));
  }
  async checkCode(body: unknown): Promise<void> {
    const { code } = ClaimCode.parse(body);
    if (this.claimed) throw new SetupError("This machine is already claimed", 409);
    const actual = await readFile(this.claimFile, "utf8");
    if (Buffer.byteLength(code) !== Buffer.byteLength(actual) || !timingSafeEqual(Buffer.from(code), Buffer.from(actual))) throw new SetupError("Incorrect claim code", 403);
  }
  private async claim(body: unknown, action: () => Promise<void>): Promise<string> {
    if (this.claiming) throw new SetupError("A claim is already in progress", 409);
    this.claiming = true;
    try {
      await this.checkCode(body);
      await action();
      await rm(this.claimFile, { force: true });
      return this.store.ownerSession();
    } finally { this.claiming = false; }
  }
  claimTailnet(body: unknown, login: unknown): Promise<string> {
    if (typeof login !== "string" || !login.trim()) throw new SetupError("Open this page through your Tailscale Serve URL to claim with your tailnet identity");
    return this.claim(body, () => this.update({ access: { ...this.config.access, owner: login } }));
  }
  private remember(value: string, origin: string, rpId: string, kind: Challenge["kind"]): string {
    for (const [id, c] of this.challenges) if (c.expires < Date.now()) this.challenges.delete(id);
    if (this.challenges.size >= 128) throw new SetupError("Too many sign-in attempts; try again in five minutes", 429);
    const id = randomUUID();
    this.challenges.set(id, { value, origin, rpId, kind, expires: Date.now() + 300_000 });
    return id;
  }
  private take(id: string, origin: string, kind: Challenge["kind"]): Challenge {
    const c = this.challenges.get(id);
    this.challenges.delete(id);
    if (!c || c.expires < Date.now() || c.origin !== origin || c.kind !== kind) throw new SetupError("Sign-in challenge expired or belongs to another origin");
    return c;
  }
  async registration(body: unknown, origin: string) {
    await this.checkCode(body);
    const url = new URL(origin);
    if (url.protocol !== "https:" && url.hostname !== "localhost") throw new SetupError("Passkeys need HTTPS or http://localhost. Open localhost instead of 127.0.0.1");
    const options = await generateRegistrationOptions({ rpName: "ContextLanes", rpID: url.hostname, userName: "Owner", attestationType: "none", authenticatorSelection: { residentKey: "preferred", userVerification: "required" }, supportedAlgorithmIDs: [-7] });
    return { options, challengeId: this.remember(options.challenge, origin, url.hostname, "register") };
  }
  async register(body: unknown, origin: string): Promise<string> {
    const b = RegisterOwnerRequest.parse(body);
    return this.claim(b, async () => {
      const c = this.take(b.challengeId, origin, "register");
      const result = await verifyRegistrationResponse({ response: b.response, expectedChallenge: c.value, expectedOrigin: origin, expectedRPID: c.rpId, requireUserVerification: true, supportedAlgorithmIDs: [-7] }).catch(() => { throw new SetupError("Passkey verification failed"); });
      if (!result.verified) throw new SetupError("Passkey verification failed");
      const key = result.registrationInfo.credential;
      await this.update({ access: { ...this.config.access, passkey: { id: key.id, publicKey: Buffer.from(key.publicKey).toString("base64url"), counter: key.counter, rpId: c.rpId, transports: key.transports } } });
    });
  }
  async authentication(origin: string) {
    const key = this.config.access.passkey;
    if (!key || new URL(origin).hostname !== key.rpId) throw new SetupError("Open the address where this passkey was registered");
    const options = await generateAuthenticationOptions({ rpID: key.rpId, userVerification: "required", allowCredentials: [{ id: key.id, transports: key.transports }] });
    return { options, challengeId: this.remember(options.challenge, origin, key.rpId, "login") };
  }
  async login(body: unknown, origin: string): Promise<string> {
    const b = LoginOwnerRequest.parse(body);
    const c = this.take(b.challengeId, origin, "login");
    const key = this.config.access.passkey;
    if (!key || b.response.id !== key.id) throw new SetupError("Unknown passkey", 403);
    const result = await verifyAuthenticationResponse({ response: { ...b.response, response: { ...b.response.response, userHandle: b.response.response.userHandle ?? undefined } }, expectedChallenge: c.value, expectedOrigin: origin, expectedRPID: c.rpId,
      credential: { id: key.id, publicKey: Buffer.from(key.publicKey, "base64url"), counter: key.counter, transports: key.transports }, requireUserVerification: true }).catch(() => { throw new SetupError("Passkey verification failed", 403); });
    if (!result.verified) throw new SetupError("Passkey verification failed", 403);
    await this.update({ access: { ...this.config.access, passkey: { ...key, counter: result.authenticationInfo.newCounter } } });
    return this.store.ownerSession();
  }
  update(patch: Partial<Config>): Promise<void> {
    const write = this.writing.then(async () => {
      const next = Config.parse({ ...this.config, ...patch });
      if (next.access.passkey && this.config.access.passkey?.id === next.access.passkey.id && next.access.passkey.counter < this.config.access.passkey.counter) throw new SetupError("Passkey counter moved backwards; try signing in again", 409);
      await saveConfig(next, this.options.path ?? configPath());
      Object.assign(this.config, next);
      await this.options.changed?.();
    });
    this.writing = write.catch(() => {});
    return write;
  }
  async settings(body: unknown): Promise<void> {
    const { lanes, ...b } = SetupSettings.parse(body);
    await this.update({ ...b, ...(lanes ? { lanes: { ...this.config.lanes, ...lanes } } : {}) });
  }
  async addProject(body: unknown) {
    const p = AddProjectRequest.parse(body);
    if (!isAbsolute(p.path)) throw new SetupError("Use an absolute repository path on this machine");
    const root = (await this.run("git", ["rev-parse", "--show-toplevel"], { cwd: p.path, timeout: 5000 })).stdout.trim();
    if (!isAbsolute(root)) throw new SetupError("Git did not return an absolute repository root");
    const project = { path: root, name: p.name ?? basename(root) };
    const id = ProjectId.parse(slugify(project.name));
    const existing = this.store.getProject(id);
    if (existing && existing.path !== root) throw new SetupError("That project name already points to another repository", 409);
    if (this.store.listProjects().some((p) => p.path === root && p.id !== id)) throw new SetupError("That repository is already registered under another name", 409);
    await this.update({ projects: [...this.config.projects.filter((p) => p.path !== root), project] });
    return existing ?? this.store.addProject({ ...project, id });
  }
  async detectAgents() {
    return Promise.all(Object.entries(agents).map(async ([id, a]) => {
      const find = this.options.find ?? findExecutable;
      const cli = await find(a.cli);
      const configured = this.config.agents[id];
      const adapter = await find(configured?.command ?? a.adapter);
      let login = "unknown";
      if (cli) {
        try {
          const args = id === "claude-code" ? ["auth", "status", "--json"] : id === "codex" ? ["login", "status"] : ["auth", "list"];
          const { stdout } = await this.run(cli, args, { timeout: 5000 });
          // shortcut: OpenCode has no stable JSON login status; keep unknown until it does.
          login = id === "claude-code" ? (JSON.parse(stdout).loggedIn === true ? "ready" : "required") : id === "codex" ? "ready" : "unknown";
        } catch { login = "required"; }
      }
      return { id, cli, adapter, login, loginCommand: a.login, installable: !!a.package };
    }));
  }
  async installAgent(body: unknown) {
    const { id } = AgentId.transform((id) => ({ id })).parse((body as { id?: unknown })?.id);
    const a = agents[id];
    if (!a.package) throw new SetupError("Install OpenCode using its own installer, then check again");
    await this.run("npm", ["install", "--global", "--prefix", join(homedir(), ".local"), a.package], { timeout: 180_000 });
    await this.settings({ agents: { ...this.config.agents, [id]: { command: join(homedir(), ".local/bin", a.adapter), args: [] } } });
    return { installed: true };
  }
  async enableTailnet() {
    const status = JSON.parse((await this.run("tailscale", ["status", "--json"], { timeout: 5000 })).stdout);
    const dns = status.Self?.DNSName?.replace(/\.$/, "");
    const owner = status.User?.[String(status.Self?.UserID)]?.LoginName;
    if (status.BackendState !== "Running" || !dns || !owner) throw new SetupError("Sign in with tailscale up on this machine, then try again");
    if (this.config.access.owner && this.config.access.owner !== owner) throw new SetupError("The Tailscale node belongs to a different owner", 403);
    const serving = JSON.parse((await this.run("tailscale", ["serve", "status", "--json"], { timeout: 5000 })).stdout || "{}");
    const occupied = new Set(Object.keys(serving.TCP ?? {}).map(Number));
    const port = [443, 8443].find((p) => !occupied.has(p));
    if (!port) throw new SetupError("Tailscale ports 443 and 8443 are already in use; existing routes were preserved");
    await this.run("tailscale", ["serve", "--bg", `--https=${port}`, "--yes", `http://127.0.0.1:${this.config.listen.port}`], { timeout: 30_000 });
    const publicUrl = `https://${dns}${port === 443 ? "" : `:${port}`}`;
    await this.update({ access: { ...this.config.access, owner }, notifications: { ...this.config.notifications, publicUrl } });
    return { publicUrl };
  }
  async generatePush() {
    if (!this.config.notifications.webPush) {
      const keys = webPush.generateVAPIDKeys();
      await this.settings({ notifications: { ...this.config.notifications, webPush: { ...keys, subject: "mailto:owner@localhost" } } });
    }
    return { publicKey: this.config.notifications.webPush!.publicKey };
  }
  async probeModel(body: unknown) {
    const { LocalModel } = await import("@contextlanes/protocol");
    const model = LocalModel.parse(body);
    const response = await (this.options.fetch ?? fetch)(new URL(model.provider === "ollama" ? "/api/tags" : "/health", model.url), { signal: AbortSignal.timeout(5000), redirect: "error" });
    if (!response.ok) throw new SetupError(`Local model returned HTTP ${response.status}`);
    return { ok: true };
  }
}
