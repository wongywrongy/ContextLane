import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useParams, useSearchParams } from "react-router";
import type { Lane, LaneEvent } from "@contextlanes/protocol";
import { postJson, useInbox } from "../../api";
import { AgentMark, Empty, LaneBadge, Section, StateGlyph } from "../../components/ui";
import { useHistory, useWork } from "../../work/useWork";
import { Steps } from "../../work/Steps";
import { Composer } from "../../work/Composer";
import { Inspector } from "../../work/Inspector";

const Terminal = lazy(() => import("../../components/Terminal").then((module) => ({ default: module.Terminal })));
const Overview = lazy(() => import("../../work/Overview").then((module) => ({ default: module.Overview })));

export function WorkPage() {
  const { project = "" } = useParams();
  const [params, setParams] = useSearchParams();
  const work = useWork(project);
  const selected = params.get("lane");
  const lane = work.lanes.find((l) => l.id === selected) ?? null;
  const history = useHistory(lane?.id ?? "", work.events, work.version);
  const choose = useCallback((id: string | null) => setParams(id ? { lane: id } : {}), [setParams]);
  return <div className={`work${lane ? " selected" : " overview"}`}>
    <aside className="pane l" aria-label="Lanes"><Section title="Lanes" meta={String(work.lanes.length)}>
      <div className="lane-navigation"><button className={`lrow${!lane ? " active" : ""}`} onClick={() => choose(null)}>Overview <span className="muted">All lanes</span></button>
        {work.lanes.map((l) => <button key={l.id} className={`lrow ${l.state}${l.id === lane?.id ? " active" : ""}`} onClick={() => choose(l.id)}>
          <span className="lane-list-main"><LaneBadge id={l.id} colour={l.colour} /><AgentMark agent={l.agent} /><strong>{l.task}</strong></span><StateGlyph state={l.state} label />
        </button>)}
        {!work.lanes.length ? <Empty>Start a lane to give it its own agent and checkout.</Empty> : null}
      </div>
    </Section></aside>
    <main className="page">
      {work.error ? <p role="alert">{work.error.message} <button className="btn ghost" onClick={work.reload}>Try again</button></p> : null}
      {lane ? <LaneView key={lane.id} lane={lane} events={history.events} error={history.error} reload={work.reload} /> : <><div className="ph"><h2>Work overview</h2><span className="m">One goal, several lanes</span></div><Suspense fallback={<Empty>Opening the overview…</Empty>}><Overview lanes={work.lanes} events={work.events} select={choose} /></Suspense></>}
    </main>
    {lane ? <aside className="pane r" aria-label="Lane details"><Inspector key={lane.id} lane={lane} events={history.events} /></aside> : null}
  </div>;
}

function LaneView({ lane, events, error, reload }: { lane: Lane; events: LaneEvent[]; error: string; reload: () => void }) {
  const [waiting, , reloadInbox] = useInbox();
  const [view, setView] = useState<"steps" | "terminal">("steps");
  const [notice, setNotice] = useState("");
  const interrupt = useCallback(() => {
    void postJson(`/api/lanes/${lane.id}/cancel`, {}).then(() => setNotice("Interruption requested."), (err: Error) => setNotice(err.message));
  }, [lane.id]);
  useEffect(() => {
    if (view !== "steps") return;
    const key = (event: KeyboardEvent) => { if (event.key === "Escape" && !event.isComposing && !event.defaultPrevented) { event.preventDefault(); interrupt(); } };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, [view, interrupt]);
  const turn = events.findLast((e) => e.type === "agent.turn");
  const active = turn?.type === "agent.turn" && turn.payload.active;
  const laneWaiting = useMemo(() => waiting?.filter((item) => item.lane === lane.id) ?? [], [waiting, lane.id]);
  return <>
    <div className="ph lane-header"><LaneBadge id={lane.id} colour={lane.colour} /><AgentMark agent={lane.agent} /><h2>{lane.task}</h2><StateGlyph state={lane.state} label /><span className="m">{lane.state === "working" ? active ? "Agent working" : "Ready for your next message" : ""}</span></div>
    {notice ? <p role="status">{notice}</p> : null}
    <Section title={<span className="vt" role="group" aria-label="Lane view"><button className={view === "steps" ? "active" : ""} aria-pressed={view === "steps"} onClick={() => setView("steps")}>Steps</button><button className={view === "terminal" ? "active" : ""} aria-pressed={view === "terminal"} onClick={() => setView("terminal")}>Terminal</button></span>} meta={view === "terminal" ? `tmux · ${lane.terminal}` : "Live step trail"}>
      {error ? <p className="sec-b" role="alert">{error} <button className="btn ghost" onClick={reload}>Try again</button></p> : null}
      {view === "terminal" ? <Suspense fallback={<Empty>Opening your terminal…</Empty>}><Terminal lane={lane.id} /></Suspense> : <Steps events={events} waiting={laneWaiting} reload={reloadInbox} />}
    </Section>
    {view === "steps" ? <Composer lane={lane.id} events={events} interrupt={interrupt} /> : null}
  </>;
}
