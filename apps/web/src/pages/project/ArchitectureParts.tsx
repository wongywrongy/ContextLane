import { useState } from "react";
import type { Collision, Lane, ModuleBrief, TidyView } from "@contextlanes/protocol";
import { errorMessage, postJson, useJson } from "../../api";
import { Link } from "react-router";
import { Fact, Glyph, LaneBadge, Section, agoText, laneNumber } from "../../components/ui";

/**
 * "Two lanes are editing this": who and how much, the suggested order and why, and the one action:
 * have the waiting lane rebase once the first one merges. Nothing reaches an agent before that.
 */
export function CollisionBox({ project, module, editing, lanes }: { project: string; module: string; editing: { lane: Lane; files: string[] }[]; lanes: Lane[] }) {
  const [open, , reload] = useJson<Collision[]>(`/api/projects/${project}/collisions`);
  const [error, setError] = useState("");
  const c = open?.find((x) => x.module === module);
  const order = c?.order ?? editing.map((e) => e.lane.id);
  const first = lanes.find((l) => l.id === order[0]);
  const next = lanes.find((l) => l.id === order[1]);
  const plan = () => { setError(""); void postJson(`/api/projects/${project}/collisions/plan`, { module, lane: next!.id }).then(reload, (e) => setError(errorMessage(e))); };
  return <div className="cbox" role="note">
    <b style={{ fontSize: 14 }}><i className="g wait" aria-hidden="true" /> {editing.length === 2 ? "Two" : editing.length} lanes are editing this</b>
    {order.map((id) => { const t = editing.find((e) => e.lane.id === id); return t ? <div key={id} style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 13.5 }}><LaneBadge id={t.lane.id} colour={t.lane.colour} /><span style={{ minWidth: 0, overflowWrap: "anywhere" }}>{t.lane.task}</span><span className="mono muted" style={{ marginLeft: "auto", fontSize: 12 }}>{t.files.length} {t.files.length === 1 ? "file" : "files"}</span></div> : null; })}
    {c && first && next ? <>
      <span className="muted" style={{ fontSize: 12.5 }}>Merge {laneNumber(first.id)} first: {c.reason.replace(first.id, laneNumber(first.id)).replace(next.id, laneNumber(next.id))}.</span>
      {c.planned ? <span style={{ fontSize: 13 }}>Lane {laneNumber(next.id)} will be told to rebase when {laneNumber(first.id)} merges.</span>
        : <button className="btn" onClick={plan}>Rebase {laneNumber(next.id)} after {laneNumber(first.id)} merges</button>}
    </> : <span className="muted" style={{ fontSize: 12.5 }}>The suggested merge order appears within a minute.</span>}
    {error ? <span role="alert" style={{ fontSize: 13 }}>{error}</span> : null}
  </div>;
}

const k = (n: number) => n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n);

/** "Brief agents get": what get_brief returns for this module, editable, with its size against reading the files. */
export function BriefBlock({ project, module }: { project: string; module: string }) {
  const [brief, error, reload] = useJson<ModuleBrief>(`/api/projects/${project}/briefs?module=${encodeURIComponent(module)}`);
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const act = (p: Promise<unknown>) => { setBusy(true); setMessage(""); void p.then(() => { setEditing(null); reload(); }, (e) => setMessage(errorMessage(e))).finally(() => setBusy(false)); };
  if (error || !brief) return null;
  return <div className="ps">
    <div className="ps-h"><span className="lbl">Brief agents get</span><div className="e">{editing === null ? <button className="btn ghost sm" onClick={() => setEditing(brief.text ?? "")}>Edit</button> : null}</div></div>
    {editing !== null ? <>
      <textarea className="in" rows={6} value={editing} maxLength={4000} onChange={(e) => setEditing(e.target.value)} aria-label="Brief" />
      <div style={{ display: "flex", gap: 8, marginTop: 8 }}><button className="btn sm" disabled={busy || !editing.trim()} onClick={() => act(postJson(`/api/projects/${project}/briefs`, { module, text: editing }, "PUT"))}>Save</button><button className="btn ghost sm" onClick={() => setEditing(null)}>Cancel</button></div>
    </> : brief.text ? <p style={{ margin: 0, fontSize: 14, lineHeight: 1.55, whiteSpace: "pre-wrap" }}>{brief.text}</p>
      : <Fact g="idle" detail="agents get CodeGraph's facts">No brief</Fact>}
    {brief.stale && editing === null ? <div style={{ marginTop: 8 }}><Glyph g="idle">Older than its files</Glyph></div> : null}
    {brief.canWrite && editing === null && (!brief.text || brief.stale) ? <button className="btn sm" style={{ marginTop: 10 }} disabled={busy} onClick={() => act(postJson(`/api/projects/${project}/briefs/write`, { module }))}>{busy ? "Writing…" : brief.text ? "Write it again" : "Write it now"}</button> : null}
    {brief.tokens !== null ? <div style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: "4px 12px", marginTop: 14, fontSize: 13 }}>
      <span className="muted">this brief</span><span className="mono" style={{ color: "var(--ok-ink)", fontWeight: 600 }}>≈ {k(brief.tokens)} tokens</span>
      <span className="muted">reading the files instead</span><span className="mono">≈ {k(brief.filesTokens)} tokens</span>
    </div> : null}
    {brief.edited ? <p className="muted" style={{ margin: "8px 0 0", fontSize: 12 }}>Edited by you.</p> : brief.model ? <p className="muted" style={{ margin: "8px 0 0", fontSize: 12 }}>Written by {brief.model}.</p> : null}
    {message ? <p role="alert" style={{ margin: "8px 0 0", fontSize: 13 }}>{message}</p> : null}
  </div>;
}

/**
 * Grouping: areas and layers come from folder names until the owner approves a local model's tidy.
 * The proposal shows every module that would move; nothing changes before Approve.
 */
export function TidyBlock({ project, changed }: { project: string; changed: () => void }) {
  const [view, , reload] = useJson<TidyView>(`/api/projects/${project}/tidy`);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [all, setAll] = useState(false);
  const act = async (path: string, method = "POST") => {
    setBusy(true); setError("");
    try { await postJson(`/api/projects/${project}/tidy${path}`, {}, method); reload(); changed(); } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  };
  if (!view) return null;
  const p = view.proposal;
  if (p) return <Section title="Proposed grouping" meta={`by ${p.model} · ${agoText(p.at)} · ${p.changes.length} ${p.changes.length === 1 ? "module moves" : "modules move"}`}
    end={<><button className="btn sm" disabled={busy} onClick={() => void act("/approve")}>Approve</button><button className="btn ghost sm" disabled={busy} onClick={() => void act("/discard")}>Discard</button></>}>
    {(() => {
      // Area moves grouped by where they come from and go to; layer moves one module at a time.
      const moves = new Map<string, number>();
      for (const c of p.changes) if (c.from.area !== c.to.area) moves.set(`${c.from.area}\u0000${c.to.area}`, (moves.get(`${c.from.area}\u0000${c.to.area}`) ?? 0) + 1);
      const layers = p.changes.filter((c) => c.from.layer !== c.to.layer);
      const rows = [...moves].map(([k, n]) => { const [from, to] = k.split("\u0000"); return <div className="sec-r" key={k} style={{ minHeight: 40, fontSize: 13.5 }}><span className="mono" style={{ flex: "1 1 0", minWidth: 0, overflowWrap: "anywhere" }}>{from}</span><span style={{ flex: "1 1 0", minWidth: 0 }}>→ <b>{to}</b> <span className="muted">· {n} {n === 1 ? "module" : "modules"}</span></span></div>; });
      const layerRows = layers.map((c) => <div className="sec-r" key={c.module} style={{ minHeight: 40, fontSize: 13.5 }}><span className="mono" style={{ flex: "1 1 0", minWidth: 0, overflowWrap: "anywhere" }}>{c.module}</span><span style={{ flex: "1 1 0", minWidth: 0 }}><span className="muted">{c.from.layer}</span> → <b>{c.to.layer}</b> <span className="muted">layer</span></span></div>);
      const shown = [...rows, ...layerRows];
      return <>{shown.slice(0, all ? undefined : 12)}{shown.length > 12 ? <div className="sec-r"><button className="lnk" onClick={() => setAll((v) => !v)}>{all ? "Show fewer" : `Show all ${shown.length}`}</button></div> : null}</>;
    })()}
    {p.notes.length ? <div className="sec-f" style={{ fontSize: 13.5, display: "grid", gap: 4 }}><span className="lbl">Why</span>{p.notes.map((n, i) => <span key={i}>{n}</span>)}</div> : null}
    {error ? <div className="sec-f" role="alert">{error}</div> : null}
  </Section>;
  return <Section title="Grouping" help="Without a grouping, areas are top folders and layers are guessed from folder names. Your local model can suggest named areas and fix layers; nothing changes until you approve, and module names never change.">
    <div className="sec-r wrap">
      <span className="grow">{view.approved ? <Fact g="done" detail={`${view.approved.model} · ${agoText(view.approved.at)}`}>{`${view.approved.areas} named areas, approved`}</Fact> : <Fact g="idle">From folder names</Fact>}</span>
      {view.canRun ? <button className="btn ghost sm" disabled={busy || view.running} onClick={() => void act("")}>{busy || view.running ? "Thinking…" : view.approved ? "Suggest again" : "Suggest a grouping"}</button>
        : <Link className="btn ghost sm" to="/models">Add a local model</Link>}
      {view.approved ? <button className="btn ghost sm" disabled={busy} onClick={() => void act("", "DELETE")}>Back to folders</button> : null}
    </div>
    {error ? <div className="sec-f" role="alert">{error}</div> : null}
  </Section>;
}
