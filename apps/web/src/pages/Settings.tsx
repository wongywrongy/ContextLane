import { useState, type FormEvent, type ReactNode } from "react";
import type { DetectedAgent, Project, SetupSettings, SetupStatus } from "@contextlanes/protocol";
import { errorMessage, postJson, RequestError, useJson, saveSession } from "../api";
import { AddRepoDialog } from "../components/AddRepo";
import { PushSettings } from "../components/PushSettings";
import { AgentMark, Empty, Glyph, PageHeader, Section } from "../components/ui";
import { AgentRows } from "../setup/Agents";
import { Action } from "../setup/ui";

/** Offered only at the HTTPS address the passkey will belong to. */
export function PasskeyButton() {
  const [status, , reload] = useJson<SetupStatus>("/api/setup/status");
  if (!status?.authorized || status.hasPasskey || location.protocol !== "https:" || status.publicUrl !== location.origin) return null;
  return <div><Action small ghost done={reload} run={async () => {
    if (!window.PublicKeyCredential?.parseCreationOptionsFromJSON) throw new RequestError("Use a current browser that supports passkeys, then try again.");
    const result = await postJson<{ options: PublicKeyCredentialCreationOptionsJSON; challengeId: string }>("/api/setup/passkey/options", {});
    const credential = await navigator.credentials.create({ publicKey: PublicKeyCredential.parseCreationOptionsFromJSON(result.options) }) as PublicKeyCredential | null;
    if (!credential) throw new RequestError("Passkey creation was cancelled; try again when you are ready.");
    saveSession((await postJson<{ token: string }>("/api/setup/passkey", { challengeId: result.challengeId, response: credential.toJSON() })).token);
  }}>Add a passkey for this address</Action></div>;
}

function Form({ title, meta, children, save }: { title: string; meta?: string; children: ReactNode; save: (f: FormData) => Promise<void> }) {
  const [message, setMessage] = useState(""); const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault(); setBusy(true); setMessage("");
    try { await save(new FormData(e.currentTarget)); setMessage("Saved."); } catch (err) { setMessage(errorMessage(err)); } finally { setBusy(false); }
  };
  return <details><summary>{title}{meta ? <span className="m">{meta}</span> : null}</summary>
    <form className="form" onSubmit={(e) => void submit(e)}>{children}<div style={{ display: "flex", gap: 10, alignItems: "center" }}><button className="btn sm" disabled={busy}>{busy ? "Saving…" : "Save"}</button>{message ? <span role="status" className="muted" style={{ fontSize: 13 }}>{message}</span> : null}</div></form>
  </details>;
}

export function SettingsPage() {
  const [status] = useJson<SetupStatus>("/api/setup/status");
  const [settings, , reload] = useJson<SetupSettings>("/api/setup/settings");
  const [projects, , reloadProjects] = useJson<Project[]>("/api/projects");
  const [adding, setAdding] = useState(false);
  const n = settings?.notifications ?? {};
  const saveNotifications = async (patch: Partial<NonNullable<SetupSettings["notifications"]>>) => { await postJson("/api/setup/settings", { notifications: { ...n, ...patch } }); reload(); };
  const v = (f: FormData, key: string) => String(f.get(key) ?? "").trim();
  return <main className="pg narrow">
    <PageHeader title="Settings" meta="saved to ~/.config/contextlanes/config.toml" />
    <div className="setw">
      <nav className="setnav" aria-label="Settings"><a href="#access">Access</a><a href="#projects">Projects</a><a href="#notifications">Notifications</a><a href="#lanes">Lanes</a></nav>
      <div className="col">
        <Section id="access" title="Access">
          <div className="sec-r"><span className="muted" style={{ width: 120 }}>Address</span>{status?.publicUrl ? <a className="mono" href={status.publicUrl} style={{ fontSize: 13 }}>{status.publicUrl}</a> : <span>Only on this machine. Run <code>contextlanes setup</code> to turn on Tailscale.</span>}</div>
          <div className="sec-r"><span className="muted" style={{ width: 120 }}>Owner</span><span>{status?.tailnetLogin ?? "Signed in with a setup link"}</span></div>
          <div className="sec-r"><span className="muted" style={{ width: 120 }}>Passkey</span>{status?.hasPasskey ? <Glyph g="done">Added</Glyph> : <><span className="muted">Not added.</span><PasskeyButton /></>}</div>
        </Section>
        <Section id="projects" title="Projects" meta={projects ? `${projects.length}` : undefined} end={<button className="btn ghost sm" onClick={() => setAdding(true)}>Add repo</button>}>
          {projects?.map((p) => <div className="sec-r" key={p.id}><b>{p.name}</b><span className="mono muted" style={{ fontSize: 12, overflowWrap: "anywhere" }}>{p.path}</span></div>)}
          {projects && !projects.length ? <Empty>No projects yet.</Empty> : null}
        </Section>
        <div id="notifications" className="col">
          <PushSettings />
          <div className="opts">
            <Form title="Phone push contact" meta={n.webPush ? "keys ready" : "not set up"} save={async (f) => { if (!n.webPush) throw new RequestError("Enable push on a device first; that creates the keys."); await saveNotifications({ webPush: { ...n.webPush, subject: v(f, "subject") } }); }}>
              <label className="field">Contact for the push service <span className="hint">a mailto: address push services can reach</span><input className="in" name="subject" defaultValue={n.webPush?.subject} placeholder="mailto:you@example.com" /></label>
            </Form>
            <Form title="ntfy" meta={n.ntfy ? n.ntfy.topic : "not set up"} save={(f) => saveNotifications({ ntfy: { topic: v(f, "topic"), url: v(f, "url") || "https://ntfy.sh", ...(v(f, "token") ? { token: v(f, "token") } : {}) } })}>
              <div className="two"><label className="field">Private topic<input className="in" name="topic" required defaultValue={n.ntfy?.topic} /></label><label className="field">Server<input className="in" name="url" type="url" defaultValue={n.ntfy?.url ?? "https://ntfy.sh"} /></label></div>
              <label className="field">Publishing token <span className="hint">optional</span><input className="in" name="token" type="password" autoComplete="off" defaultValue={n.ntfy?.token} /></label>
              <p className="muted" style={{ margin: 0, fontSize: 13 }}>Subscribe to the same topic in the ntfy app on your phone.</p>
            </Form>
            <Form title="Telegram" meta={n.telegram ? "connected" : "not set up"} save={(f) => saveNotifications({ telegram: { botToken: v(f, "botToken"), chatId: v(f, "chatId"), ownerId: v(f, "ownerId") } })}>
              <label className="field">Bot token<input className="in" name="botToken" type="password" required autoComplete="off" defaultValue={n.telegram?.botToken} /></label>
              <div className="two"><label className="field">Chat ID<input className="in" name="chatId" required defaultValue={n.telegram?.chatId} /></label><label className="field">Your user ID<input className="in" name="ownerId" required defaultValue={n.telegram?.ownerId} /></label></div>
              <p className="muted" style={{ margin: 0, fontSize: 13 }}>Message the bot once first. Only you, in this chat, can answer.</p>
            </Form>
            <Form title="Quiet hours" meta={n.quiet ? `${n.quiet.start}–${n.quiet.end}` : "off"} save={(f) => saveNotifications({ quiet: { start: v(f, "start"), end: v(f, "end"), timeZone: v(f, "timeZone") || "UTC" } })}>
              <div className="two"><label className="field">From<input className="in" name="start" type="time" required defaultValue={n.quiet?.start} /></label><label className="field">Until<input className="in" name="end" type="time" required defaultValue={n.quiet?.end} /></label></div>
              <label className="field">Time zone<input className="in" name="timeZone" defaultValue={n.quiet?.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone} /></label>
            </Form>
            <Form title="Address in notification links" meta={n.publicUrl ?? status?.publicUrl ?? "not set"} save={(f) => saveNotifications({ publicUrl: v(f, "publicUrl") })}>
              <label className="field">HTTPS address <span className="hint">filled in by contextlanes setup when Tailscale is on</span><input className="in mono" name="publicUrl" type="url" required defaultValue={n.publicUrl ?? status?.publicUrl ?? ""} /></label>
            </Form>
          </div>
        </div>
        <Section id="lanes" title="Lanes"><LaneLimit settings={settings} reload={reload} /></Section>
      </div>
    </div>
    {adding ? <AddRepoDialog onClose={() => setAdding(false)} onAdded={reloadProjects} /> : null}
  </main>;
}

function LaneLimit({ settings, reload }: { settings: SetupSettings | null; reload: () => void }) {
  const [max, setMax] = useState<number | null>(null);
  const current = settings?.lanes?.maxConcurrent;
  return <div className="sec-r" style={{ flexWrap: "wrap" }}><label className="field" style={{ fontWeight: 500 }}>At most this many lanes run at once<input className="in" style={{ width: 120 }} type="number" min={1} max={100} value={max ?? current ?? 6} onChange={(e) => setMax(Number(e.target.value))} /></label>
    <div style={{ marginLeft: "auto" }}><Action small disabled={max === null || max === current} done={() => { setMax(null); reload(); }} run={() => postJson("/api/setup/settings", { lanes: { maxConcurrent: max, launchHosts: settings?.lanes?.launchHosts ?? true } })}>Save</Action></div></div>;
}

export function ModelsPage() {
  const [agents, error, reload] = useJson<DetectedAgent[]>("/api/setup/agents");
  const [settings, , reloadSettings] = useJson<SetupSettings>("/api/setup/settings");
  const models = settings?.localModels ?? [];
  const v = (f: FormData, key: string) => String(f.get(key) ?? "").trim();
  return <main className="pg narrow">
    <PageHeader title="Models" meta="who does the work" />
    <Section title="Agents" meta="each keeps its own login" end={<button className="btn ghost sm" onClick={reload}>Check again</button>}>
      <div className="sec-b"><AgentRows agents={agents} error={error} reload={reload} /></div>
    </Section>
    <Section title="Local models" meta="Ollama or llama.cpp on this machine">
      {models.map((m) => <div className="sec-r" key={m.name}><AgentMark agent={m.provider} /><b>{m.name}</b><span className="mono muted" style={{ fontSize: 12 }}>{m.url}</span></div>)}
      {!models.length ? <div className="sec-r muted" style={{ fontSize: 14 }}>None saved. Local models become helpers to Claude and Codex in phase 3.</div> : null}
      <div className="sec-b opts">
        <Form title="Add a local model" save={async (f) => {
          const model = { name: v(f, "name"), provider: v(f, "provider") as "ollama" | "llama.cpp", url: v(f, "url") };
          await postJson("/api/setup/model/probe", model);
          await postJson("/api/setup/settings", { localModels: [...models.filter((m) => m.name !== model.name), model] });
          reloadSettings();
        }}>
          <div className="two"><label className="field">Model<input className="in" name="name" required placeholder="qwen3-coder" /></label>
            <label className="field">Runs on<select className="in" name="provider" defaultValue="ollama"><option value="ollama">Ollama</option><option value="llama.cpp">llama.cpp</option></select></label></div>
          <label className="field">Address <span className="hint">on 127.0.0.1; checked before saving</span><input className="in mono" name="url" required defaultValue="http://127.0.0.1:11434" /></label>
        </Form>
      </div>
    </Section>
  </main>;
}
