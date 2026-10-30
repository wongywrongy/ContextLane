import { useState } from "react";
import type { Lane, LaneEvent } from "@contextlanes/protocol";
import { READY } from "../features";
import { Glyph, Tile, laneNumber } from "../components/ui";

/** The lane inspector from the Console board: plan, context, checkout, then lane actions. */
export function Inspector({ lane, events, openTerminal }: { lane: Lane; events: LaneEvent[]; openTerminal: () => void }) {
  const usage = events.findLast((e) => e.type === "usage");
  const plan = events.findLast((e) => e.type === "agent.plan");
  const [copied, setCopied] = useState("");
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
      <div className="ps-h"><span className="lbl">Context</span></div>
      {used ? <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <svg className="ring" viewBox="0 0 36 36" role="img" aria-label={`Context ${Math.round(share * 100)}% used`}><circle cx="18" cy="18" r="14" fill="none" stroke="#E9E3D8" strokeWidth="5" /><circle cx="18" cy="18" r="14" fill="none" stroke={ringColour} strokeWidth="5" strokeDasharray={`${share * 88} 88`} transform="rotate(-90 18 18)" /></svg>
        <div><b style={{ fontSize: 18 }}>{Math.round(share * 100)}%</b><div className="muted" style={{ fontSize: 13 }}>{compact(used.contextUsed)} of {compact(used.contextSize)} tokens{used.costUsd !== undefined ? ` · ${new Intl.NumberFormat(undefined, { style: "currency", currency: "USD" }).format(used.costUsd)}` : ""}</div></div>
      </div> : <p className="muted" style={{ margin: 0, fontSize: 13.5 }}>Shows how full the agent’s context is once it reports it.</p>}
    </section>
    <section className="ps">
      <div className="ps-h"><span className="lbl">Checkout</span></div>
      <dl className="kv2"><dt>Branch</dt><dd className="mono">{lane.branch}</dd><dt>Folder</dt><dd className="mono">{lane.worktree}</dd><dt>Started</dt><dd>{new Date(lane.createdAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}</dd></dl>
    </section>
    {READY.run ? <section className="ps"><div className="ps-h"><span className="lbl">Environment</span></div>{/* Phase 2: services with glyphs and private links, from env.status events. */}</section> : null}
    <section className="ps">
      <div className="ps-h" style={{ marginBottom: 6 }}><span className="lbl">Lane</span></div>
      <button className="act" onClick={openTerminal}><Tile family="run" icon="execute" small />Open the terminal</button>
      <button className="act" onClick={() => void copy(`contextlanes term ${lane.id}`, "Command")}><Tile family="look" icon="read" small />Copy the terminal command</button>
      <button className="act" onClick={() => void copy(lane.branch, "Branch")}><Tile family="change" icon="move" small />Copy the branch name</button>
      {READY.handoff ? <><button className="act"><Tile family="team" icon="handoff" small />Hand off to another agent</button><button className="act"><Tile family="team" icon="subagent" small />Fork into a new lane</button></> : null}
      {READY.review ? <button className="act"><Tile family="you" icon="checkpoint" small />Send checkpoint to review</button> : null}
      {copied ? <p role="status" className="muted" style={{ margin: "8px 0 0", fontSize: 12.5 }}>{copied}</p> : null}
      <p className="muted" style={{ margin: "10px 0 0", fontSize: 12 }}>Lane {laneNumber(lane.id)} · {lane.terminal}</p>
    </section>
  </aside>;
}

function compact(n: number): string {
  return n >= 1000 ? `${Math.round(n / 100) / 10}k` : String(n);
}
