import { useState } from "react";
import type { Collision, Lane } from "@contextlanes/protocol";
import { errorMessage, postJson, useJson } from "../../api";
import { LaneBadge, laneNumber } from "../../components/ui";

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

/** What agents are told about a module (phase 3.5). Hidden until briefs exist. */
export function BriefBlock(_: { project: string; module: string }) {
  return null;
}
