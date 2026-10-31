import { useState } from "react";
import { Link, useNavigate } from "react-router";
import type { DetectedAgent, Lane, LaneEvent } from "@contextlanes/protocol";
import { READY } from "../features";
import { AGENT_NAMES, Dialog, Glyph, Tile, laneNumber } from "../components/ui";
import { errorMessage, postJson, useJson } from "../api";
import { editorLink, useEditor } from "../components/editor";
import { environmentFrom, SERVICE_GLYPH } from "./model";

/** The lane inspector from the Console board: plan, context, checkout, then lane actions. */
export function Inspector({ lane, events, openTerminal }: { lane: Lane; events: LaneEvent[]; openTerminal: () => void }) {
  const usage = events.findLast((e) => e.type === "usage");
  const compactions = new Set(events.filter((e) => e.type === "usage.compaction").map((e) => `${e.payload.sessionId}/${e.payload.compactionId}`)).size;
  const plan = events.findLast((e) => e.type === "agent.plan");
  const [copied, setCopied] = useState("");
  const editor = useEditor();
  const [handoff, setHandoff] = useState<"fresh" | "agent" | "fork" | null>(null);
  const copy = async (text: string, what: string) => {
    try { await navigator.clipboard.writeText(text); setCopied(`${what} copied.`); } catch { setCopied(`Copy failed. ${what}: ${text}`); }
  };
  const entries = plan?.type === "agent.plan" ? plan.payload.entries : [];
  const done = entries.filter((e) => e.status === "completed").length;
  const used = usage?.type === "usage" ? usage.payload : null;
  const share = used && used.contextSize ? Math.min(1, used.contextUsed / used.contextSize) : 0;
  const ringColour = share > .85 ? "var(--bad)" : share > .6 ? "var(--you)" : "var(--ok)";
  return <aside className="pane r" aria-label="Lane details">
    <section className="ps">
      <div className="ps-h"><span className="lbl">Plan</span>{entries.length ? <div className="e"><span className="mono muted" style={{ fontSize: 12 }}>{done} of {entries.length}</span></div> : null}</div>
      {entries.length ? <div className="plan">{entries.map((entry, i) => <Glyph key={i} g={entry.status === "completed" ? "done" : entry.status === "in_progress" ? "think" : "idle"}>{entry.text}</Glyph>)}</div>
        : <p className="muted" style={{ margin: 0, fontSize: 13.5 }}>Shows the agent’s plan when it writes one.</p>}
    </section>
    <section className="ps">
      <div className="ps-h"><span className="lbl">Context</span>{compactions ? <span className="e mono muted">{compactions} compaction{compactions === 1 ? "" : "s"}</span> : null}</div>
      {used ? <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <svg className="ring" viewBox="0 0 36 36" role="img" aria-label={`Context ${Math.round(share * 100)}% used`}><circle cx="18" cy="18" r="14" fill="none" stroke="#E9E3D8" strokeWidth="5" /><circle cx="18" cy="18" r="14" fill="none" stroke={ringColour} strokeWidth="5" strokeDasharray={`${share * 88} 88`} transform="rotate(-90 18 18)" /></svg>
        <div><b style={{ fontSize: 18 }}>{Math.round(share * 100)}%</b><div className="muted" style={{ fontSize: 13 }}>{compact(used.contextUsed)} of {compact(used.contextSize)} tokens{used.costUsd !== undefined ? ` · ${new Intl.NumberFormat(undefined, { style: "currency", currency: "USD" }).format(used.costUsd)}` : ""}</div></div>
      </div> : <p className="muted" style={{ margin: 0, fontSize: 13.5 }}>Shows how full the agent’s context is once it reports it.</p>}
      {READY.handoff && ["working", "needs_you"].includes(lane.state) ? <button className="btn ghost sm" style={{ width: "100%", marginTop: 12 }} onClick={() => setHandoff("fresh")}>Restart with a summary</button> : null}
    </section>
    <section className="ps">
      <div className="ps-h"><span className="lbl">Checkout</span></div>
      <dl className="kv2"><dt>Branch</dt><dd className="mono">{lane.branch}</dd><dt>Folder</dt><dd className="mono">{lane.worktree}</dd><dt>Started</dt><dd>{new Date(lane.createdAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}</dd></dl>
    </section>
    {READY.run ? <EnvironmentBlock lane={lane} events={events} /> : null}
    <section className="ps">
      <div className="ps-h" style={{ marginBottom: 6 }}><span className="lbl">Your access</span></div>
      <button className="act" onClick={openTerminal}><Tile family="run" icon="execute" small />Open the lane's terminal</button>
      {editor ? <a className="act" href={editorLink(editor, lane.worktree)}><Tile family="look" icon="read" small />Open the folder in your editor</a> : null}
      <p className="muted" style={{ margin: "6px 0 0", fontSize: 12.5 }}>From any shell: <button className="lnk mono" style={{ fontSize: 12 }} onClick={() => void copy(`contextlanes term ${lane.id}`, "Command")}>contextlanes term {lane.id}</button> · branch <button className="lnk mono" style={{ fontSize: 12, overflowWrap: "anywhere", textAlign: "left" }} onClick={() => void copy(lane.branch, "Branch name")}>{lane.branch}</button> <span className="muted">(click to copy)</span></p>
      {READY.handoff ? <><div className="ps-h" style={{ margin: "14px 0 6px" }}><span className="lbl">Continue elsewhere</span></div>
        <button className="act" disabled={!["working", "needs_you"].includes(lane.state)} onClick={() => setHandoff("agent")}><Tile family="team" icon="handoff" small />Hand off to another agent</button>
        <button className="act" onClick={() => setHandoff("fork")}><Tile family="team" icon="subagent" small />Copy into a new lane</button></> : null}
      {["working", "needs_you", "failed"].includes(lane.state) ? <button className="act" onClick={() => { if (window.confirm("Stop this lane's agent and start it again from the lane's first task? The checkout stays as it is.")) void postJson(`/api/lanes/${lane.id}/restart`, {}).then(() => setCopied("Agent restarted. It reports in within a minute."), (e) => setCopied(errorMessage(e))); }}><Tile family="run" icon="execute" small />Restart the agent</button> : null}
      {["cleaned", "failed"].includes(lane.state) ? <button className="act" onClick={() => void postJson(`/api/lanes/${lane.id}/archive`, {}).then(() => setCopied("Archived. Show archived lanes in the list to find it again."), (e) => setCopied(errorMessage(e)))}><Tile family="look" icon="checkpoint" small />Archive this lane</button> : null}
      {copied ? <p role="status" className="muted" style={{ margin: "8px 0 0", fontSize: 12.5 }}>{copied}</p> : null}
      <p className="muted" style={{ margin: "10px 0 0", fontSize: 12 }}>Lane {laneNumber(lane.id)} · {lane.terminal}</p>
    </section>
    {handoff ? <HandoffDialog lane={lane} kind={handoff} onClose={() => setHandoff(null)} /> : null}
  </aside>;
}

/** Services with their state and private links, from env.status events. */
function EnvironmentBlock({ lane, events }: { lane: Lane; events: LaneEvent[] }) {
  const { services, recipeWaiting } = environmentFrom(events);
  return <section className="ps">
    <div className="ps-h"><span className="lbl">Environment</span><div className="e"><Link className="lnk" to={`/p/${lane.project}/run`} style={{ fontSize: 12.5 }}>Run →</Link></div></div>
    {services.length ? <div className="plan">{services.map((s) => <Glyph key={s.service} g={SERVICE_GLYPH[s.state ?? (s.up ? "healthy" : "stopped")]}>{s.service}{s.port ? <span className="mono muted" style={{ fontSize: 12, fontWeight: 400 }}>:{s.port}</span> : null}{s.url ? <a className="lnk mono" style={{ fontSize: 12 }} href={s.url} target="_blank" rel="noreferrer">open ↗</a> : null}</Glyph>)}</div>
      : <p className="muted" style={{ margin: 0, fontSize: 13.5 }}>{recipeWaiting ? "The recipe needs your approval before this lane can start." : "Not started."}</p>}
  </section>;
}

function compact(n: number): string {
  return n >= 1000 ? `${Math.round(n / 100) / 10}k` : String(n);
}

/** Fresh session, hand off or fork (4.1): what happens, which agent, and a note for the next session. */
function HandoffDialog({ lane, kind, onClose }: { lane: Lane; kind: "fresh" | "agent" | "fork"; onClose: () => void }) {
  const [agents] = useJson<DetectedAgent[]>(kind === "fresh" ? null : "/api/setup/agents");
  const [agent, setAgent] = useState(kind === "agent" ? "" : lane.agent);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const navigate = useNavigate();
  const ready = (agents ?? []).filter((a) => a.status === "Ready" && (kind !== "agent" || a.id !== lane.agent));
  const go = () => {
    setBusy(true); setError("");
    const body = { ...(kind !== "fresh" && agent ? { agent } : {}), ...(note.trim() ? { note: note.trim() } : {}) };
    void postJson<Lane>(`/api/lanes/${lane.id}/${kind === "fork" ? "fork" : "handoff"}`, body).then((r) => { onClose(); if (kind === "fork") navigate(`/p/${lane.project}/work?lane=${encodeURIComponent(r.id)}`); }, (e) => setError(errorMessage(e))).finally(() => setBusy(false));
  };
  const title = kind === "fresh" ? "Restart with a summary" : kind === "agent" ? "Hand off to another agent" : "Copy into a new lane";
  return <Dialog title={title} onClose={onClose} footer={<div className="e">{error ? <span role="alert">{error}</span> : null}<button className="btn ghost" onClick={onClose}>Cancel</button><button className="btn" disabled={busy || (kind === "agent" && !agent)} onClick={go}>{busy ? "Starting…" : kind === "fork" ? "Start the copy" : "Write the summary and continue"}</button></div>}>
    <p style={{ margin: "0 0 12px", fontSize: 14 }}>{kind === "fork" ? `A new lane starts from ${lane.branch} with its uncommitted changes, and its agent starts from a summary of this lane's conversation. This lane keeps going.` : `${AGENT_NAMES[lane.agent] ?? lane.agent} writes a summary of the work so far, its session ends, and ${kind === "fresh" ? "a new session of the same agent, with an empty context," : "the agent you choose"} continues in the same branch and folder from that summary. Use it when the context is full or the agent is going in circles. Takes a minute or two.`}</p>
    {kind !== "fresh" ? <label className="field">Agent<select className="in" value={agent} onChange={(e) => setAgent(e.target.value)}>{kind === "agent" ? <option value="">Choose…</option> : null}{(kind === "fork" ? (agents ?? []).filter((a) => a.status === "Ready") : ready).map((a) => <option key={a.id} value={a.id}>{AGENT_NAMES[a.id] ?? a.id}</option>)}</select></label> : null}
    <label className="field" style={{ marginTop: 10 }}>Note for the next session <span className="hint">optional</span><textarea className="in" rows={3} value={note} maxLength={2000} onChange={(e) => setNote(e.target.value)} /></label>
  </Dialog>;
}
