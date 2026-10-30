import { useEffect, useRef, useState, type ReactNode, type FormEvent } from "react";
import { Link, Navigate, useLocation } from "react-router";
import type { DetectedAgent, Project, SetupSettings, SetupStatus } from "@contextlanes/protocol";
import { postJson, useJson, RequestError, errorMessage } from "../api";
import { Empty, PageHeader, Section } from "../components/ui";
import { PushSettings } from "../components/PushSettings";
import { AgentsSection } from "../setup/Agents";
import { ProjectsSection } from "../setup/Projects";
import { FirstLane } from "../setup/FirstLane";
import { Action } from "../setup/ui";

export function SetupPage() {
  const [status, error, reload] = useJson<SetupStatus>("/api/setup/status");
  const route = useLocation();
  const token = new URLSearchParams(route.hash.slice(1)).get("signin");
  const pending = useRef<{ token: string; request: Promise<unknown> } | null>(null);
  const [signedIn, setSignedIn] = useState(!token);
  const [signInError, setSignInError] = useState("");
  useEffect(() => {
    if (!token) return;
    history.replaceState(history.state, "", location.pathname + location.search);
    setSignedIn(false); setSignInError("");
    if (pending.current?.token !== token) pending.current = { token, request: postJson("/api/setup/sign-in", { token }) };
    let active = true;
    void pending.current.request.then(() => { if (active) { setSignedIn(true); reload(); } }, (e) => { if (active) { setSignInError(errorMessage(e)); setSignedIn(true); } });
    return () => { active = false; };
  }, [token, reload]);
  return <><header className="top"><Link className="wm" to="/">Context<span className="ln">Lanes</span></Link><span>Setup</span></header>
    <main className="page setup-page">
      {!signedIn ? <Section title="Signing you in"><Empty>Opening your private setup session…</Empty></Section> : signInError ? <Section title="Get a new sign-in link"><div className="setup-body"><p role="alert">{signInError}</p><code>contextlanes setup</code></div></Section> : !status ? <Section title="Connection"><Empty>{error ? "The daemon could not be reached. Check the service and reload." : "Connecting…"}</Empty></Section> : !status.authorized ? <SignIn status={status} reload={reload} /> : <Wizard status={status} />}
    </main></>;
}
function SignIn({ status, reload }: { status: SetupStatus; reload: () => void }) {
  return <Section title="Open a sign-in link"><div className="setup-body"><p>In this machine’s SSH session, run the command below and open the link it prints.</p><code>contextlanes setup</code>
    {status.hasPasskey && <Action done={reload} run={async () => {
      if (!window.PublicKeyCredential?.parseRequestOptionsFromJSON) throw new RequestError("Use a current browser at the HTTPS address where you added the passkey.");
      const result = await postJson<{ options: PublicKeyCredentialRequestOptionsJSON; challengeId: string }>("/api/setup/login/options", {});
      const credential = await navigator.credentials.get({ publicKey: PublicKeyCredential.parseRequestOptionsFromJSON(result.options) }) as PublicKeyCredential | null;
      if (!credential) throw new RequestError("Sign-in was cancelled; try again when you are ready.");
      await postJson("/api/setup/login", { challengeId: result.challengeId, response: credential.toJSON() });
    }}>Sign in with a passkey</Action>}
  </div></Section>;
}
function Wizard({ status }: { status: SetupStatus }) {
  const [agents, agentError, reloadAgents] = useJson<DetectedAgent[]>("/api/setup/agents");
  const [projects, , reloadProjects] = useJson<Project[]>("/api/projects");
  const [step, setStep] = useState(0);
  const ready = !agentError && !!agents?.some((a) => a.status === "Ready");
  const hasProject = !!projects?.length;
  const done = [ready, hasProject, status.hasLane];
  const titles = ["Agent", "Project", "First lane"];
  return <>
    <PageHeader title={titles[step]!} meta="Three steps to your first running lane" />
    <Section title="Setup progress"><ol className="setup-progress">{titles.map((title, i) => <li key={title}><button className={step === i ? "current" : ""} disabled={i > 0 && !ready || i > 1 && !hasProject} aria-current={step === i ? "step" : undefined} onClick={() => setStep(i)}>
      <span>{i + 1}. {title}</span><span className="setup-state"><i className={`g ${done[i] ? "merged" : "draft"}`} />{done[i] ? "Done" : "Not done"}</span>
    </button></li>)}</ol></Section>
    {step === 0 && <AgentsSection agents={agents} error={agentError} reload={reloadAgents} />}
    {step === 1 && <ProjectsSection projects={projects} reload={reloadProjects} />}
    {step === 2 && <FirstLane projects={projects ?? []} agents={agents ?? []} />}
    <div className="setup-actions">{step > 0 && <button className="btn ghost" onClick={() => setStep(step - 1)}>Back</button>}{step < 2 && <button className="btn" disabled={!ready || step === 1 && !hasProject} onClick={() => setStep(step + 1)}>Continue</button>}<Link to="/">Open projects</Link></div>
  </>;
}

export function PasskeySection() {
  const [status, , reload] = useJson<SetupStatus>("/api/setup/status");
  if (!status?.authorized || status.hasPasskey || location.protocol !== "https:" || status.publicUrl !== location.origin) return null;
  return <Section title="Sign in next time"><div className="setup-body"><p>This passkey will work at this address.</p><Action done={reload} run={async () => {
    if (!window.PublicKeyCredential?.parseCreationOptionsFromJSON) throw new RequestError("Use a current browser that supports passkeys, then try again.");
    const result = await postJson<{ options: PublicKeyCredentialCreationOptionsJSON; challengeId: string }>("/api/setup/passkey/options", {});
    const credential = await navigator.credentials.create({ publicKey: PublicKeyCredential.parseCreationOptionsFromJSON(result.options) }) as PublicKeyCredential | null;
    if (!credential) throw new RequestError("Passkey creation was cancelled; try again when you are ready.");
    await postJson("/api/setup/passkey", { challengeId: result.challengeId, response: credential.toJSON() });
  }}>Add a passkey for this address</Action></div></Section>;
}

export function NotificationsSection() {
  return <><PushSettings /><OtherNotifications /></>;
}

function OtherNotifications() {
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
    catch (e) { setMessage(errorMessage(e)); } finally { setBusy(false); }
  }
  const n = settings?.notifications;
  return <><Section title="Notification settings" meta="Optional · requests keep waiting"><div className="setup-body">
    {!settings ? <p>Loading settings…</p> : <form className="setup-form" onSubmit={save} key={JSON.stringify(n)}>
      <label>Public HTTPS app URL<input name="publicUrl" type="url" defaultValue={n?.publicUrl} /></label>
      <details className="notification-others"><summary>Other ways</summary><fieldset><legend>ntfy</legend><label>Private topic<input name="topic" defaultValue={n?.ntfy?.topic} /></label><label>Server URL<input name="ntfyUrl" type="url" defaultValue={n?.ntfy?.url ?? "https://ntfy.sh"} /></label><label>Publishing token (optional)<input name="ntfyToken" type="password" autoComplete="off" defaultValue={n?.ntfy?.token} /></label><p>Subscribe to this private topic in the phone’s ntfy app.</p></fieldset>
      <fieldset><legend>Telegram</legend><label>Bot token<input name="botToken" type="password" autoComplete="off" defaultValue={n?.telegram?.botToken} /></label><label>Chat ID<input name="chatId" defaultValue={n?.telegram?.chatId} /></label><label>Owner user ID<input name="ownerId" defaultValue={n?.telegram?.ownerId} /></label><p>Start a conversation with the bot first. Only this user in this chat can answer.</p></fieldset></details>
      <fieldset><legend>Quiet hours</legend><label>Start<input name="quietStart" type="time" defaultValue={n?.quiet?.start} /></label><label>End<input name="quietEnd" type="time" defaultValue={n?.quiet?.end} /></label><label>Time zone<input name="timeZone" defaultValue={n?.quiet?.timeZone ?? "UTC"} /></label></fieldset>
      {n?.webPush && <label>Push contact<input name="subject" defaultValue={n.webPush.subject} /></label>}
      <button className="btn" disabled={busy}>{busy ? "Saving…" : "Save notifications"}</button>
    </form>}
    <p role="status">{message}</p>
  </div></Section></>;
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

export function SettingsPage() {
  const [projects, , reload] = useJson<Project[]>("/api/projects");
  return <main className="page setup-page"><PageHeader title="Settings" meta="Saved to ~/.config/contextlanes/config.toml" /><Section title="Setup"><div className="setup-body"><Link to="/setup">Open setup wizard</Link></div></Section><PasskeySection /><ProjectsSection projects={projects} reload={reload} /><NotificationsSection /><LaneSettings /></main>;
}
function LaneSettings() {
  const [settings, , reload] = useJson<SetupSettings>("/api/setup/settings"); const [max, setMax] = useState(6);
  return <Section title="Lanes"><div className="setup-body"><p>Current limit: {settings?.lanes?.maxConcurrent ?? "…"} active lanes.</p><label>Maximum concurrent lanes<input type="number" min={1} max={100} value={max} onChange={(e) => setMax(Number(e.target.value))} /></label><Action done={reload} run={() => postJson("/api/setup/settings", { lanes: { maxConcurrent: max, launchHosts: settings?.lanes?.launchHosts ?? true } })}>Save lane limit</Action></div></Section>;
}
export function ModelsPage() {
  const [agents, error, reload] = useJson<DetectedAgent[]>("/api/setup/agents");
  return <main className="page setup-page"><PageHeader title="Models" meta="Agent commands, logins and local endpoints" /><AgentsSection agents={agents} error={error} reload={reload} /><LocalModelsSection /><Section title="Local helper"><Empty>Measured helper work and routing arrive in phases 3 and 4.</Empty></Section></main>;
}

export function ClaimGuard({ children }: { children: ReactNode }) {
  const [status, error] = useJson<SetupStatus>("/api/setup/status");
  if (status && !status.authorized) return <Navigate to="/setup" replace />;
  if (!status) return <main className="page"><Section title="Connection"><Empty>{error ? "Cannot reach ContextLanes. Check the daemon and reload." : "Connecting…"}</Empty></Section></main>;
  return children;
}
