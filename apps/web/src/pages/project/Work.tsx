import { clsx } from "clsx";
import { LanePanes } from "../../work/LanePanes";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router";
import { sharing } from "./Review";
import type { AgentLink, InboxItem, Lane, LaneEvent, OutsideAgent, Project } from "@contextlanes/protocol";
import { errorMessage, postJson, useInbox, useJson } from "../../api";
import { useFeatures } from "../../features";
import { useProjectWork } from "../../components/Shell";
import { startLaneCommand } from "../../components/StartLane";
import { AGENT_NAMES, AgentMark, Cmd, GLYPH, Glyph, Help, LaneBadge, StateGlyph, Tile, ago, agoText } from "../../components/ui";
import { DIRE_ACTIONS } from "@contextlanes/protocol";
import { useHistory } from "../../work/useWork";
import { isIdle, laneNow } from "../../work/model";
import { Inspector } from "../../work/Inspector";

import { Overview } from "../../work/Overview";

/** "3 lanes · 2 waiting on you · 1 goal": the overview's header, counted. */
function overviewMeta(lanes: Lane[], waiting: InboxItem[]): string {
  const need = new Set(waiting.map((i) => i.lane).filter((id) => lanes.some((l) => l.id === id))).size;
  const goals = new Set(lanes.flatMap((l) => l.goal ? [l.goal] : [])).size;
  return [`${lanes.length} ${lanes.length === 1 ? "lane" : "lanes"}`, need ? `${need} waiting on you` : "", goals ? `${goals} ${goals === 1 ? "goal" : "goals"}` : ""].filter(Boolean).join(" · ");
}

/** Work: lane list on the left; the Overview or one lane in the middle; that lane's inspector on the right. */
export function WorkPage() {
  const { project = "" } = useParams();
  const work = useProjectWork();
  const [projects] = useJson<Project[]>("/api/projects");
  const [inbox] = useInbox();
  const [params, setParams] = useSearchParams();
  const lane = work.lanes.find((l) => l.id === params.get("lane")) ?? null;
  const history = useHistory(lane?.id ?? "", work.events, work.version);
  const choose = useCallback((id: string | null) => setParams(id ? { lane: id } : {}), [setParams]);
  // Archived lanes are hidden from the list until asked for; the overview follows the list.
  const open = useMemo(() => work.lanes.filter((l) => l.state !== "archived"), [work.lanes]);
  const start = startLaneCommand(project);
  return <div className={clsx("wk3", lane ? "has-lane" : "overview")}>
    <LaneList lanes={work.lanes} events={work.events} inbox={inbox ?? []} selected={lane?.id ?? null} choose={choose} />
    <main className="lane-main" aria-label={lane ? "Lane" : "Overview"}>
      {work.error ? <p role="alert">{work.error.message} <button className="btn ghost sm" onClick={work.reload}>Try again</button></p> : null}
      {lane ? <LaneView key={lane.id} projectName={projects?.find((p) => p.id === project)?.name ?? project} lane={lane} events={history.events} error={history.error} reload={work.reload} />
        : <>
          <div className="ph"><h2>Board</h2><span className="m">{overviewMeta(open, inbox ?? [])}</span><div className="e"><Cmd note="new lane">{start}</Cmd></div></div>
          {open.length ? <Overview lanes={open} events={work.events} waiting={inbox ?? []} select={choose} />
            : <section className="sec"><div className="empty">{work.lanes.length ? "No open lanes; archived ones are in the list." : "No lanes yet."} A lane is one task with its own branch, checkout, shell and agent. Start one from the machine, or have an agent start it:<div style={{ marginTop: 10 }}><Cmd>{start}</Cmd></div></div></section>}
        </>}
    </main>
    {lane ? <Inspector key={lane.id} lane={lane} events={history.events} openTerminal={() => document.dispatchEvent(new CustomEvent("contextlanes:view", { detail: { lane: lane.id, kind: "terminal" } }))} /> : null}
  </div>;
}

export function firstSentence(text: string): string {
  const line = text.split("\n").find((l) => l.trim()) ?? text;
  const end = line.search(/[.!?](\s|$)/);
  return end > 0 ? line.slice(0, end + 1) : line;
}

/** Whether the lane's agent is connected, checked every few seconds while the lane is live. */
function useAgentLink(lane: Lane, version: number): AgentLink | null {
  const live = lane.state === "working" || lane.state === "needs_you";
  const [link, , reload] = useJson<AgentLink>(live ? `/api/lanes/${lane.id}/agent` : null);
  useEffect(() => { if (!live) return; const t = setInterval(reload, 5_000); return () => clearInterval(t); }, [live, reload]);
  useEffect(() => reload(), [version, reload]);
  return live ? link : null;
}

function LaneList({ lanes, events, inbox, selected, choose }: { lanes: Lane[]; events: LaneEvent[]; inbox: InboxItem[]; selected: string | null; choose: (id: string | null) => void }) {
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
      <div className="ps-h" style={{ marginBottom: 10 }}><span className="lbl">Lanes · {lanes.length}</span></div>
      <div className="lanes-scroll" data-key-list>
        <button className={clsx("ovr", !(selected) && "on")} onClick={() => choose(null)}><Tile family="team" icon="subagent" small /><span><b style={{ fontSize: 14 }}>Overview</b><span className="muted" style={{ display: "block", fontSize: 12.5, marginTop: 1 }}>every lane at a glance</span></span><span className="mono muted" style={{ marginLeft: "auto", fontSize: 12 }}>{lanes.length}</span></button>
        {groups.map(([goal, group]) => <div key={goal ?? ""} style={{ display: "contents" }}>
          {hasGoals ? <div className="grp">{goal ? <><i className="g work" aria-hidden="true" />Goal · {goal}</> : "No goal"}</div> : null}
          {group.filter((l) => showArchived || l.state !== "archived" || l.id === selected).map((l) => {
            const [g] = GLYPH[l.state];
            return <button data-list-item data-lane={l.id} key={l.id} className={clsx("lrow", l.colour, g === "wait" && "needs", l.id === selected && "on")} onClick={() => choose(l.id)} aria-current={l.id === selected ? "true" : undefined}>
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
  const [open, setOpen] = useState(false);
  useEffect(() => { const t = setInterval(reload, 15_000); return () => clearInterval(t); }, [reload]);
  const agents = data?.agents ?? [];
  if (!agents.length) return null;
  const running = agents.filter((a) => a.running).length;
  const take = (a: OutsideAgent) => { setMessage(""); void postJson<Lane>(`/api/projects/${project}/takeover`, { pid: a.pid, startedAt: a.startedAt }).then((lane) => { reload(); choose(lane.id); }, (err: Error) => setMessage(err.message)); };
  return <div className="ps">
    <div className="ps-h" style={{ marginBottom: 8 }}><span className="lbl">Outside sessions · {agents.length}</span><Help>Claude Code or Codex sessions started in a terminal for this project. ContextLanes only watches them; take one over to continue it in a lane.</Help><div className="e"><button className="lnk" style={{ fontSize: 13 }} aria-expanded={open} onClick={() => setOpen((v) => !v)}>{open ? "Hide" : "Show"}</button></div></div>
    {!open ? <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>{running ? <Glyph g="work">{`${running} running`}</Glyph> : null}{agents.length - running ? <Glyph g="idle">{`${agents.length - running} ended`}</Glyph> : null}</div> : null}
    {open ? agents.map((a) => <div key={`${a.pid}${a.startedAt}`} style={{ display: "grid", gap: 6, marginBottom: 10 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}><AgentMark agent={a.agent} small /><span style={{ fontSize: 14 }}>Terminal session</span><span className="mono muted" style={{ marginLeft: "auto", fontSize: 12 }}>pid {a.pid}</span></div>
      <span className="muted" style={{ fontSize: 12.5 }}>{a.running ? "Running in a terminal · close it there to take it over" : `Ended ${agoText(a.endedAt!)}. Take it over to continue in a lane.`}</span>
      <span className="mono muted" style={{ fontSize: 11.5, overflowWrap: "anywhere" }}>{a.cwd}</span>
      <div><button className="btn sm ghost" disabled={a.running} title={a.running ? "Close it first" : undefined} onClick={() => take(a)}>{a.running ? "Close it first" : "Take over"}</button></div>
    </div>) : null}
    {message ? <p role="alert" style={{ margin: 0, fontSize: 13 }}>{message}</p> : null}
  </div>;
}

function LaneView({ projectName, lane, events, error, reload }: { projectName: string; lane: Lane; events: LaneEvent[]; error: string; reload: () => void }) {
  const features = useFeatures();
  const [waiting, , reloadInbox] = useInbox();
  const [notice, setNotice] = useState("");
  // Checked again when the agent's connection could have changed, not on every streamed word.
  const changes = useMemo(() => events.filter((e) => e.type === "agent.session" || e.type === "agent.error" || e.type === "lane.state").length, [events]);
  const link = useAgentLink(lane, changes);
  const offline = link !== null && !link.connected;
  const laneWaiting = useMemo(() => waiting?.filter((item) => item.lane === lane.id) ?? [], [waiting, lane.id]);
  const session = events.findLast((e) => e.type === "agent.session");
  const current = session?.type === "agent.session" ? session.payload : null;
  const agent = AGENT_NAMES[lane.agent] ?? lane.agent;
  const live = lane.state === "working" || lane.state === "needs_you";
  return <>
    {/* Phone only (phone-lane.webp): the lane fills the screen, with a way back to the project. */}
    <Link className="back" to={`/p/${lane.project}/work`}>‹ {projectName}</Link>
    <div className="ph">
      <LaneBadge id={lane.id} colour={lane.colour} large /><AgentMark agent={lane.agent} />
      <h2>{lane.task}</h2>
      <StateGlyph state={lane.state} idle={isIdle(lane, events)} label />
      {sharing(events, lane.id).map((c) => <Link key={c.module} className="lnk" style={{ fontSize: 13 }} to={`/p/${lane.project}/architecture`}><Glyph g="wait">Also changed by {c.others.map((o) => o.slice(o.lastIndexOf("/") + 1)).join(" and ")}: {c.module}</Glyph></Link>)}
      <div className="e"><span className="mono muted" style={{ fontSize: 12 }}>{lane.branch} · started {ago(lane.createdAt) === "now" ? "just now" : `${ago(lane.createdAt)} ago`}</span>{features.review && lane.state === "working" ? <button className="btn sm" title="Runs the checks, takes screenshots and puts the work on Review for you to merge" onClick={() => {
        const said = events.findLast((e) => e.type === "agent.message" && e.payload.role === "agent");
        const summary = (said?.type === "agent.message" ? said.payload.text.trim().slice(0, 2000) : "") || lane.task;
        void postJson<{ asked: boolean }>(`/api/lanes/${lane.id}/checkpoint`, { summary }).then((r) => setNotice(r.asked ? "Not committed yet · the agent was asked to commit and send it for review." : "Checks running · the lane moves to Review when they finish."), (err) => setNotice(errorMessage(err)));
      }}>Ask for review</button> : null}</div>
    </div>

    {lane.state === "failed" ? <FailedNote lane={lane} events={events} /> : null}

    {lane.kind === "shell" ? <section className="sec" aria-label="Lane"><div className="sec-r" style={{ gap: 10, flexWrap: "wrap" }}>
      <Glyph g="idle">No agent</Glyph><span className="muted" style={{ fontSize: 13 }}>This is your own shell, not confined: an agent you start in it runs with your access.</span>
      <div className="e"><Cmd>{`cl sh ${lane.id}`}</Cmd></div>
    </div></section>
    : <section className="sec" aria-label="Agent"><div className="sec-r" style={{ gap: 14, flexWrap: "wrap" }}>
      <span className="mono" style={{ fontSize: 13 }}>{current?.models.find((m) => m.id === current.currentModel)?.label ?? lane.model ?? `${agent} default`}</span>
      {current?.currentEffort ? <span className="mono muted" style={{ fontSize: 13 }}>{current.efforts?.find((m) => m.id === current.currentEffort)?.label ?? current.currentEffort} effort</span> : null}
      {current?.currentMode ? <span className="mono muted" style={{ fontSize: 13 }}>{current.modes.find((m) => m.id === current.currentMode)?.label ?? current.currentMode}</span> : null}
      {offline && link?.starting ? <Glyph g="think">Starting the agent…</Glyph>
        : offline ? <Glyph g="fail">Agent not connected</Glyph>
        : !session && link ? <Glyph g="think">Waiting for the agent to report in</Glyph> : null}
      <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
        <Glyph g={lane.auto ? "work" : "idle"}>{lane.auto ? "Auto on" : "Auto off"}</Glyph>
        <Help label="What does Auto approve?">With Auto on, ContextLanes, not the agent, approves each request once. These still wait for you: {DIRE_ACTIONS.join("; ")}. The lane sandbox still hides your tokens. Only you can change it, from the machine: <code>cl auto {lane.id} {lane.auto ? "off" : "on"}</code></Help></span>
      {offline && !link?.starting ? <div className="e"><Cmd note="start it again">{`cl lane restart ${lane.id}`}</Cmd></div> : null}
    </div>{notice ? <div className="sec-f" role="status" style={{ minHeight: 40, fontSize: 13 }}>{notice}</div> : null}</section>}

    {error ? <p role="alert">{error} <button className="btn ghost sm" onClick={reload}>Try again</button></p> : null}
    <LanePanes lane={lane} events={events} waiting={laneWaiting} reload={reloadInbox} agent={agent} />
    {lane.kind !== "shell" && live ? <section className="sec" aria-label="Message the agent"><div className="sec-r" style={{ gap: 10, flexWrap: "wrap" }}>
      <span className="muted" style={{ fontSize: 13 }}>Messages go in from the machine, or type in the lane's own terminal.</span>
      <div className="e"><Cmd>{`cl say ${lane.id} "<message>"`}</Cmd></div>
    </div></section> : null}
  </>;
}

/** Why a lane failed, from its last state change, in the words the setup step reported. */
function FailedNote({ lane, events }: { lane: Lane; events: LaneEvent[] }) {
  const change = events.findLast((e) => e.type === "lane.state" && e.payload.to === "failed");
  const error = events.findLast((e) => e.type === "agent.error");
  const reason = change?.type === "lane.state" && change.payload.reason ? change.payload.reason : error?.type === "agent.error" ? error.payload.message : "No reason was recorded.";
  const text = reason.trim();
  const headline = firstSentence(text).slice(0, 160);
  // The reason as one line; the full output (log lines, a long error) one click away.
  return <section className="sec" style={{ borderColor: "var(--bad)" }} aria-label="Why this lane failed">
    <div className="sec-h"><Glyph g="fail">Stopped</Glyph><span style={{ fontSize: 14.5, fontWeight: 600, color: "var(--ink)", minWidth: 0 }}>{headline}</span></div>
    {text.length > headline.length + 1 ? <details className="sec-b more"><summary>Details</summary><div className="out">{text}</div></details> : null}
    {lane.kind !== "shell" ? <div className="sec-f"><Cmd note="same branch and checkout">{`cl lane restart ${lane.id}`}</Cmd></div> : null}
  </section>;
}
