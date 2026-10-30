import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router";
import { sharing } from "./Review";
import type { InboxItem, Lane, LaneEvent, OutsideAgent, Project } from "@contextlanes/protocol";
import { errorMessage, postJson, useInbox, useJson } from "../../api";
import { useProjectWork } from "../../components/Shell";
import { NewLaneDialog } from "../../components/NewLane";
import { AGENT_NAMES, AgentMark, Empty, GLYPH, Glyph, LaneBadge, StateGlyph, Tile, ago, agoText } from "../../components/ui";
import { useHistory } from "../../work/useWork";
import { isIdle, stepsFor } from "../../work/model";
import { FilterSwitch, Steps, type Filter } from "../../work/Steps";
import { Composer } from "../../work/Composer";
import { Inspector } from "../../work/Inspector";

const Terminal = lazy(() => import("../../components/Terminal").then((module) => ({ default: module.Terminal })));
const Overview = lazy(() => import("../../work/Overview").then((module) => ({ default: module.Overview })));

/** Work: lane list on the left; the Overview or one lane in the middle; that lane's inspector on the right. */
export function WorkPage() {
  const { project = "" } = useParams();
  const work = useProjectWork();
  const [projects] = useJson<Project[]>("/api/projects");
  const [inbox] = useInbox();
  const [params, setParams] = useSearchParams();
  const [creating, setCreating] = useState(params.get("new") === "1");
  const lane = work.lanes.find((l) => l.id === params.get("lane")) ?? null;
  const history = useHistory(lane?.id ?? "", work.events, work.version);
  const [view, setView] = useState<"steps" | "terminal">("steps");
  useEffect(() => setView("steps"), [lane?.id]);
  const choose = useCallback((id: string | null) => setParams(id ? { lane: id } : {}), [setParams]);
  const closeNew = () => { setCreating(false); if (params.has("new")) setParams(lane ? { lane: lane.id } : {}); };
  return <div className={`wk3${lane ? " has-lane" : " overview"}`}>
    <LaneList lanes={work.lanes} events={work.events} inbox={inbox ?? []} selected={lane?.id ?? null} choose={choose} create={() => setCreating(true)} />
    <main className="lane-main" aria-label={lane ? "Lane" : "Overview"}>
      {work.error ? <p role="alert">{work.error.message} <button className="btn ghost sm" onClick={work.reload}>Try again</button></p> : null}
      {lane ? <LaneView key={lane.id} projectName={projects?.find((p) => p.id === project)?.name ?? project} lane={lane} events={history.events} error={history.error} reload={work.reload} view={view} setView={setView} />
        : <>
          <div className="ph"><h2>Overview</h2><span className="m">every lane as a graph · click a lane to open it</span></div>
          {work.lanes.length ? <Suspense fallback={<Empty>Opening the overview…</Empty>}><Overview lanes={work.lanes} events={work.events} select={choose} /></Suspense>
            : <section className="sec"><div className="empty">No lanes yet. A lane is one task with its own branch, checkout, shell and agent. <button className="lnk" onClick={() => setCreating(true)}>Start the first one</button>.</div></section>}
        </>}
    </main>
    {lane ? <Inspector key={lane.id} lane={lane} events={history.events} openTerminal={() => setView("terminal")} /> : null}
    {creating && projects ? <NewLaneDialog projects={projects} project={project} task={params.get("task") ?? undefined} onClose={closeNew} /> : null}
  </div>;
}

/** What a lane is doing, in a few words, for the lane list. */
function laneNow(lane: Lane, events: LaneEvent[], waiting: InboxItem[]): string {
  const asked = waiting.find((i) => i.lane === lane.id);
  if (asked) return asked.kind === "question" ? `Asked: ${asked.title}` : `Wants: ${asked.title}`;
  const mine = events.filter((e) => e.lane === lane.id);
  if (lane.state === "failed") {
    const error = mine.findLast((e) => e.type === "agent.error");
    return error?.type === "agent.error" ? error.payload.message : "Could not start. Open it to see why.";
  }
  if (isIdle(lane, events)) return "Idle · waiting for your message";
  const last = stepsFor(mine).findLast((s) => s.type !== "text" || s.family !== "you");
  if (lane.state === "working" && last) return last.type === "text" ? "Writing a reply" : last.title;
  return lane.state === "working" ? "Starting the agent" : GLYPH[lane.state][1];
}

function LaneList({ lanes, events, inbox, selected, choose, create }: { lanes: Lane[]; events: LaneEvent[]; inbox: InboxItem[]; selected: string | null; choose: (id: string | null) => void; create: () => void }) {
  const groups = useMemo(() => {
    const byGoal = new Map<string | null, Lane[]>();
    for (const lane of lanes) byGoal.set(lane.goal, [...(byGoal.get(lane.goal) ?? []), lane]);
    return [...byGoal].sort(([a], [b]) => (a === null ? 1 : 0) - (b === null ? 1 : 0));
  }, [lanes]);
  const hasGoals = groups.some(([goal]) => goal !== null);
  const archived = lanes.filter((l) => l.state === "archived").length;
  const [showArchived, setShowArchived] = useState(false);
  return <aside className="pane l" aria-label="Lanes">
    <div className="ps">
      <div className="ps-h" style={{ marginBottom: 10 }}><span className="lbl">Lanes · {lanes.length}</span><div className="e"><button className="btn sm" onClick={create}>New lane</button></div></div>
      <div className="lanes-scroll">
        <button className={`ovr${selected ? "" : " on"}`} onClick={() => choose(null)}><Tile family="team" icon="subagent" small /><span><b style={{ fontSize: 14 }}>Overview</b><span className="muted" style={{ display: "block", fontSize: 12.5, marginTop: 1 }}>every lane as a graph</span></span><span className="mono muted" style={{ marginLeft: "auto", fontSize: 12 }}>{lanes.length}</span></button>
        {groups.map(([goal, group]) => <div key={goal ?? ""} style={{ display: "contents" }}>
          {hasGoals ? <div className="grp">{goal ? <><i className="g work" aria-hidden="true" />Goal · {goal}</> : "No goal"}</div> : null}
          {group.filter((l) => showArchived || l.state !== "archived" || l.id === selected).map((l) => {
            const [g] = GLYPH[l.state];
            return <button key={l.id} className={`lrow ${l.colour}${g === "wait" ? " needs" : ""}${l.id === selected ? " on" : ""}`} onClick={() => choose(l.id)} aria-current={l.id === selected ? "true" : undefined}>
              <span className="rail" /><AgentMark agent={l.agent} small />
              <span className="body"><span className="ttl"><b>{l.task}</b><StateGlyph state={l.state} idle={isIdle(l, events)} /></span><span className="now">{laneNow(l, events, inbox)}</span></span>
            </button>;
          })}
        </div>)}
      </div>
      {archived ? <button className="lnk" style={{ fontSize: 13, marginTop: 10 }} aria-pressed={showArchived} onClick={() => setShowArchived((v) => !v)}>{showArchived ? "Hide" : "Show"} {archived} archived</button> : null}
    </div>
    <Watching project={lanes[0]?.project ?? null} choose={choose} />
  </aside>;
}

/** "Watching only": Claude Code or Codex sessions in this project that no lane started. Never stopped from here. */
function Watching({ project: fromLanes, choose }: { project: string | null; choose: (id: string | null) => void }) {
  const params = useParams();
  const project = params.project ?? fromLanes;
  const [data, , reload] = useJson<{ agents: OutsideAgent[] }>(project ? `/api/projects/${project}/outside-agents` : null);
  const [message, setMessage] = useState("");
  useEffect(() => { const t = setInterval(reload, 15_000); return () => clearInterval(t); }, [reload]);
  const agents = data?.agents ?? [];
  if (!agents.length) return null;
  const take = (a: OutsideAgent) => { setMessage(""); void postJson<Lane>(`/api/projects/${project}/takeover`, { pid: a.pid, startedAt: a.startedAt }).then((lane) => { reload(); choose(lane.id); }, (err: Error) => setMessage(err.message)); };
  return <div className="ps">
    <div className="ps-h" style={{ marginBottom: 8 }}><span className="lbl">Watching only</span></div>
    {agents.map((a) => <div key={`${a.pid}${a.startedAt}`} style={{ display: "grid", gap: 6, marginBottom: 10 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}><AgentMark agent={a.agent} small /><span style={{ fontSize: 14 }}>Terminal session</span><span className="mono muted" style={{ marginLeft: "auto", fontSize: 12 }}>pid {a.pid}</span></div>
      <span className="muted" style={{ fontSize: 12.5 }}>{a.running ? "Started outside ContextLanes. Close it there, then take it over to talk to it here." : `Ended ${agoText(a.endedAt!)}. Take it over to continue in a lane.`}</span>
      <span className="mono muted" style={{ fontSize: 11.5, overflowWrap: "anywhere" }}>{a.cwd}</span>
      <div><button className="btn sm ghost" disabled={a.running} title={a.running ? "Close it first" : undefined} onClick={() => take(a)}>{a.running ? "Close it first" : "Take over"}</button></div>
    </div>)}
    {message ? <p role="alert" style={{ margin: 0, fontSize: 13 }}>{message}</p> : null}
  </div>;
}

function LaneView({ projectName, lane, events, error, reload, view, setView }: { projectName: string; lane: Lane; events: LaneEvent[]; error: string; reload: () => void; view: "steps" | "terminal"; setView: (v: "steps" | "terminal") => void }) {
  const [waiting, , reloadInbox] = useInbox();
  const [notice, setNotice] = useState("");
  const [renaming, setRenaming] = useState(false);
  const [filter, setFilter] = useState<Filter>("all");
  const interrupt = useCallback(() => {
    void postJson(`/api/lanes/${lane.id}/cancel`, {}).then(() => setNotice("Interrupt sent. The agent stops after its current action."), (err: Error) => setNotice(err.message));
  }, [lane.id]);
  useEffect(() => {
    if (view !== "steps") return;
    const key = (event: KeyboardEvent) => { if (event.key === "Escape" && !event.isComposing && !event.defaultPrevented && !document.querySelector("dialog[open]")) { event.preventDefault(); interrupt(); } };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, [view, interrupt]);
  const laneWaiting = useMemo(() => waiting?.filter((item) => item.lane === lane.id) ?? [], [waiting, lane.id]);
  const session = events.findLast((e) => e.type === "agent.session");
  const control = async (kind: "mode" | "model", value: string) => {
    try { await postJson(`/api/lanes/${lane.id}/${kind}`, { [kind]: value }); setNotice(`${kind === "mode" ? "Mode" : "Model"} change sent. The agent confirms it in the steps.`); }
    catch (err) { setNotice(err instanceof Error ? err.message : "The agent setting could not be changed."); }
  };
  const steps = stepsFor(events);
  const first = events[0];
  const agent = AGENT_NAMES[lane.agent] ?? lane.agent;
  return <>
    {/* Phone only (phone-lane.webp): the lane fills the screen, with a way back to the project. */}
    <Link className="back" to={`/p/${lane.project}/work`}>‹ {projectName}</Link>
    <div className="ph">
      <LaneBadge id={lane.id} colour={lane.colour} large /><AgentMark agent={lane.agent} />
      {renaming ? <form style={{ display: "flex", gap: 8, flex: "1 1 320px" }} onSubmit={(e) => { e.preventDefault(); const task = String(new FormData(e.currentTarget).get("task") ?? "").trim(); void postJson(`/api/lanes/${lane.id}`, { task }, "PATCH").then(() => { setRenaming(false); reload(); }, (err) => setNotice(errorMessage(err))); }}>
          <input className="in" name="task" defaultValue={lane.task} maxLength={300} required autoFocus aria-label="Lane title" style={{ flex: 1, minHeight: 36 }} /><button className="btn sm">Save</button><button type="button" className="btn ghost sm" onClick={() => setRenaming(false)}>Cancel</button></form>
        : <><h2>{lane.task}</h2><button className="lnk" style={{ fontSize: 13 }} onClick={() => setRenaming(true)}>Rename</button></>}
      <StateGlyph state={lane.state} idle={isIdle(lane, events)} label />
      {sharing(events, lane.id).map((c) => <Link key={c.module} className="lnk" style={{ fontSize: 13 }} to={`/p/${lane.project}/architecture`}><Glyph g="wait">Also changed by {c.others.map((o) => o.slice(o.lastIndexOf("/") + 1)).join(" and ")}: {c.module}</Glyph></Link>)}
      <div className="e"><span className="mono muted" style={{ fontSize: 12 }}>{lane.branch} · {ago(lane.createdAt)}</span></div>
    </div>

    {lane.state === "failed" ? <FailedNote events={events} /> : null}

    <section className="sec" aria-label="Agent controls"><div className="sec-r" style={{ gap: 10, flexWrap: "wrap" }}>
      {session?.type === "agent.session" && session.payload.models.length
        ? <select className="sel" aria-label="Model" value={session.payload.currentModel ?? ""} onChange={(e) => void control("model", e.target.value)}>{session.payload.models.map((m) => <option value={m.id} key={m.id}>{m.label}</option>)}</select>
        : <span className="sel" style={{ display: "inline-flex", alignItems: "center", cursor: "default" }}>{lane.model ?? `${agent} default`}</span>}
      {session?.type === "agent.session" && session.payload.modes.length
        ? <div className="seg" role="group" aria-label="Permission mode">{session.payload.modes.map((m) => <button key={m.id} className={session.payload.currentMode === m.id ? "on" : ""} aria-pressed={session.payload.currentMode === m.id} onClick={() => void control("mode", m.id)}>{m.label}</button>)}</div>
        : <span className="muted" style={{ fontSize: 13 }}>Modes appear when the agent connects</span>}
      <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}><button className="btn ghost sm" onClick={interrupt}><span className="kbd2">Esc</span>Interrupt</button></div>
    </div>{notice ? <div className="sec-f" role="status" style={{ minHeight: 40, fontSize: 13 }}>{notice}</div> : null}</section>

    <section className="sec" aria-label="Lane view">
      <div className="sec-h">
        <div className="vt" role="tablist" aria-label="Lane view">
          <button role="tab" aria-selected={view === "steps"} className={view === "steps" ? "on" : ""} onClick={() => setView("steps")}>Steps <i>{steps.length}</i></button>
          <button role="tab" aria-selected={view === "terminal"} className={view === "terminal" ? "on" : ""} onClick={() => setView("terminal")}>Terminal <span className="live" title="Running" /></button>
        </div>
        {view === "steps" ? <><span className="m">{first ? `since ${new Date(first.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hourCycle: "h23" })}` : ""}</span><div className="e"><FilterSwitch value={filter} change={setFilter} /></div></>
          : <span className="m">tmux · {lane.terminal} · your shell in this lane</span>}
      </div>
      {error ? <p className="sec-b" role="alert">{error} <button className="btn ghost sm" onClick={reload}>Try again</button></p> : null}
      {view === "terminal"
        ? <><Suspense fallback={<Empty>Opening your terminal…</Empty>}><Terminal lane={lane.id} /></Suspense>
          <div className="sec-f"><Glyph g="done"><span style={{ fontWeight: 500, color: "var(--text)" }}>Your shell, not the agent’s · keeps running when you close this tab</span></Glyph><span className="muted" style={{ marginLeft: "auto", fontSize: 13 }}>same session from any terminal</span><span className="mono" style={{ fontSize: 12.5, background: "#F1ECE3", padding: "3px 8px", borderRadius: 5 }}>contextlanes term {lane.id}</span></div></>
        : <Steps events={events} waiting={laneWaiting} reload={reloadInbox} agent={agent} filter={filter} />}
    </section>

    {view === "steps" ? <Composer lane={lane} events={events} agent={agent} /> : null}
  </>;
}

/** Why a lane failed, from its last state change, in the words the setup step reported. */
function FailedNote({ events }: { events: LaneEvent[] }) {
  const change = events.findLast((e) => e.type === "lane.state" && e.payload.to === "failed");
  const error = events.findLast((e) => e.type === "agent.error");
  const reason = change?.type === "lane.state" && change.payload.reason ? change.payload.reason : error?.type === "agent.error" ? error.payload.message : "No reason was recorded.";
  return <section className="sec" style={{ borderColor: "#F0C7BD" }} aria-label="Why this lane failed">
    <div className="sec-h"><Glyph g="fail">This lane stopped</Glyph></div>
    <div className="sec-b"><div className="out" style={{ marginTop: 0 }}>{reason.trim()}</div><p style={{ margin: "10px 0 0", fontSize: 13.5 }} className="muted">Fix the cause, then start a new lane with the same task. The branch and checkout are kept.</p></div>
  </section>;
}
