import { useEffect, useMemo, useState } from "react";
import { ReactFlow, Controls, MarkerType, Position, type Node, type Edge } from "@xyflow/react";
import ELK from "elkjs/lib/elk.bundled.js";
import type { Lane, LaneEvent } from "@contextlanes/protocol";
import { AgentMark, Empty, LaneBadge, Section, StateGlyph } from "../components/ui";
import { isIdle, timeline } from "./model";
import "@xyflow/react/dist/style.css";

const elk = new ELK();
export function Overview({ lanes, events, select }: { lanes: Lane[]; events: LaneEvent[]; select: (id: string) => void }) {
  const [positions, setPositions] = useState<Map<string, { x: number; y: number }>>(new Map());
  const [layoutError, setLayoutError] = useState("");
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 30_000); return () => clearInterval(timer); }, []);
  const idle = lanes.map((l) => isIdle(l, events) ? "1" : "0").join("");
  const structure = useMemo(() => {
    const nodes: Node[] = [];
    const edges: Edge[] = [];
    // Goal cards only when the owner set goals; lanes without one stand alone (no invented "goal").
    const goals = lanes.some((l) => l.goal) ? new Set(lanes.map((l) => l.goal ?? "No goal")) : new Set<string>();
    for (const goal of goals) {
      nodes.push({ id: `goal:${goal}`, position: { x: 0, y: 0 }, data: { label: <div className="goal-node"><span>Goal</span><strong>{goal}</strong></div> }, className: "goal-node-box", sourcePosition: Position.Right, style: { width: 240, height: 90 } });
    }
    for (const lane of lanes) {
      nodes.push({ id: lane.id, position: { x: 0, y: 0 }, data: { label: <div className="lane-node"><div><LaneBadge id={lane.id} colour={lane.colour} /><AgentMark agent={lane.agent} /></div><strong>{lane.task}</strong><StateGlyph state={lane.state} idle={isIdle(lane, events)} label /></div> }, className: `lane-node-box ${lane.colour}`, sourcePosition: Position.Right, targetPosition: Position.Left, style: { width: 260, height: 128 } });
      if (goals.size) edges.push({ id: `goal:${lane.id}`, source: `goal:${lane.goal ?? "No goal"}`, target: lane.id, markerEnd: { type: MarkerType.ArrowClosed }, style: { stroke: "#9C958A" } });
      if (["needs_you", "in_review"].includes(lane.state)) {
        nodes.push({ id: `gate:${lane.id}`, position: { x: 0, y: 0 }, data: { label: <div className="gate-node"><StateGlyph state={lane.state} label /><span>{lane.state === "in_review" ? "Your review" : "Your answer"}</span></div> }, className: "gate-node-box", targetPosition: Position.Left, style: { width: 170, height: 80 } });
        edges.push({ id: `gate-edge:${lane.id}`, source: lane.id, target: `gate:${lane.id}`, style: { stroke: "#A66400", strokeDasharray: "6 4" } });
      }
    }
    return { nodes, edges };
    // Laid out again only when a lane's state or idleness changes, not on every streamed event.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lanes, idle]);
  useEffect(() => {
    let live = true;
    void elk.layout({ id: "overview", layoutOptions: { "elk.algorithm": "layered", "elk.direction": "RIGHT", "elk.spacing.nodeNode": "28", "elk.layered.spacing.nodeNodeBetweenLayers": "65" },
      children: structure.nodes.map((n) => ({ id: n.id, width: Number(n.style!.width), height: Number(n.style!.height) })),
      edges: structure.edges.map((e) => ({ id: e.id, sources: [e.source], targets: [e.target] })) }).then((graph) => {
        if (live) { setPositions(new Map(graph.children?.map((n) => [n.id, { x: n.x ?? 0, y: n.y ?? 0 }]))); setLayoutError(""); }
      }, () => { if (live) setLayoutError("The graph could not be laid out. Open a lane from the list below."); });
    return () => { live = false; };
  }, [structure]);
  const start = now - 2 * 60 * 60_000;
  return <>
    <Section title="Goals and lanes" meta={`${lanes.length} lanes · choose one to steer it`}>
      {!lanes.length ? <Empty>No lanes yet</Empty> : <>
        {layoutError ? <p className="sec-b" role="alert">{layoutError}</p> : <div className="overview-graph" aria-label="Goals, lanes and owner gates">
          {positions.size ? <ReactFlow nodes={structure.nodes.map((n) => ({ ...n, position: positions.get(n.id) ?? n.position }))} edges={structure.edges} fitView fitViewOptions={{ maxZoom: 1 }} proOptions={{ hideAttribution: true }} nodesDraggable={false} nodesConnectable={false} elementsSelectable={false} onNodeClick={(_event, node) => { if (lanes.some((l) => l.id === node.id)) select(node.id); else if (node.id.startsWith("gate:")) select(node.id.slice(5)); }} minZoom={0.25} maxZoom={1.5}>
            <Controls showInteractive={false} />
          </ReactFlow> : <Empty>Arranging the lanes…</Empty>}
        </div>}
        {lanes.some((l) => l.goal) || lanes.some((l) => ["needs_you", "in_review"].includes(l.state)) ? <div className="sec-f graph-legend">{[lanes.some((l) => l.goal) ? "Arrow: goal → lane" : "", lanes.some((l) => ["needs_you", "in_review"].includes(l.state)) ? "dashed amber box: waits on you" : ""].filter(Boolean).join(" · ")}</div> : null}
      </>}
    </Section>
    <Section title="Last two hours" meta={`${new Date(start).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} — ${new Date(now).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`}>
      {lanes.map((lane) => <button className="timeline-row" key={lane.id} onClick={() => select(lane.id)}>
        <span className="timeline-label"><LaneBadge id={lane.id} colour={lane.colour} /><span>{lane.task}</span></span>
        <span className="timeline-track" aria-label={`Recorded activity for ${lane.task}`}>
          {timeline(lane, events, start, now).map((segment, i) => <span key={i} className={`activity-bar ${segment.state}`} style={{ left: `${(segment.from - start) / (now - start) * 100}%`, width: `${(segment.to - segment.from) / (now - start) * 100}%` }} title={`${segment.state.replaceAll("_", " ")} · ${new Date(segment.from).toLocaleTimeString()} to ${new Date(segment.to).toLocaleTimeString()}`} />)}
        </span><StateGlyph state={lane.state} idle={isIdle(lane, events)} label />
      </button>)}
      {!lanes.length ? <Empty>No activity yet</Empty> : null}
      <div className="sec-f graph-legend">Solid: working · stripes: waiting on you · red: failed · pale: idle or paused.</div>
    </Section>
  </>;
}
