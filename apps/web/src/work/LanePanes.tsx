import { lazy, Suspense, useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router";
import type { InboxItem, Lane, LaneEvent } from "@contextlanes/protocol";
import { useProjectWork } from "../components/Shell";
import { Empty, Glyph, LaneBadge, StateGlyph } from "../components/ui";
import { typingTarget } from "../keys";
import { FilterSwitch, Steps, type Filter } from "./Steps";
import { WorkDiff } from "./ReviewComments";
import { isIdle } from "./model";
import { PANE_KINDS, paneLeaves, parseLayout, replacePane, type PaneKind, type PaneLayout, type PaneLeaf } from "./panes";
const Terminal = lazy(() => import("../components/Terminal").then(module => ({ default: module.Terminal })));

export function LanePanes({ lane, events, waiting, reload, agent, interrupt, onView }: { lane: Lane; events: LaneEvent[]; waiting: InboxItem[]; reload: () => void; agent: string; interrupt: () => void; onView: (composerVisible: boolean) => void }) {
  const key = `cl-panes:${lane.id}`;
  const [layout, setLayout] = useState<PaneLayout>(() => { try { return parseLayout(JSON.parse(localStorage.getItem(key) ?? "null"), lane.kind === "cli" ? "terminal" : "progress"); } catch { return { id: "main", kind: lane.kind === "cli" ? "terminal" : "progress" }; } });
  const [active, setActive] = useState(() => paneLeaves(layout)[0]!.id);
  const [notice, setNotice] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const { environments } = useProjectWork();
  const preview = environments?.lanes.find(e => e.lane === lane.id)?.environment?.services.find(s => s.state === "healthy" && s.url)?.url;
  const leaves = paneLeaves(layout);
  const selected = leaves.find(p => p.id === active) ?? leaves[0]!;
  useEffect(() => onView(selected.kind === "progress" || selected.kind === "steps"), [selected.kind, onView]);
  useEffect(() => { try { localStorage.setItem(key, JSON.stringify(layout)); } catch { /* A private window still has working panes. */ } }, [key, layout]);
  const choose = (id: string, kind: PaneKind) => setLayout(before => replacePane(before, id, { id, kind })!);
  const split = (direction: "row" | "column") => {
    if (leaves.length >= 4) { setNotice("Up to four panes per lane. Close one to split again."); return; }
    const next: PaneLeaf = { id: crypto.randomUUID(), kind: (["diff", "preview", "steps"] as const).find(kind => !leaves.some(p => p.kind === kind)) ?? "terminal" };
    setLayout(before => replacePane(before, selected.id, { direction, first: selected, second: next })!); setActive(next.id); setNotice("");
  };
  useEffect(() => {
    const onSplit = (event: Event) => split((event as CustomEvent<"row" | "column">).detail);
    const view = (event: Event) => { const detail = (event as CustomEvent<{ lane: string; kind: PaneKind }>).detail; if (detail.lane === lane.id) choose(selected.id, detail.kind); };
    document.addEventListener("contextlanes:split", onSplit); document.addEventListener("contextlanes:view", view);
    return () => { document.removeEventListener("contextlanes:split", onSplit); document.removeEventListener("contextlanes:view", view); };
  }, [layout, active, lane.id]);
  const render = (node: PaneLayout, path = "root"): ReactNode => "id" in node ? <section className={`lane-pane${node.id === active ? " active" : ""}`} data-pane={node.id} data-pane-kind={node.kind} key={node.id} onPointerDown={() => setActive(node.id)} onFocusCapture={() => setActive(node.id)}>
    <header className="pane-bar"><label className="sr-only" htmlFor={`view-${node.id}`}>Pane view</label><select id={`view-${node.id}`} aria-label="Pane view" className="sel" value={node.kind} onChange={e => choose(node.id, e.target.value as PaneKind)}>{PANE_KINDS.map(kind => <option key={kind} value={kind} disabled={kind !== "terminal" && leaves.some(p => p.id !== node.id && p.kind === kind)}>{kind[0]!.toUpperCase() + kind.slice(1)}</option>)}</select>{node.kind === "steps" ? <FilterSwitch value={filter} change={setFilter} /> : null}{leaves.length > 1 ? <button className="lnk" aria-label="Close pane" onClick={() => { const next = replacePane(layout, node.id, null)!; setLayout(next); setActive(paneLeaves(next)[0]!.id); }}>×</button> : null}</header>
    <div className="pane-content">{node.kind === "terminal" ? <Suspense fallback={<Empty>Opening terminal…</Empty>}><Terminal lane={lane.id} compact autoFocus={node.id === active} /></Suspense> : node.kind === "diff" ? <WorkDiff lane={lane.id} version={events.filter(e => e.type === "tool.update").length} /> : node.kind === "preview" ? preview ? <iframe title="Lane preview" src={preview} sandbox="allow-scripts allow-forms allow-same-origin allow-popups" /> : <Empty action={<Link className="lnk" to={`/p/${lane.project}/run`}>Open Run</Link>}>Start the app to preview it</Empty> : <Steps lane={lane} events={events} waiting={waiting} reload={reload} agent={agent} filter={node.kind === "progress" ? "progress" : filter} />}</div>
  </section> : <div className={`pane-split ${node.direction}`} key={path}>{render(node.first, `${path}-a`)}{render(node.second, `${path}-b`)}</div>;
  const usage = events.findLast(e => e.type === "usage");
  const context = usage?.type === "usage" && usage.payload.contextSize > 0 ? Math.round(100 * usage.payload.contextUsed / usage.payload.contextSize) : null;
  return <section className="sec lane-panes" aria-label="Lane view" onKeyDown={e => { if (e.key === "Escape" && !typingTarget(e.target) && !document.querySelector("dialog[open]") && selected.kind !== "terminal") { e.preventDefault(); interrupt(); } }}>
    <div className="pane-tools"><div className="vt" role="tablist" aria-label="Lane view">{PANE_KINDS.map(kind => <button key={kind} role="tab" aria-selected={selected.kind === kind} className={selected.kind === kind ? "on" : ""} onClick={() => { const existing = kind !== "terminal" ? leaves.find(p => p.kind === kind) : null; if (existing) setActive(existing.id); else choose(selected.id, kind); }}>{kind[0]!.toUpperCase() + kind.slice(1)}</button>)}</div><button className="btn ghost sm" onClick={() => split("row")}>Split right <span className="kbd2">⌘D</span></button><button className="btn ghost sm" onClick={() => split("column")}>Split down <span className="kbd2">⌘⇧D</span></button>{notice ? <span role="status">{notice}</span> : null}</div>
    {render(layout)}
    <div className="tmux-status"><LaneBadge id={lane.id} colour={lane.colour} /><b>{agent}</b><StateGlyph state={lane.state} idle={isIdle(lane, events)} label />{context !== null ? <span>ctx {context}%</span> : null}{waiting[0] ? <span className="status-question" title={waiting[0].title}><Glyph g="wait">{waiting[0].title}</Glyph></span> : null}</div>
  </section>;
}
