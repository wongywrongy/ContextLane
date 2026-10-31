import { useState, type FormEvent, type ReactNode } from "react";
import { LOCAL_ROLES, LocalRole as LocalRoleSchema, type LocalRole } from "@contextlanes/protocol";
import type { ScheduleView, RoutingRule, RegistryAgent, HelperStatus, LocalModel, LocalModelStatus, DetectedAgent, Project, SetupSettings, SetupStatus, UsageSummary, MachineInfo, UpdateCheck, DataExport } from "@contextlanes/protocol";
import { errorMessage, getJson, postJson, RequestError, useJson, saveSession } from "../api";
import { AddRepoDialog } from "../components/AddRepo";
import { PushSettings } from "../components/PushSettings";
import { AGENT_NAMES, AgentMark, Dialog, Empty, Glyph, PageHeader, Section, Tile, type IconName } from "../components/ui";
import { AgentRows } from "../setup/Agents";
import { Action } from "../setup/ui";

/** Offered only at the HTTPS address the passkey will belong to. */
/** One project in Settings: rename, pin, move, remove. Nothing here touches the repository on disk. */
const LOCAL_ROLE_KEYS = LocalRoleSchema.options;

function ProjectRow({ project, first, last, move, changed }: { project: Project; first: boolean; last: boolean; move: (by: -1 | 1) => void; changed: () => void }) {
  const [editing, setEditing] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState("");
  const patch = (body: object) => postJson(`/api/projects/${project.id}`, body, "PATCH").then(() => { setError(""); changed(); }, (e) => setError(errorMessage(e)));
  return <>
    <div className="sec-r wrap">
      <span className="grow">{editing
        ? <form style={{ display: "flex", gap: 8 }} onSubmit={(e) => { e.preventDefault(); const name = String(new FormData(e.currentTarget).get("name") ?? "").trim(); void patch({ name }).then(() => setEditing(false)); }}>
            <input className="in" name="name" defaultValue={project.name} maxLength={80} required autoFocus aria-label="Project name" style={{ minHeight: 34 }} /><button className="btn sm">Save</button><button type="button" className="btn ghost sm" onClick={() => setEditing(false)}>Cancel</button></form>
        : <><b>{project.name}</b>{project.pinned ? <span className="mono muted" style={{ fontSize: 11.5, marginLeft: 8 }}>pinned</span> : null}<span className="mono muted" style={{ display: "block", fontSize: 12, overflowWrap: "anywhere" }}>{project.id} · {project.path}</span></>}</span>
      {editing ? null : <span style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        <button className="btn ghost sm" onClick={() => setEditing(true)}>Rename</button>
        <button className="btn ghost sm" aria-pressed={project.pinned} onClick={() => void patch({ pinned: !project.pinned })}>{project.pinned ? "Unpin" : "Pin"}</button>
        <button className="btn ghost sm" disabled={first} aria-label={`Move ${project.name} up`} onClick={() => move(-1)}>↑</button>
        <button className="btn ghost sm" disabled={last} aria-label={`Move ${project.name} down`} onClick={() => move(1)}>↓</button>
        <button className="btn ghost sm" onClick={() => setRemoving(true)}>Remove</button>
      </span>}
    </div>
    {error ? <div className="sec-f" role="alert" style={{ fontSize: 13 }}>{error}</div> : null}
    {removing ? <Dialog title={`Remove ${project.name}?`} onClose={() => setRemoving(false)} footer={<><Action run={() => postJson(`/api/projects/${project.id}`, {}, "DELETE")} done={() => { setRemoving(false); changed(); }}>Remove</Action><button className="btn ghost" onClick={() => setRemoving(false)}>Cancel</button></>}>
      <p style={{ margin: 0 }}>It leaves ContextLanes. The repository at <code>{project.path}</code>, its branches and its lane history stay. Add the folder again to bring it back.</p>
    </Dialog> : null}
  </>;
}

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
  const [orderError, setOrderError] = useState("");
  const [adding, setAdding] = useState(false);
  const [machine, machineError, reloadMachine] = useJson<MachineInfo>("/api/machine");
  const [updates, setUpdates] = useState<UpdateCheck | null>(null);
  const [at, setAt] = useState(() => location.hash.slice(1) || "machine");
  const n = settings?.notifications ?? {};
  const saveNotifications = async (patch: Partial<NonNullable<SetupSettings["notifications"]>>) => { await postJson("/api/setup/settings", { notifications: { ...n, ...patch } }); reload(); };
  const v = (f: FormData, key: string) => String(f.get(key) ?? "").trim();
  return <main className="pg narrow">
    <PageHeader title="Settings" meta="saved to ~/.config/contextlanes/config.toml" />
    <div className="setw">
      <nav className="setnav" aria-label="Settings">{([["machine", "This machine"], ["access", "Access"], ["projects", "Projects"], ["notifications", "Notifications"], ["lanes", "Lanes"], ["schedules", "Scheduled lanes"], ["data", "Data"]] as const).map(([id, label]) => <a key={id} href={`#${id}`} aria-current={at === id ? "true" : undefined} onClick={() => setAt(id)}>{label}</a>)}</nav>
      <div className="col">
        <Section id="machine" title="This machine">
          {machineError ? <div className="sec-r" role="alert">Machine details could not be checked. <button className="lnk" onClick={reloadMachine}>Try again</button></div> : !machine ? <div className="sec-r muted">Checking this machine…</div> : <>
            <div className="sec-r"><span className="kl">Host</span><b>{machine.host}</b><span className="mono muted" style={{ fontSize: 12 }}>{machine.os}{machine.linger === null ? "" : machine.linger ? " · keeps running after you log out" : " · stops when you log out"}</span></div>
            <div className="sec-r"><span className="kl">Version</span><code>{machine.version}</code><div style={{ marginLeft: "auto" }}><Action small ghost run={async () => setUpdates(await postJson<UpdateCheck>("/api/machine/updates", {}))}>Check for updates</Action></div></div>
            <div className="sec-r"><span className="kl">Runs as</span><span className="mono" style={{ fontSize: 12 }}>{machine.user}{machine.service === null ? "" : machine.service ? " · systemd user service" : " · started by hand"} · {machine.address}</span></div>
          </>}
          {updates ? <div className="sec-b"><pre className="out" style={{ marginTop: 0 }}>{updates.lines.join("\n")}</pre><p>Install from your SSH session: <code>{updates.command}</code></p></div> : null}
        </Section>
        <Section id="access" title="Access">
          <div className="sec-r"><span className="kl">Address</span>{status?.publicUrl ? <a className="mono" href={status.publicUrl} style={{ fontSize: 13 }}>{status.publicUrl}</a> : <span>Only on this machine. Run <code>contextlanes setup</code> to turn on Tailscale.</span>}</div>
          <div className="sec-r"><span className="kl">Owner</span><span>{status?.tailnetLogin ?? "Signed in with a setup link"}</span></div>
          <div className="sec-r"><span className="kl">Passkey</span>{status?.hasPasskey ? <Glyph g="done">Added</Glyph> : <><span className="muted">Not added.</span><PasskeyButton /></>}</div>
          <div className="sec-r"><span className="kl">Public internet</span><span>Off · tailnet or SSH tunnel only</span></div>
        </Section>
        <Section id="projects" title="Projects" meta={projects ? `${projects.length}` : undefined} end={<button className="btn ghost sm" onClick={() => setAdding(true)}>Add project</button>}>
          {projects?.map((p, i) => <ProjectRow key={p.id} project={p} first={i === 0} last={i === projects.length - 1} move={(by) => {
            const ids = projects.map((x) => x.id); const j = i + by; [ids[i], ids[j]] = [ids[j]!, ids[i]!];
            void postJson("/api/projects/order", { ids }, "PUT").then(reloadProjects, (e) => { setOrderError(errorMessage(e)); reloadProjects(); });
          }} changed={reloadProjects} />)}
          {projects && !projects.length ? <Empty>No projects yet.</Empty> : null}
          {orderError ? <div className="sec-f" role="alert" style={{ fontSize: 13 }}>{orderError}</div> : null}
        </Section>
        <Section id="notifications" title="Notifications" meta="you decide when the agent continues">
          <PushSettings />
          <div className="opts in-sec">
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
        </Section>
        <Section id="lanes" title="Lanes"><LaneLimit settings={settings} reload={reload} /></Section>
        <ScheduledLanes />
        <Section id="data" title="Data">
          <div className="sec-r"><span className="kl">Backups</span>{machine ? <span className="mono" style={{ fontSize: 12, overflowWrap: "anywhere", minWidth: 0 }}>{machine.backups.scheduled === null ? "" : machine.backups.scheduled ? "Nightly · " : "Not scheduled · "}{machine.backups.directory}{machine.backups.lastRun ? ` · last ${new Date(machine.backups.lastRun).toLocaleString()}` : ""}</span> : <span className="muted">Backup status not available</span>}{machine?.backups.result ? <Glyph g={machine.backups.result === "success" ? "done" : "fail"}>{machine.backups.result === "success" ? "OK" : machine.backups.result}</Glyph> : null}</div>
          <div className="sec-r"><span className="kl">Export</span><span>Everything as JSON · known secrets masked</span><div style={{ marginLeft: "auto" }}><Action small ghost run={async () => {
            const data = await getJson<DataExport>("/api/data/export");
            const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
            const link = document.createElement("a"); link.href = url; link.download = "contextlanes-export.json"; link.click(); URL.revokeObjectURL(url);
          }}>Export</Action></div></div>
        </Section>
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

/** One local endpoint, as on models.webp: server and host, model, this machine's GPU memory, state. */
function LocalRow({ m, save, remove }: { m: (LocalModelStatus | (Omit<LocalModel, "label" | "roles"> & { label: string | null; roles: LocalRole[]; state: null })); save: (change: { roles?: LocalRole[]; label?: string }) => Promise<void>; remove: () => Promise<void> }) {
  const [editing, setEditing] = useState(false);
  const host = new URL(m.url).host;
  const status = m.state ? m as LocalModelStatus : null;
  const gpu = status?.gpu;
  return <><div className="sec-r lmrow">
    <AgentMark agent={m.provider} />
    <span style={{ minWidth: 0 }}><b>{m.label || (m.provider === "ollama" ? "Ollama" : "llama.cpp")}</b><span className="mono muted" style={{ display: "block", fontSize: 12 }}>{host} · {m.roles.length ? m.roles.join(", ") : "every job"}</span>
      <button className="lnk" style={{ fontSize: 12.5 }} onClick={() => setEditing((e) => !e)}>{editing ? "Close" : "Edit"}</button></span>
    <span style={{ minWidth: 0 }}><span className="mono" style={{ fontSize: 13 }}>{m.name}</span><span className="mono muted" style={{ display: "block", fontSize: 12 }}>{status ? status.running ? `working${status.waiting ? ` · ${status.waiting} waiting` : ""}` : status.waiting ? `${status.waiting} waiting` : status.loaded.length ? `loaded: ${status.loaded.join(", ")}` : "nothing loaded" : ""}</span></span>
    <span style={{ minWidth: 0 }}>{gpu ? <><span className="mono muted" style={{ display: "flex", fontSize: 12 }}>{gpu.name} · {Math.round(gpu.totalMb / 1024)} GB<span style={{ marginLeft: "auto", color: "var(--ink)" }}>{(gpu.usedMb / 1024).toFixed(1)} GB</span></span>
      <span className="meter" aria-label={`${Math.round(gpu.usedMb / gpu.totalMb * 100)}% of GPU memory used`}><i style={{ width: `${Math.min(100, gpu.usedMb / Math.max(1, gpu.totalMb) * 100)}%` }} /></span></> : <span className="muted" style={{ fontSize: 12.5 }}>{status && !status.local ? "on another machine" : status ? "no GPU reading" : ""}</span>}</span>
    <span style={{ textAlign: "right" }}>{status ? <Glyph g={status.state === "serving" ? "done" : status.state === "idle" ? "idle" : "fail"}>{status.state === "serving" ? "Serving" : status.state === "idle" ? "Idle" : "Down"}</Glyph> : null}{status?.detail ? <span className="muted" style={{ display: "block", fontSize: 12 }}>{status.detail}</span> : null}</span>
  </div>{editing ? <form className="sec-b" onSubmit={(e) => { e.preventDefault(); const f = new FormData(e.currentTarget); void save({ label: String(f.get("label") ?? "").trim() || undefined, roles: LOCAL_ROLE_KEYS.filter((r) => f.get(`role-${r}`)) }).then(() => setEditing(false)); }}>
    <label className="field">Name<input className="in" name="label" maxLength={40} defaultValue={m.label ?? ""} /></label>
    <div style={{ display: "flex", gap: 14, flexWrap: "wrap", margin: "10px 0" }}>{LOCAL_ROLE_KEYS.map((r) => <label key={r} style={{ display: "inline-flex", gap: 6, alignItems: "center", fontSize: 14 }}><input type="checkbox" name={`role-${r}`} defaultChecked={m.roles.includes(r)} />{LOCAL_ROLES[r]}</label>)}</div>
    <div style={{ display: "flex", gap: 8 }}><button className="btn sm">Save</button><Action small ghost run={remove}>Remove endpoint</Action></div>
  </form> : null}</>;
}

export function ModelsPage() {
  const [agents, error, reload] = useJson<DetectedAgent[]>("/api/setup/agents");
  const [settings, , reloadSettings] = useJson<SetupSettings>("/api/setup/settings");
  const [usage, usageError, reloadUsage] = useJson<UsageSummary>("/api/usage");
  const models = settings?.localModels ?? [];
  const [local, , reloadLocal] = useJson<LocalModelStatus[]>(models.length ? "/api/models/local" : null);
  const [registry, setRegistry] = useState(false);
  const v = (f: FormData, key: string) => String(f.get(key) ?? "").trim();
  return <main className="pg">
    <PageHeader title="Models" meta="who does the work" />
    <Section title="Agents" meta="each keeps its own login · talks over ACP" end={<><button className="btn ghost sm" onClick={() => setRegistry(true)}>Add from ACP registry</button><button className="btn ghost sm" onClick={() => { reload(); reloadUsage(); }}>Check again</button></>}>
      <div className="sec-b">{usageError ? <p role="alert">Limits could not be checked. Choose Check again.</p> : null}<AgentRows agents={agents} error={error} reload={reload} limits={usage?.limits ?? []} /></div>
    </Section>
    <Section title="Local models" meta="endpoints on this machine or your tailnet · each job goes to a free one with its role" end={<button className="btn ghost sm" onClick={reloadLocal}>Check again</button>}>
      {(local ?? models.map((m) => ({ ...m, label: m.label ?? null, roles: m.roles ?? [], state: null }))).map((m) => <LocalRow key={m.name + m.url} m={m}
        save={async (change) => { await postJson("/api/setup/settings", { localModels: models.map((x) => x.name === m.name && x.url === m.url ? { ...x, ...change } : x) }); reloadSettings(); reloadLocal(); }}
        remove={async () => { await postJson("/api/setup/settings", { localModels: models.filter((x) => !(x.name === m.name && x.url === m.url)) }); reloadSettings(); }} />)}
      {!models.length ? <div className="sec-r muted" style={{ fontSize: 14 }}>None saved. Add Ollama or llama.cpp below; module briefs, the local helper, Insights and Ask use them.</div> : null}
      <div className="opts in-sec">
        <Form title="Add an endpoint" save={async (f) => {
          const roles = LOCAL_ROLE_KEYS.filter((r) => f.get(`role-${r}`));
          const model = { name: v(f, "name"), provider: v(f, "provider") as "ollama" | "llama.cpp", url: v(f, "url"), ...(v(f, "label") ? { label: v(f, "label") } : {}), ...(roles.length ? { roles } : {}) };
          await postJson("/api/setup/model/probe", model);
          await postJson("/api/setup/settings", { localModels: [...models.filter((m) => !(m.name === model.name && m.url === model.url)), model] });
          reloadSettings();
        }}>
          <div className="two"><label className="field">Model<input className="in" name="name" required placeholder="qwen3-coder" /></label>
            <label className="field">Runs on<select className="in" name="provider" defaultValue="ollama"><option value="ollama">Ollama</option><option value="llama.cpp">llama.cpp</option></select></label></div>
          <div className="two"><label className="field">Address <span className="hint">this machine or your tailnet; checked before saving</span><input className="in mono" name="url" required defaultValue="http://127.0.0.1:11434" /></label>
            <label className="field">Name <span className="hint">optional, e.g. neo 4090</span><input className="in" name="label" maxLength={40} /></label></div>
          <fieldset className="field" style={{ border: 0, padding: 0, margin: 0 }}><legend>Use it for <span className="hint">none ticked = every job</span></legend>
            <div style={{ display: "flex", gap: 14, flexWrap: "wrap", marginTop: 6 }}>{LOCAL_ROLE_KEYS.map((r) => <label key={r} style={{ display: "inline-flex", gap: 6, alignItems: "center", fontSize: 14 }}><input type="checkbox" name={`role-${r}`} />{LOCAL_ROLES[r]}</label>)}</div></fieldset>
        </Form>
      </div>
    </Section>
    {models.length ? <HelperSection /> : null}
    <RoutingSection settings={settings} agents={agents} reload={reloadSettings} />
    {registry ? <RegistryDialog onClose={() => { setRegistry(false); reload(); }} /> : null}
  </main>;
}

/** Scheduled lanes (no board yet): a lane that starts on a schedule, through a systemd user timer. */
function ScheduledLanes() {
  const [list, error, reload] = useJson<ScheduleView[]>("/api/schedules");
  const [projects] = useJson<Project[]>("/api/projects");
  const [agents] = useJson<DetectedAgent[]>("/api/setup/agents");
  const [message, setMessage] = useState("");
  const v = (f: FormData, key: string) => String(f.get(key) ?? "").trim();
  return <Section id="schedules" title="Scheduled lanes" meta="started by a timer on this machine · never merged without you">
    {error ? <div className="sec-r muted">{error.message}</div> : null}
    {(list ?? []).map((s) => <div className="sec-r" key={s.id} style={{ display: "grid", gridTemplateColumns: "minmax(0,1.4fr) minmax(0,1fr) auto", gap: 14, alignItems: "center" }}>
      <span style={{ minWidth: 0 }}><b>{s.task}</b><span className="mono muted" style={{ display: "block", fontSize: 12 }}>{s.id} · {s.project} · {AGENT_NAMES[s.agent] ?? s.agent}{s.lastLane ? ` · last ${s.lastLane}` : ""}</span></span>
      <span className="mono" style={{ fontSize: 12.5 }}>{s.when}<span className="muted" style={{ display: "block" }}>{s.next ? `next ${s.next}` : "not scheduled"}</span></span>
      <span style={{ display: "flex", gap: 8 }}><Action small ghost run={() => postJson(`/api/schedules/${s.id}/run`, {})} done={reload}>Run now</Action><Action small ghost run={() => postJson(`/api/schedules/${s.id}`, {}, "DELETE")} done={reload}>Remove</Action></span>
    </div>)}
    {list && !list.length ? <div className="sec-r muted" style={{ fontSize: 14 }}>None. A nightly dependency bump or a weekly docs pass are good first ones.</div> : null}
    <div className="opts in-sec">
      <Form title="Add a scheduled lane" save={async (f) => {
        setMessage("");
        await postJson("/api/schedules", { id: v(f, "id"), project: v(f, "project"), task: v(f, "task"), agent: v(f, "agent"), mode: v(f, "mode"), base: v(f, "base") || "main", when: v(f, "when") }).then(reload, (e) => { setMessage(errorMessage(e)); throw e; });
      }}>
        <div className="two"><label className="field">Name <span className="hint">lowercase, e.g. nightly-deps</span><input className="in mono" name="id" required pattern="[a-z0-9][a-z0-9-]*" /></label>
          <label className="field">When <span className="hint">systemd calendar, e.g. Mon..Fri 07:30</span><input className="in mono" name="when" required defaultValue="*-*-* 02:00" /></label></div>
        <label className="field">Task<textarea className="in" name="task" rows={2} required /></label>
        <div className="two"><label className="field">Project<select className="in" name="project">{(projects ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
          <label className="field">Agent<select className="in" name="agent">{(agents ?? []).filter((a) => a.status === "Ready").map((a) => <option key={a.id} value={a.id}>{AGENT_NAMES[a.id] ?? a.id}</option>)}</select></label></div>
        <div className="two"><label className="field">Mode<select className="in" name="mode" defaultValue="ask"><option value="ask">Ask first</option><option value="edits">Accept edits</option><option value="plan">Plan only</option></select></label>
          <label className="field">Branch<input className="in mono" name="base" defaultValue="main" /></label></div>
      </Form>
      {message ? <p role="alert">{message}</p> : null}
    </div>
  </Section>;
}

/** Routing (models.webp): which agent and model a new lane gets, by words in its task. */
function RoutingSection({ settings, agents, reload }: { settings: SetupSettings | null; agents: DetectedAgent[] | null; reload: () => void }) {
  const rules = settings?.routing ?? [];
  const [error, setError] = useState("");
  const store = (next: RoutingRule[]) => postJson("/api/setup/settings", { routing: next }).then(reload);
  const save = (next: RoutingRule[]) => { setError(""); void store(next).catch((e) => setError(errorMessage(e))); };
  const v = (f: FormData, key: string) => String(f.get(key) ?? "").trim();
  return <Section title="Routing" meta="which agent and model a new lane gets · first match wins">
    {rules.map((r, i) => <div className="sec-r" key={i} style={{ display: "grid", gridTemplateColumns: "minmax(0,1.2fr) minmax(0,1fr) auto auto", gap: 14, alignItems: "center" }}>
      <span>{r.words.join(", ")}</span><span className="mono" style={{ fontSize: 13 }}>{AGENT_NAMES[r.agent] ?? r.agent}{r.model ? ` → ${r.model}` : ""}</span><span className="mono muted" style={{ fontSize: 12 }}>{r.label ?? ""}</span>
      <button className="lnk" onClick={() => save(rules.filter((_, j) => j !== i))}>Remove</button>
    </div>)}
    <div className="sec-r muted" style={{ fontSize: 13.5 }}>{rules.length ? "Anything else uses the first ready agent." : "No rules: New lane uses the first ready agent. Add one to send, say, docs and fixtures to a local model."}</div>
    <div className="opts in-sec">
      <Form title="Add a rule" save={async (f) => {
        const words = v(f, "words").split(",").map((w) => w.trim()).filter(Boolean);
        // Awaited, so the form says "Saved." only when the daemon took it, and shows its reason when not.
        await store([...rules, { words, agent: v(f, "agent"), ...(v(f, "model") ? { model: v(f, "model") } : {}), ...(v(f, "label") ? { label: v(f, "label") } : {}) }]);
      }}>
        <label className="field">Words in the task <span className="hint">comma-separated, e.g. docs, fixture, rename</span><input className="in" name="words" required /></label>
        <div className="two"><label className="field">Agent<select className="in" name="agent">{(agents ?? []).map((a) => <option key={a.id} value={a.id}>{AGENT_NAMES[a.id] ?? a.id}</option>)}</select></label>
          <label className="field">Model <span className="hint">optional</span><input className="in mono" name="model" /></label></div>
        <label className="field">Label <span className="hint">optional, e.g. saves cloud</span><input className="in" name="label" maxLength={40} /></label>
      </Form>
      {error ? <p role="alert">{error}</p> : null}
    </div>
  </Section>;
}

/** Add from ACP registry: agents that speak ACP, installed with npm, a checked download, or uv. */
function RegistryDialog({ onClose }: { onClose: () => void }) {
  const [list, error] = useJson<RegistryAgent[]>("/api/setup/registry");
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [filter, setFilter] = useState("");
  const install = (id: string) => { setBusy(id); setMessage(""); void postJson("/api/setup/registry/install", { id }).then(() => setMessage("Installed. It appears under Agents and in New lane."), (e) => setMessage(errorMessage(e))).finally(() => setBusy(null)); };
  const shown = (list ?? []).filter((a) => !filter || `${a.name} ${a.description}`.toLowerCase().includes(filter.toLowerCase()));
  return <Dialog title="Add from ACP registry" meta="agents that speak the Agent Client Protocol" onClose={onClose} footer={<div className="e">{message ? <span role="status">{message}</span> : null}<button className="btn ghost" onClick={onClose}>Done</button></div>}>
    {error ? <Empty>{error.message}</Empty> : !list ? <Empty>Reading the registry…</Empty> : <>
      <input className="in" aria-label="Filter agents" placeholder="Filter…" value={filter} onChange={(e) => setFilter(e.target.value)} style={{ marginBottom: 8 }} />
      {shown.map((a) => <div className="repo" key={a.id}>
        <span style={{ minWidth: 0 }}><span className="nm"><b>{a.name}</b><span className="mono">{a.version}</span></span><span className="sub" style={{ display: "block" }}>{[a.description, a.license].filter(Boolean).join(" · ")}</span></span>
        <span className="meta">{a.installed ? <span className="sig">added</span> : a.install ? <button className="btn sm" disabled={!!busy} onClick={() => install(a.id)}>{busy === a.id ? "Installing…" : "Install"}</button> : <span className="muted" style={{ fontSize: 12.5 }}>no build for this machine</span>}</span>
      </div>)}
      <p className="muted" style={{ fontSize: 12.5 }}>Each agent keeps its own login. Lanes start them in a mode where you approve their actions; approval-bypassing switches are never passed.</p>
    </>}
  </Dialog>;
}

const HELPER_WORDS: Record<HelperStatus["kind"], [string, string, IconName]> = { read: ["Read", "logs, test output, big files", "read"], edit: ["Edit", "renames, fixtures, small specs", "edit"], check: ["Check", "run tests, sort failures", "test"] };
const tokensK = (n: number) => n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);

/** Local helper (models.webp): work Claude and Codex hand off with delegate, on only while it pays. */
function HelperSection() {
  const [kinds, , reload] = useJson<HelperStatus[]>("/api/helper");
  const [error, setError] = useState("");
  const toggle = (kind: HelperStatus["kind"], on: boolean) => { setError(""); void postJson("/api/helper", { kind, on }).then(reload, (e) => setError(errorMessage(e))); };
  return <Section title="Local helper" meta="work Claude and Codex hand off with delegate · on only while it pays" footer={<span className="mono muted" style={{ fontSize: 12 }}>green = cloud tokens saved this week (estimated) · one job per GPU at a time{error ? ` · ${error}` : ""}</span>}>
    {(kinds ?? []).map((k) => { const [name, what, icon] = HELPER_WORDS[k.kind]; return <div className="sec-r lmrow" key={k.kind}>
      <Tile family="team" icon={icon} small />
      <span><b>{name}</b><span className="muted" style={{ display: "block", fontSize: 12.5 }}>{what}</span></span>
      <span className="mono" style={{ fontSize: 13 }}>{k.model ?? "—"}</span>
      <span className="mono" style={{ fontSize: 12.5 }}>{k.uses} {k.uses === 1 ? "use" : "uses"}{k.redoneRate !== null ? ` · ${Math.round(k.redoneRate * 100)}% redone` : ""}{k.savedThisWeek ? <b style={{ marginLeft: 14, color: "var(--ok-ink)", fontSize: 14 }}>{tokensK(k.savedThisWeek)}</b> : null}</span>
      <span style={{ textAlign: "right" }}>
        <Glyph g={k.state === "on" ? "done" : k.state === "near" ? "wait" : "idle"}>{k.state === "on" ? "On" : k.state === "near" ? "Near the limit" : "Off"}</Glyph>
        {k.reason ? <span className="muted" style={{ display: "block", fontSize: 12 }}>{k.reason}</span> : null}
        {k.model ? <button className="lnk" style={{ display: "block", marginLeft: "auto", fontSize: 12.5 }} onClick={() => toggle(k.kind, k.state === "off")}>{k.state === "off" ? "Turn on" : "Turn off"}</button> : null}
      </span>
    </div>; })}
  </Section>;
}
