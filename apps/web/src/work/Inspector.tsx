import { useState } from "react";
import { Link, useNavigate } from "react-router";
import type { DetectedAgent, DiscardPreview, Lane, LaneEvent } from "@contextlanes/protocol";
import { READY } from "../features";
import { AGENT_NAMES, Dialog, Glyph, Tile, laneNumber } from "../components/ui";
import { errorMessage, postJson, useJson } from "../api";
import { editorLink, useEditor } from "../components/editor";
import { environmentFrom, SERVICE_GLYPH } from "./model";

/** The lane inspector: context, environment, then your access and lane actions. The plan lives in Progress. */
export function Inspector({ lane, events, openTerminal }: { lane: Lane; events: LaneEvent[]; openTerminal: () => void }) {
  const usage = events.findLast((e) => e.type === "usage");
  const compactions = new Set(events.filter((e) => e.type === "usage.compaction").map((e) => `${e.payload.sessionId}/${e.payload.compactionId}`)).size;
  const [copied, setCopied] = useState("");
  const [deleting, setDeleting] = useState(false);
  const editor = useEditor();
  const [handoff, setHandoff] = useState<"fresh" | "agent" | "fork" | null>(null);
  const copy = async (text: string, what: string) => {
    try { await navigator.clipboard.writeText(text); setCopied(`${what} copied.`); } catch { setCopied(`Copy failed. ${what}: ${text}`); }
  };
  const used = usage?.type === "usage" ? usage.payload : null;
  const share = used && used.contextSize ? Math.min(1, used.contextUsed / used.contextSize) : 0;
  return <aside className="pane r" aria-label="Lane details">
    {used ? <details className="ps inspector-disclosure">
      <summary>Context <span className="mono muted">{Math.round(share * 100)}%</span></summary>
      <div className="muted inspector-note">{compact(used.contextUsed)} of {compact(used.contextSize)} tokens{used.costUsd !== undefined ? ` · ${new Intl.NumberFormat(undefined, { style: "currency", currency: "USD" }).format(used.costUsd)}` : ""}</div>
      {compactions ? <div className="muted inspector-note">{compactions} compaction{compactions === 1 ? "" : "s"}</div> : null}
      {share > .8 ? <div className="inspector-note"><Glyph g="idle">The agent compacts context automatically</Glyph></div> : null}
    </details> : null}
    {READY.run ? <EnvironmentBlock lane={lane} events={events} /> : null}
    <section className="ps">
      <div className="ps-h" style={{ marginBottom: 6 }}><span className="lbl">Access</span></div>
      <button className="act" onClick={openTerminal}><Tile family="run" icon="execute" small />Open terminal</button>
      {editor ? <a className="act" href={editorLink(editor, lane.worktree)}><Tile family="look" icon="read" small />Open in editor</a> : null}
      <details className="inspector-disclosure">
        <summary>Copy details</summary>
        <button className="act" onClick={() => void copy(`contextlanes term ${lane.id}`, "Command")} title="Copy the command that opens this lane's terminal from any shell"><Tile family="run" icon="execute" small /><span className="mono" style={{ fontSize: 12.5 }}>contextlanes term {lane.id}</span><span className="muted" style={{ marginLeft: "auto", fontSize: 12 }}>copy</span></button>
        <button className="act" onClick={() => void copy(lane.worktree, "Folder")} title={`Copy the folder: ${lane.worktree}`}><Tile family="look" icon="read" small /><span className="mono" style={{ fontSize: 12.5, overflowWrap: "anywhere", textAlign: "left" }}>{lane.worktree.split("/").slice(-2).join("/")}</span><span className="muted" style={{ marginLeft: "auto", fontSize: 12 }}>copy</span></button>
        <button className="act" onClick={() => void copy(lane.branch, "Branch name")} title="Copy the branch name"><Tile family="change" icon="subagent" small /><span className="mono" style={{ fontSize: 12.5, overflowWrap: "anywhere", textAlign: "left" }}>{lane.branch}</span><span className="muted" style={{ marginLeft: "auto", fontSize: 12 }}>copy</span></button>
      </details>
      {(!["merged", "archived"].includes(lane.state) || (READY.handoff && lane.kind !== "cli")) ? <details className="inspector-disclosure" open={lane.state === "failed"}>
        <summary>Lane actions</summary>
        {(READY.handoff && lane.kind !== "cli") && ["working", "needs_you"].includes(lane.state) ? <button className="act" onClick={() => setHandoff("fresh")}>Restart with a summary</button> : null}
        {(READY.handoff && lane.kind !== "cli") ? <>
        <button className="act" disabled={!["working", "needs_you"].includes(lane.state)} onClick={() => setHandoff("agent")}><Tile family="team" icon="handoff" small />Hand off to another agent</button>
        <button className="act" onClick={() => setHandoff("fork")}><Tile family="team" icon="subagent" small />Copy into a new lane</button></> : null}
        {["working", "needs_you", "failed"].includes(lane.state) ? <button className="act" onClick={() => { if (window.confirm("Stop this lane's agent and start it again from the lane's first task? The checkout stays as it is.")) void postJson(`/api/lanes/${lane.id}/restart`, {}).then(() => setCopied("Agent restarted. It reports in within a minute."), (e) => setCopied(errorMessage(e))); }}><Tile family="run" icon="execute" small />Restart the agent</button> : null}
        {lane.state !== "merged" && lane.state !== "archived" ? <button className="act" onClick={() => setDeleting(true)}><Tile family="you" icon="delete" small />Delete this lane…</button> : null}
        {["cleaned", "failed", "paused"].includes(lane.state) ? <button className="act" onClick={() => void postJson(`/api/lanes/${lane.id}/archive`, {}).then(() => setCopied("Archived. Show archived lanes in the list to find it again."), (e) => setCopied(errorMessage(e)))}><Tile family="look" icon="checkpoint" small />Archive this lane</button> : null}
      </details> : null}
      {deleting ? <DeleteDialog lane={lane} onClose={() => setDeleting(false)} /> : null}
      {copied ? <p role="status" className="muted" style={{ margin: "8px 0 0", fontSize: 12.5 }}>{copied}</p> : null}
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
      : recipeWaiting ? <Glyph g="wait">Recipe needs approval</Glyph> : <Glyph g="idle">Stopped</Glyph>}
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
  return <Dialog title={title} onClose={onClose} footer={<div className="e">{error ? <span role="alert">{error}</span> : null}<button className="btn ghost" onClick={onClose}>Cancel</button><button className="btn" disabled={busy || (kind === "agent" && !agent)} aria-busy={busy || undefined} onClick={go}>{busy ? "Starting…" : kind === "fork" ? "Start the copy" : "Write the summary and continue"}</button></div>}>
    <p style={{ margin: "0 0 12px", fontSize: 14 }}>{kind === "fork" ? `A new lane starts from ${lane.branch} with its uncommitted changes, and its agent starts from a summary of this lane's conversation. This lane keeps going.` : `${AGENT_NAMES[lane.agent] ?? lane.agent} writes a summary of the work so far, its session ends, and ${kind === "fresh" ? "a new session of the same agent, with an empty context," : "the agent you choose"} continues in the same branch and folder from that summary. Use it when the context is full or the agent is going in circles. Takes a minute or two.`}</p>
    {kind !== "fresh" ? <label className="field">Agent<select className="in" value={agent} onChange={(e) => setAgent(e.target.value)}>{kind === "agent" ? <option value="">Choose…</option> : null}{(kind === "fork" ? (agents ?? []).filter((a) => a.status === "Ready") : ready).map((a) => <option key={a.id} value={a.id}>{AGENT_NAMES[a.id] ?? a.id}</option>)}</select></label> : null}
    <label className="field" style={{ marginTop: 10 }}>Note for the next session <span className="hint">optional</span><textarea className="in" rows={3} value={note} maxLength={2000} onChange={(e) => setNote(e.target.value)} /></label>
  </Dialog>;
}

/** Delete a lane: says exactly what is lost (uncommitted files, commits only on its branch) before doing it. */
function DeleteDialog({ lane, onClose }: { lane: Lane; onClose: () => void }) {
  const [preview] = useJson<DiscardPreview>(`/api/lanes/${lane.id}/discard`);
  const [branch, setBranch] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const navigate = useNavigate();
  const deleteBranch = branch ?? (preview ? preview.commits === 0 : false);
  const go = () => { setBusy(true); setError(""); void postJson(`/api/lanes/${lane.id}/discard`, { deleteBranch }).then(() => { onClose(); navigate(`/p/${lane.project}/work`); }, (e) => setError(errorMessage(e))).finally(() => setBusy(false)); };
  return <Dialog title={`Delete lane ${laneNumber(lane.id)}?`} onClose={onClose} footer={<div className="e">{error ? <span role="alert">{error}</span> : null}<button className="btn ghost" onClick={onClose}>Cancel</button><button className="btn" disabled={busy || !preview} aria-busy={busy || undefined} onClick={go}>{busy ? "Deleting…" : "Delete lane"}</button></div>}>
    <p style={{ margin: "0 0 10px", fontSize: 14 }}>{lane.direct ? "Stops this lane’s agent, services and terminal. Keeps the current checkout and branch:" : "Stops its agent, services and terminal, and removes its folder"} <span className="mono" style={{ fontSize: 12.5, overflowWrap: "anywhere" }}>{lane.worktree}</span>. Its history stays under Show archived.</p>
    {lane.direct ? null : preview ? <ul style={{ margin: "0 0 12px", paddingLeft: 18, fontSize: 14, display: "grid", gap: 4 }}>
      {preview.uncommitted ? <li><b>{preview.uncommitted} uncommitted {preview.uncommitted === 1 ? "change" : "changes"}</b> in the folder will be lost.</li> : <li>No uncommitted changes.</li>}
      <li>{preview.commits ? <><b>{preview.commits} {preview.commits === 1 ? "commit" : "commits"}</b> exist only on its branch.</> : "Its branch has no commits of its own."}</li>
    </ul> : <p className="muted" style={{ fontSize: 13.5 }}>Checking what the lane has…</p>}
    {!lane.direct ? <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 14 }}><input type="checkbox" checked={deleteBranch} onChange={(e) => setBranch(e.target.checked)} />Also delete the branch <span className="mono" style={{ fontSize: 12.5, overflowWrap: "anywhere" }}>{lane.branch}</span></label> : null}
  </Dialog>;
}
