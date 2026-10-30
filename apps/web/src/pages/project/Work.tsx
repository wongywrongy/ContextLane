import { useCallback, useMemo, useState } from "react";
import { useParams } from "react-router";
import type { Lane, LaneEvent } from "@contextlanes/protocol";
import { useJson, useProjectStream } from "../../api";
import { AgentMark, Empty, LaneBadge, Section, StateGlyph } from "../../components/ui";

/** Run and steer lanes: lane list, then one lane (steps or terminal), then its details. */
export function WorkPage() {
  const { project = "" } = useParams();
  const [lanes] = useJson<Lane[]>(`/api/projects/${project}/lanes`);
  const [selected, setSelected] = useState<string | null>(null);
  const lane = useMemo(() => lanes?.find((l) => l.id === selected) ?? lanes?.[0] ?? null, [lanes, selected]);

  return (
    <div className="work">
      <aside className="pane l" aria-label="Lanes">
        <div className="ps">
          <div className="ph" style={{ minHeight: 0, marginBottom: 10 }}>
            <span className="lbl">Lanes · {lanes?.length ?? 0}</span>
          </div>
          {lanes?.map((l) => (
            <button key={l.id} className={`lrow ${l.state}${l.id === lane?.id ? " active" : ""}`} onClick={() => setSelected(l.id)}>
              <span className="rail" style={{ background: `var(--${l.colour})` }} />
              <AgentMark agent={l.agent} />
              <span style={{ flex: 1, minWidth: 0 }}>
                <b style={{ fontSize: 14 }}>{l.task}</b>
              </span>
              <StateGlyph state={l.state} />
            </button>
          ))}
          {lanes && lanes.length === 0 ? <Empty>No lanes yet. Start one with contextlanes lane start.</Empty> : null}
        </div>
      </aside>
      <main className="page">{lane ? <LaneView lane={lane} /> : <Empty>Select a lane.</Empty>}</main>
      <aside className="pane r" aria-label="Lane details">
        <div className="ps"><span className="lbl">Plan</span></div>
        <div className="ps"><span className="lbl">Context</span></div>
        <div className="ps"><span className="lbl">Environment</span></div>
      </aside>
    </div>
  );
}

function LaneView({ lane }: { lane: Lane }) {
  const [project, n] = lane.id.split("/");
  const [initial] = useJson<LaneEvent[]>(`/api/lanes/${project}/${n}/events`);
  const [live, setLive] = useState<LaneEvent[]>([]);
  const [view, setView] = useState<"steps" | "terminal">("steps");
  const onEvent = useCallback((e: LaneEvent) => e.lane === lane.id && setLive((xs) => [...xs, e]), [lane.id]);
  useProjectStream(project!, onEvent);
  const events = [...(initial ?? []), ...live.filter((e) => !initial?.some((i) => i.seq === e.seq))];

  return (
    <>
      <div className="ph">
        <LaneBadge id={lane.id} colour={lane.colour} />
        <AgentMark agent={lane.agent} />
        <h2>{lane.task}</h2>
        <StateGlyph state={lane.state} label />
        <div className="e"><span className="mono muted" style={{ fontSize: 12 }}>{lane.branch}</span></div>
      </div>
      <Section
        title={
          <span className="vt" role="tablist">
            <button className={view === "steps" ? "active" : ""} onClick={() => setView("steps")}>Steps</button>
            <button className={view === "terminal" ? "active" : ""} onClick={() => setView("terminal")}>Terminal</button>
          </span>
        }
        meta={view === "terminal" ? `tmux · ${lane.terminal}` : `${events.length} events`}
      >
        {view === "steps" ? (
          events.length ? (
            events.map((e) => (
              <div className="step" key={e.seq}>
                <span className="t">{e.at.slice(11, 16)}</span>
                <span><b>{e.type}</b> <span className="muted">{summary(e)}</span></span>
              </div>
            ))
          ) : (
            <Empty>No steps yet.</Empty>
          )
        ) : (
          <div className="tty">{`xterm.js attaches to tmux session ${lane.terminal} here (phase 1).\nSame session from any terminal: contextlanes term ${lane.id}`}</div>
        )}
      </Section>
    </>
  );
}

function summary(e: LaneEvent): string {
  switch (e.type) {
    case "lane.state":
      return `${e.payload.from} → ${e.payload.to}${e.payload.reason ? ` (${e.payload.reason})` : ""}`;
    case "lane.created":
      return `${e.payload.agent} on ${e.payload.branch}`;
    case "tool.call":
      return e.payload.title;
    case "agent.thought":
    case "agent.message":
      return e.payload.text.slice(0, 140);
    case "permission.requested":
      return e.payload.title;
    default:
      return "";
  }
}
