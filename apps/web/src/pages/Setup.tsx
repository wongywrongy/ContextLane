import { useState, type ReactNode, type FormEvent } from "react";
import { Link, Navigate, useNavigate } from "react-router";
import type { DetectedAgent, Lane, Project, SetupSettings, SetupStatus } from "@contextlanes/protocol";
import { postJson, useJson } from "../api";
import { AgentMark, Empty, PageHeader, Section } from "../components/ui";
import { PushSettings } from "../components/PushSettings";

function Action({ children, run, done }: { children: ReactNode; run: () => Promise<unknown>; done?: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return <><button type="button" className="btn" disabled={busy} onClick={async () => {
    setBusy(true); setError("");
    try { await run(); done?.(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  }}>{busy ? "Working…" : children}</button>{error && <p role="alert">{error}</p>}</>;
}

export function SetupPage() {
  const [status, error, reload] = useJson<SetupStatus>("/api/setup/status");
  const [code, setCode] = useState("");
  const [step, setStep] = useState(0);
  const titles = ["Remote access", "Connect agents", "Add projects", "Notifications", "Local models", "Start your first lane"];
  return <><header className="top"><Link className="wm" to="/">Context<span className="ln">Lanes</span></Link><span>Setup</span></header>
    <main className="page setup-page"><PageHeader title={status?.authorized ? titles[step]! : status?.claimed ? "Sign in" : "Claim this machine"} meta="Your agents and projects, on this machine." />
      {error && <Section title="Connection"><Empty>Cannot reach the daemon. Check that the service is running, then reload.</Empty></Section>}
      {!status ? <p role="status">Connecting…</p> : !status.claimed ? <Section title="Owner" meta="The claim code was printed by the installer">
        <div className="setup-body"><p>Enter the claim code from this machine’s terminal. Then use a passkey or your Tailscale identity.</p>
          {status.claimFile && <p className="mono">Read the code: <code>cat {status.claimFile}</code></p>}
          <label>Claim code<input value={code} autoComplete="off" onChange={(e) => setCode(e.target.value)} /></label>
          <div className="setup-actions"><Action done={reload} run={async () => {
            if (!window.PublicKeyCredential?.parseCreationOptionsFromJSON) throw new Error("Use a current browser at http://localhost:4600/setup or an HTTPS tailnet address for passkeys");
            const result = await postJson<{ options: PublicKeyCredentialCreationOptionsJSON; challengeId: string }>("/api/setup/claim/options", { code });
            const credential = await navigator.credentials.create({ publicKey: PublicKeyCredential.parseCreationOptionsFromJSON(result.options) }) as PublicKeyCredential | null;
            if (!credential) throw new Error("Passkey creation was cancelled");
            await postJson("/api/setup/claim/passkey", { code, challengeId: result.challengeId, response: credential.toJSON() });
          }}>Claim with a passkey</Action>
          {status.tailnetLogin && <Action done={reload} run={() => postJson("/api/setup/claim/tailnet", { code })}>Claim as {status.tailnetLogin}</Action>}</div>
          {!status.tailnetLogin && <p>To claim with your tailnet identity, open this page through Tailscale Serve.</p>}
        </div></Section> : !status.authorized ? <Section title="Owner passkey"><div className="setup-body"><Action done={reload} run={async () => {
          if (!window.PublicKeyCredential?.parseRequestOptionsFromJSON) throw new Error("Use a current browser at the HTTPS address where you registered the passkey");
          const result = await postJson<{ options: PublicKeyCredentialRequestOptionsJSON; challengeId: string }>("/api/setup/login/options", {});
          const credential = await navigator.credentials.get({ publicKey: PublicKeyCredential.parseRequestOptionsFromJSON(result.options) }) as PublicKeyCredential | null;
          if (!credential) throw new Error("Sign-in was cancelled");
          await postJson("/api/setup/login", { challengeId: result.challengeId, response: credential.toJSON() });
        }}>Sign in with a passkey</Action><p>Or open ContextLanes through your owner’s Tailscale address.</p></div></Section> : <>
        <Section title="Setup progress"><ol className="setup-progress">{titles.map((title, i) => <li key={title}><button className={step === i ? "current" : ""} aria-current={step === i ? "step" : undefined} onClick={() => setStep(i)}>{i + 1}. {title}</button></li>)}</ol></Section>
        {step === 0 && <AccessSection />}{step === 1 && <AgentsSection />}{step === 2 && <ProjectsSection />}{step === 3 && <NotificationsSection />}{step === 4 && <LocalModelsSection />}{step === 5 && <StartSection />}
        <div className="setup-actions">{step > 0 && <button className="btn ghost" onClick={() => setStep(step - 1)}>Back</button>}{step < 5 && <button className="btn" onClick={() => setStep(step + 1)}>Continue</button>}<Link to="/">Open projects</Link></div>
      </>}
    </main></>;
}

export function AccessSection() {
  const [status, , reload] = useJson<SetupStatus>("/api/setup/status");
  return <Section title="Remote access" meta="optional · Tailscale Serve"><div className="setup-body">
    <p>The daemon listens on 127.0.0.1. Tailscale Serve gives your devices a private HTTPS address and checks your identity.</p>
    {status?.publicUrl ? <p>Open on your phone: <a href={`${status.publicUrl}/setup`}>{status.publicUrl}</a></p> : <p>Sign in to Tailscale on this machine first with <code>tailscale up</code>.</p>}
    <Action run={() => postJson("/api/setup/tailnet", {})} done={reload}>Enable Tailscale Serve</Action>
    <p>Existing routes are kept. A free HTTPS port, 443 or 8443, is used. You can continue locally.</p>
  </div></Section>;
}

export function AgentsSection() {
  const [agents, error, reload] = useJson<DetectedAgent[]>("/api/setup/agents");
  return <Section title="Agents" end={<button className="btn ghost" onClick={reload}>Check again</button>}>
    {error ? <Empty>Could not check agent installations. Try Check again.</Empty> : !agents ? <Empty>Checking installed commands and logins…</Empty> : agents.map((a) => <div className="setup-body agent-setup" key={a.id}>
      <div className="setup-actions"><AgentMark agent={a.id} /><strong>{a.id}</strong><span>{a.adapter ? "Adapter found" : "Adapter missing"} · {a.login === "ready" ? "Signed in" : a.login === "required" ? "Login required" : "Login not confirmed"}</span></div>
      <p className="mono">{a.adapter ?? "No ACP command found"}</p>
      {a.login !== "ready" && <p>On this machine, run <code>{a.loginCommand}</code>, then choose Check again.</p>}
      {!a.adapter && a.installable && <Action done={reload} run={() => postJson("/api/setup/agents/install", { id: a.id })}>Install {a.id} adapter</Action>}
      {!a.cli && a.id === "opencode" && <p>Install OpenCode using its own installer to use this agent.</p>}
    </div>)}
  </Section>;
}

export function ProjectsSection() {
  const [projects, , reload] = useJson<Project[]>("/api/projects");
  const [path, setPath] = useState(""); const [name, setName] = useState("");
  return <Section title="Projects" meta="existing Git repositories on this machine">
    {projects?.map((p) => <div className="sec-r" key={p.id}><b>{p.name}</b><code>{p.path}</code></div>)}
    <div className="setup-body"><label>Repository path<input placeholder="/home/you/code/project" value={path} onChange={(e) => setPath(e.target.value)} /></label>
      <label>Project name (optional)<input value={name} onChange={(e) => setName(e.target.value)} /></label>
      <Action done={() => { reload(); setPath(""); setName(""); }} run={() => postJson("/api/projects", { path, ...(name ? { name } : {}) })}>Add project</Action>
    </div></Section>;
}

export function NotificationsSection() {
  const [settings, , reload] = useJson<SetupSettings>("/api/setup/settings");
  const [message, setMessage] = useState(""); const [busy, setBusy] = useState(false);
  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault(); setBusy(true); setMessage("");
    const f = new FormData(e.currentTarget); const value = (key: string) => String(f.get(key) ?? "").trim();
    const old = settings?.notifications ?? {};
    const notifications = { ...(value("publicUrl") ? { publicUrl: value("publicUrl") } : {}),
      ...(value("topic") ? { ntfy: { topic: value("topic"), url: value("ntfyUrl") || "https://ntfy.sh", ...(value("ntfyToken") ? { token: value("ntfyToken") } : {}) } } : {}),
      ...(value("botToken") ? { telegram: { botToken: value("botToken"), chatId: value("chatId"), ownerId: value("ownerId") } } : {}),
      ...(old.webPush ? { webPush: { ...old.webPush, subject: value("subject") || old.webPush.subject } } : {}),
      ...(value("quietStart") && value("quietEnd") ? { quiet: { start: value("quietStart"), end: value("quietEnd"), timeZone: value("timeZone") || "UTC" } } : {}) };
    try { await postJson("/api/setup/settings", { notifications }); setMessage("Notifications saved."); reload(); }
    catch (e) { setMessage(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  }
  const n = settings?.notifications;
  return <><Section title="Notifications" meta="optional · unanswered requests keep waiting"><div className="setup-body">
    {!settings ? <p>Loading settings…</p> : <form className="setup-form" onSubmit={save} key={JSON.stringify(n)}>
      <label>Public HTTPS app URL<input name="publicUrl" type="url" defaultValue={n?.publicUrl} /></label>
      <fieldset><legend>ntfy</legend><label>Private topic<input name="topic" defaultValue={n?.ntfy?.topic} /></label><label>Server URL<input name="ntfyUrl" type="url" defaultValue={n?.ntfy?.url ?? "https://ntfy.sh"} /></label><label>Publishing token (optional)<input name="ntfyToken" type="password" autoComplete="off" defaultValue={n?.ntfy?.token} /></label><p>Subscribe to this private topic in the phone’s ntfy app.</p></fieldset>
      <fieldset><legend>Telegram</legend><label>Bot token<input name="botToken" type="password" autoComplete="off" defaultValue={n?.telegram?.botToken} /></label><label>Chat ID<input name="chatId" defaultValue={n?.telegram?.chatId} /></label><label>Owner user ID<input name="ownerId" defaultValue={n?.telegram?.ownerId} /></label><p>Start a conversation with the bot first. Only this user in this chat can answer.</p></fieldset>
      <fieldset><legend>Quiet hours</legend><label>Start<input name="quietStart" type="time" defaultValue={n?.quiet?.start} /></label><label>End<input name="quietEnd" type="time" defaultValue={n?.quiet?.end} /></label><label>Time zone<input name="timeZone" defaultValue={n?.quiet?.timeZone ?? "UTC"} /></label></fieldset>
      {n?.webPush && <label>Push contact<input name="subject" defaultValue={n.webPush.subject} /></label>}
      <button className="btn" disabled={busy}>{busy ? "Saving…" : "Save notifications"}</button>
    </form>}
    <p role="status">{message}</p>{n?.webPush ? <p>Web Push keys are configured.</p> : <Action done={reload} run={() => postJson("/api/setup/push", {})}>Generate Web Push keys</Action>}
    <p>After generating keys, set a reachable contact above. On your phone, open the HTTPS app, install it on the home screen, then enable push.</p>
  </div></Section><PushSettings key={n?.webPush?.publicKey ?? "no-key"} /></>;
}

export function LocalModelsSection() {
  const [settings, , reload] = useJson<SetupSettings>("/api/setup/settings");
  const [name, setName] = useState(""); const [provider, setProvider] = useState<"ollama" | "llama.cpp">("ollama"); const [url, setUrl] = useState("http://127.0.0.1:11434");
  const model = { name, provider, url };
  return <Section title="Local models" meta="optional · helpers arrive in phase 3"><div className="setup-body">
    <p>Save an existing Ollama or llama.cpp endpoint. This check contacts its health endpoint; it does not download a model.</p>
    {settings?.localModels?.map((m) => <p key={m.name}>{m.name} · {m.provider} · <code>{m.url}</code></p>)}
    <label>Model name<input value={name} onChange={(e) => setName(e.target.value)} /></label>
    <label>Provider<select value={provider} onChange={(e) => { setProvider(e.target.value as typeof provider); setUrl(e.target.value === "ollama" ? "http://127.0.0.1:11434" : "http://127.0.0.1:8080"); }}><option>ollama</option><option>llama.cpp</option></select></label>
    <label>Loopback URL<input value={url} onChange={(e) => setUrl(e.target.value)} /></label>
    <Action done={reload} run={async () => { await postJson("/api/setup/model/probe", model); await postJson("/api/setup/settings", { localModels: [...(settings?.localModels ?? []).filter((m) => m.name !== name), model] }); }}>Check and save model</Action>
  </div></Section>;
}

export function StartSection() {
  const [projects] = useJson<Project[]>("/api/projects"); const [agents] = useJson<DetectedAgent[]>("/api/setup/agents");
  const [project, setProject] = useState(""); const [agent, setAgent] = useState("claude-code"); const [task, setTask] = useState(""); const [base, setBase] = useState("main"); const navigate = useNavigate();
  return <Section title="Start a lane"><div className="setup-body">
    {!projects?.length ? <p>Add a project before starting a lane.</p> : <>
      <label>Project<select value={project || projects[0]!.id} onChange={(e) => setProject(e.target.value)}>{projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
      <label>Agent<select value={agent} onChange={(e) => setAgent(e.target.value)}>{(agents ?? []).map((a) => <option key={a.id} value={a.id}>{a.id}{a.adapter ? "" : " (adapter missing)"}</option>)}</select></label>
      <label>Base branch<input value={base} onChange={(e) => setBase(e.target.value)} /></label><label>Task<textarea value={task} onChange={(e) => setTask(e.target.value)} rows={4} /></label>
      <Action run={async () => { const lane = await postJson<Lane>("/api/lanes", { project: project || projects[0]!.id, agent, base, task }); if (lane.state === "failed") throw new Error("Lane setup failed. Open Work to inspect its events."); navigate(`/p/${lane.project}/work?lane=${lane.id}`); }}>Start lane</Action>
    </>}
  </div></Section>;
}

export function SettingsPage() {
  return <main className="page setup-page"><PageHeader title="Settings" meta="Saved to ~/.config/contextlanes/config.toml" /><Section title="Setup"><div className="setup-body"><Link to="/setup">Open setup wizard</Link></div></Section><AccessSection /><ProjectsSection /><NotificationsSection /><LaneSettings /></main>;
}
function LaneSettings() {
  const [settings, , reload] = useJson<SetupSettings>("/api/setup/settings"); const [max, setMax] = useState(6);
  return <Section title="Lanes"><div className="setup-body"><p>Current limit: {settings?.lanes?.maxConcurrent ?? "…"} active lanes.</p><label>Maximum concurrent lanes<input type="number" min={1} max={100} value={max} onChange={(e) => setMax(Number(e.target.value))} /></label><Action done={reload} run={() => postJson("/api/setup/settings", { lanes: { maxConcurrent: max, launchHosts: settings?.lanes?.launchHosts ?? true } })}>Save lane limit</Action></div></Section>;
}
export function ModelsPage() {
  return <main className="page setup-page"><PageHeader title="Models" meta="Agent commands, logins and local endpoints" /><AgentsSection /><LocalModelsSection /><Section title="Local helper"><Empty>Measured helper work and routing arrive in phases 3 and 4.</Empty></Section></main>;
}

export function ClaimGuard({ children }: { children: ReactNode }) {
  const [status, error] = useJson<SetupStatus>("/api/setup/status");
  if (status && !status.authorized) return <Navigate to="/setup" replace />;
  if (!status) return <main className="page"><Section title="Connection"><Empty>{error ? "Cannot reach ContextLanes. Check the daemon and reload." : "Connecting…"}</Empty></Section></main>;
  return children;
}
