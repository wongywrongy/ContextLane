import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { ProjectDiscovery, expandPath, type ScanLimits } from "./projects.js";
import { createServer } from "node:net";
import { stripVTControlCharacters } from "node:util";
import { homedir, userInfo } from "node:os";
import { isAbsolute, join, basename } from "node:path";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { generateRegistrationOptions, verifyRegistrationResponse, generateAuthenticationOptions, verifyAuthenticationResponse } from "@simplewebauthn/server";
import { AddProjectRequest, AgentId, LoginOwnerRequest, ProjectId, RegisterOwnerRequest, SetupSettings, type DetectedAgent, type SetupLink } from "@contextlanes/protocol";
import webPush from "web-push";
import { Config, configPath, saveConfig } from "./config.js";
import type { Store } from "./db/store.js";
import type { Runner } from "./run.js";
import { slugify } from "./lanes/naming.js";

export class SetupError extends Error { constructor(message: string, readonly statusCode = 400) { super(message); } }
const agents = {
  "claude-code": { cli: "claude", adapter: "claude-agent-acp", login: ["auth", "login"], package: "@agentclientprotocol/claude-agent-acp@0.99.1", cliPackage: "@anthropic-ai/claude-code@2.1.314" },
  codex: { cli: "codex", adapter: "codex-acp", login: ["login", "--device-auth"], package: "@agentclientprotocol/codex-acp@2.5.0", cliPackage: "@openai/codex@0.166.0" },
  opencode: { cli: "opencode", adapter: "opencode", login: ["auth", "login"], package: null, cliPackage: "opencode-ai@1.19.5" },
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
  readonly controlFile: string;
  readonly projects: ProjectDiscovery;
  private challenges = new Map<string, Challenge>();
  private writing = Promise.resolve();
  private registering = false;
  private starting?: Promise<SetupLink>;
  private get home(): string { return this.options.home ?? homedir(); }
  constructor(readonly config: Config, private store: Store, private run: Runner,
    private options: { path?: string; find?: typeof findExecutable; fetch?: typeof fetch; changed?: () => Promise<void>; home?: string; user?: string; portFree?: (port: number) => Promise<boolean>; scanLimits?: Partial<ScanLimits> } = {}) {
    this.controlFile = join(config.paths.data, "setup-token");
    this.projects = new ProjectDiscovery(this.home, run, { exclude: [config.paths.lanes], ...(options.scanLimits ? { limits: options.scanLimits } : {}) });
  }
  get claimed(): boolean { return !!(this.config.access.owner || this.config.access.passkey || this.config.access.shellOwner); }
  async initialize(): Promise<void> {
    await mkdir(this.config.paths.data, { recursive: true, mode: 0o700 });
    try { await writeFile(this.controlFile, randomBytes(32).toString("base64url"), { mode: 0o600, flag: "wx" }); }
    catch (err) { if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err; }
    await rm(join(this.config.paths.data, "claim-code"), { force: true });
    for (const p of this.config.projects) {
      const id = ProjectId.parse(slugify(p.name ?? basename(p.path)));
      if (!this.store.getProject(id)) this.store.addProject({ id, name: p.name ?? basename(p.path), path: p.path });
    }
  }
  authorized(login: unknown, cookie: string | undefined, hostname = "127.0.0.1"): boolean {
    if (!this.claimed) return false;
    if (typeof login === "string" && this.config.access.owner) return login === this.config.access.owner;
    const token = cookie?.split(";").map((p) => p.trim()).find((p) => p.startsWith("cl-owner="))?.slice(9);
    return !!(token && this.store.validOwnerSession(token)) || (typeof login !== "string" && this.config.access.allowLocal && ["127.0.0.1", "localhost"].includes(hostname));
  }
  async checkShell(token: string | undefined): Promise<void> {
    const actual = await readFile(this.controlFile, "utf8");
    if (!token || Buffer.byteLength(token) !== Buffer.byteLength(actual) || !timingSafeEqual(Buffer.from(token), Buffer.from(actual))) throw new SetupError("Run contextlanes setup in this machine’s SSH session.", 403);
  }
  shellSetup(sshHost?: string): Promise<SetupLink> {
    if (this.starting) return this.starting;
    this.starting = this.prepareShell(sshHost).finally(() => { this.starting = undefined; });
    return this.starting;
  }
  private async prepareShell(sshHost?: string): Promise<SetupLink> {
    const user = this.options.user ?? userInfo().username;
    if (!this.claimed) await this.update({ access: { ...this.config.access, shellOwner: user } });
    const messages: string[] = [];
    const quote = (text: string) => /^[\w.@:-]+$/.test(text) ? text : `'${text.replace(/'/g, "'\\''")}'`;
    try {
      const linger = (await this.run("loginctl", ["show-user", user, "--property=Linger", "--value"], { timeout: 5000 })).stdout.trim();
      if (linger !== "yes") messages.push(`Keep ContextLanes running after logout: sudo loginctl enable-linger ${quote(user)}`);
    } catch { messages.push(`Check services after logout: sudo loginctl enable-linger ${quote(user)}`); }
    let origin = `http://localhost:${this.config.listen.port}`;
    const tailscale = await (this.options.find ?? findExecutable)("tailscale");
    if (!tailscale) messages.push("Tailscale is not installed: https://tailscale.com/download");
    else {
      try { origin = (await this.enableTailnet()).publicUrl; }
      catch (error) { messages.push(error instanceof SetupError ? error.message : "Tailscale could not be checked; use the SSH tunnel below."); }
    }
    const local = origin.startsWith("http:");
    const tunnel = local ? `ssh -N -L ${this.config.listen.port}:127.0.0.1:${this.config.listen.port} ${quote(`${user}@${sshHost ?? this.config.host.name}`)}` : undefined;
    const { token, expiresAt } = this.store.setupLink(origin);
    return { url: `${origin}/setup#signin=${token}`, expiresAt, messages, ...(tunnel ? { tunnel } : {}) };
  }
  signIn(token: string, origin: string): string {
    if (!this.store.consumeSetupLink(token, origin)) throw new SetupError("This sign-in link was used or expired; run contextlanes setup for a new link.", 401);
    return this.store.ownerSession();
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
    if (!c || c.expires < Date.now() || c.origin !== origin || c.kind !== kind) throw new SetupError("This sign-in attempt expired or belongs to another origin; start it again at this address.");
    return c;
  }
  async registration(origin: string) {
    if (!this.claimed || !this.config.notifications.publicUrl || origin !== new URL(this.config.notifications.publicUrl).origin || new URL(origin).protocol !== "https:") throw new SetupError("Open your HTTPS Tailscale address and sign in before adding a passkey.", 403);
    if (this.config.access.passkey) throw new SetupError("A passkey is already saved for this machine.", 409);
    const rpId = new URL(origin).hostname;
    const options = await generateRegistrationOptions({ rpName: "ContextLanes", rpID: rpId, userName: "Owner", attestationType: "none", authenticatorSelection: { residentKey: "preferred", userVerification: "required" }, supportedAlgorithmIDs: [-7] });
    return { options, challengeId: this.remember(options.challenge, origin, rpId, "register") };
  }
  async register(body: unknown, origin: string): Promise<string> {
    if (this.registering || this.config.access.passkey) throw new SetupError("A passkey is already saved or being added; try signing in.", 409);
    this.registering = true;
    try {
      const b = RegisterOwnerRequest.parse(body);
      const c = this.take(b.challengeId, origin, "register");
      const result = await verifyRegistrationResponse({ response: b.response, expectedChallenge: c.value, expectedOrigin: origin, expectedRPID: c.rpId, requireUserVerification: true, supportedAlgorithmIDs: [-7] }).catch(() => { throw new SetupError("Passkey verification failed; try adding it again."); });
      if (!result.verified) throw new SetupError("Passkey verification failed; try adding it again.");
      const key = result.registrationInfo.credential;
      await this.update({ access: { ...this.config.access, passkey: { id: key.id, publicKey: Buffer.from(key.publicKey).toString("base64url"), counter: key.counter, rpId: c.rpId, transports: key.transports } } });
      return this.store.ownerSession();
    } finally { this.registering = false; }
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
    if (!key || b.response.id !== key.id) throw new SetupError("This passkey is not saved here; use your saved passkey or run contextlanes setup.", 403);
    const result = await verifyAuthenticationResponse({ response: { ...b.response, response: { ...b.response.response, userHandle: b.response.response.userHandle ?? undefined } }, expectedChallenge: c.value, expectedOrigin: origin, expectedRPID: c.rpId,
      credential: { id: key.id, publicKey: Buffer.from(key.publicKey, "base64url"), counter: key.counter, transports: key.transports }, requireUserVerification: true }).catch(() => { throw new SetupError("Passkey verification failed; try signing in again.", 403); });
    if (!result.verified) throw new SetupError("Passkey verification failed; try signing in again.", 403);
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
    const path = expandPath(p.path, this.home);
    const root = (await this.run("git", ["rev-parse", "--show-toplevel"], { cwd: path, timeout: 5000 }).catch(() => { throw new SetupError("This folder is not a Git repository; choose another folder."); })).stdout.trim();
    if (!isAbsolute(root)) throw new SetupError("This folder could not be registered; choose its Git repository root.");
    const registered = this.store.listProjects().find((project) => project.path === root);
    if (registered) return registered;
    const project = { path: root, name: p.name ?? basename(root) };
    const base = slugify(project.name);
    if (!p.name && (!base || this.store.getProject(base))) project.name = `${base || "project"}-${createHash("sha256").update(root).digest("hex").slice(0, 10)}`;
    const id = ProjectId.parse(slugify(project.name));
    const existing = this.store.getProject(id);
    if (existing && existing.path !== root) throw new SetupError("That project name is already in use; choose a different name.", 409);
    await this.update({ projects: [...this.config.projects.filter((p) => p.path !== root), project] });
    return existing ?? this.store.addProject({ ...project, id });
  }
  async detectAgents(): Promise<DetectedAgent[]> {
    return Promise.all(Object.entries(agents).map(async ([key, a]) => {
      const id = AgentId.parse(key);
      const find = this.options.find ?? findExecutable;
      const cli = await find(a.cli);
      const adapter = await find(this.config.agents[id]?.command ?? a.adapter);
      let signedIn = false;
      if (cli && adapter) {
        try {
          const args = id === "claude-code" ? ["auth", "status", "--json"] : id === "codex" ? ["login", "status"] : ["auth", "list"];
          const { stdout } = await this.run(cli, args, { timeout: 5000 });
          signedIn = id === "claude-code" ? JSON.parse(stdout).loggedIn === true : id === "codex" ? true : /\b[1-9]\d* credentials?\b/.test(stripVTControlCharacters(stdout));
        } catch { /* Status failures need an explicit sign-in, never a presumed ready state. */ }
      }
      return { id, installed: !!cli, status: !cli || !adapter ? "Install" : signedIn ? "Ready" : "Sign in" };
    }));
  }
  async installAgent(body: unknown) {
    const id = AgentId.parse((body as { id?: unknown })?.id);
    const a = agents[id];
    const cli = await (this.options.find ?? findExecutable)(a.cli);
    const packages = [...(!cli ? [a.cliPackage] : []), ...(a.package ? [a.package] : [])];
    if (!packages.length) return { installed: true };
    await this.run("npm", ["install", "--global", "--prefix", join(this.home, ".local"), ...packages], { timeout: 180_000 }).catch(() => { throw new SetupError("The adapter could not be installed; check npm connectivity and choose Install again."); });
    await this.settings({ agents: { ...this.config.agents, [id]: { command: join(this.home, ".local/bin", a.adapter), args: id === "opencode" ? ["acp"] : [] } } });
    return { installed: true };
  }
  async loginCommand(id: string): Promise<{ command: string; args: string[]; cwd: string }> {
    const agent = agents[AgentId.parse(id)];
    const command = await (this.options.find ?? findExecutable)(agent.cli);
    if (!command) throw new SetupError("Install this agent’s CLI, then choose Sign in again.");
    return { command, args: agent.login, cwd: this.home };
  }
  async enableTailnet() {
    let status;
    try { status = JSON.parse((await this.run("tailscale", ["status", "--json"], { timeout: 5000 })).stdout); }
    catch { throw new SetupError("Sign in with tailscale up on this machine, then run contextlanes setup again."); }
    const dns = status.Self?.DNSName?.replace(/\.$/, "");
    const owner = status.User?.[String(status.Self?.UserID)]?.LoginName;
    if (status.BackendState !== "Running" || !dns || !owner) throw new SetupError("Sign in with tailscale up on this machine, then run contextlanes setup again.");
    if (this.config.access.owner && this.config.access.owner !== owner) throw new SetupError("Sign in to Tailscale as this machine’s owner, then run contextlanes setup again.", 403);
    let serving;
    try { serving = JSON.parse((await this.run("tailscale", ["serve", "status", "--json"], { timeout: 5000 })).stdout || "{}"); }
    catch { throw new SetupError("Tailscale Serve could not be checked; grant this user Serve access and run contextlanes setup again."); }
    const target = `http://127.0.0.1:${this.config.listen.port}`;
    let publicUrl: string | undefined;
    for (const [host, value] of Object.entries(serving.Web ?? {}) as [string, { Handlers?: Record<string, { Proxy?: string }> }][]) {
      const port = Number(host.split(":").at(-1));
      if (!serving.AllowFunnel?.[host] && host.startsWith(`${dns}:`) && serving.TCP?.[port]?.HTTPS && value.Handlers?.["/"]?.Proxy === target) publicUrl = `https://${dns}${port === 443 ? "" : `:${port}`}`;
    }
    if (!publicUrl) {
      for (const port of [443, 8443, 4601, 4602, 4603]) {
        if (serving.TCP?.[port] || serving.AllowFunnel?.[`${dns}:${port}`] || !(await (this.options.portFree ?? portFree)(port))) continue;
        try { await this.run("tailscale", ["serve", "--bg", `--https=${port}`, "--yes", target], { timeout: 30_000 }); }
        catch { throw new SetupError("Enable HTTPS and grant this user Tailscale Serve access, then run contextlanes setup again."); }
        publicUrl = `https://${dns}${port === 443 ? "" : `:${port}`}`;
        break;
      }
    }
    if (!publicUrl) throw new SetupError("Tailscale HTTPS ports are in use; free a port or use the SSH tunnel below.");
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
    if (!response.ok) throw new SetupError("The local model is not ready; start its server and check again.");
    return { ok: true };
  }
}

async function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once("error", () => resolve(false));
    probe.listen(port, "127.0.0.1", () => probe.close(() => resolve(true)));
  });
}
