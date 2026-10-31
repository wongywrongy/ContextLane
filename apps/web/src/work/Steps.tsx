import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { InboxItem, Lane, LaneEvent } from "@contextlanes/protocol";
import { answerItem, errorMessage, postJson } from "../api";
import { Empty, Glyph, Tile, ago, iconFor, type IconName } from "../components/ui";
import { isIdle, laneNow, progressFor, stepsFor, workedLine, type ProgressItem, type Step } from "./model";

export type Filter = "progress" | "all" | "thinking" | "changes";
export function FilterSwitch({ value, change }: { value: Filter; change: (f: Filter) => void }) {
  return <div className="seg3" role="group" aria-label="Show">{(["all", "thinking", "changes"] as const).map((f) => <button key={f} className={value === f ? "on" : ""} aria-pressed={value === f} onClick={() => change(f)}>{f === "all" ? "All" : f === "thinking" ? "Thinking" : "Changes"}</button>)}</div>;
}
const time = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

/**
 * The step trail from the Console board, in its own scrolling window so the page keeps its size however long
 * the lane runs. It reads top to bottom like a conversation and opens at the latest step, next to the
 * message box. While you are at the bottom it follows new steps; scroll up and it stays where you are,
 * with a button back to the latest. Earlier steps load as you reach the top, keeping your place.
 */
const WINDOW = 200;
/** Within this many pixels of the bottom counts as "at the latest". */
const NEAR = 80;

type Item = Step | ProgressItem;
const isYou = (i: Item | undefined) => !!i && ("kind" in i ? i.kind === "milestone" && i.what === "you" : i.type === "text" && i.family === "you");

export function Steps({ lane, events, waiting, reload, agent, filter }: { lane: Lane; events: LaneEvent[]; waiting: InboxItem[]; reload: () => void; agent: string; filter: Filter }) {
  const all = useMemo(() => stepsFor(events), [events]);
  // Progress: milestones as rows, the work between them folded; the other filters show raw steps.
  const steps: Item[] = useMemo(() => filter === "progress" ? progressFor(all) : all.filter((s) => filter === "all" || (filter === "thinking" ? s.family === "mind" && s.type !== "text" : s.family === "change")), [all, filter]);
  const [shown, setShown] = useState(WINDOW);
  const hidden = Math.max(0, steps.length - shown);
  // The first message (the task) always stays on top, so the lane's purpose is never scrolled away.
  const first = hidden && isYou(steps[0]) ? steps[0]! : null;
  const pane = useRef<HTMLDivElement>(null);
  // Rows that arrive after the page opened ease in; the history it opened with does not.
  const born = useRef<number | null>(null);
  if (born.current === null && events.length) born.current = events.at(-1)!.seq;
  const pinned = useRef(true);
  const [atEnd, setAtEnd] = useState(true);
  const [unseen, setUnseen] = useState(0);
  const seen = useRef(steps.length);
  const restore = useRef<number | null>(null);
  const toEnd = (smooth = false) => { const el = pane.current; if (el) el.scrollTo({ top: el.scrollHeight, behavior: smooth ? "smooth" : "auto" }); pinned.current = true; setAtEnd(true); setUnseen(0); };
  // A new filter opens at its latest step.
  useLayoutEffect(() => { toEnd(); seen.current = steps.length; }, [filter]); // eslint-disable-line react-hooks/exhaustive-deps
  useLayoutEffect(() => {
    const el = pane.current;
    if (!el) return;
    // Earlier steps were added above: keep the step you were reading where it was.
    if (restore.current !== null) { el.scrollTop += el.scrollHeight - restore.current; restore.current = null; return; }
    const added = steps.length - seen.current;
    seen.current = steps.length;
    // Your own message always brings you to the latest; otherwise follow only while you are at the bottom.
    if (pinned.current || isYou(steps.at(-1)) && added > 0) toEnd();
    else if (added > 0) setUnseen((n) => n + added);
  }, [events, steps, shown]); // eslint-disable-line react-hooks/exhaustive-deps
  const earlier = () => { if (!hidden || !pane.current) return; restore.current = pane.current.scrollHeight; setShown((n) => n + WINDOW); };
  const onScroll = () => {
    const el = pane.current;
    if (!el) return;
    const end = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR;
    pinned.current = end;
    if (end !== atEnd) setAtEnd(end);
    if (end && unseen) setUnseen(0);
    if (el.scrollTop < 40 && hidden && restore.current === null) earlier();
  };
  // The window takes the height left between what is above it and the message box below, so the whole
  // lane fits the screen without the page scrolling; on a short screen it keeps a usable minimum.
  const [fit, setFit] = useState<number | null>(null);
  useLayoutEffect(() => {
    const measure = () => {
      const el = pane.current;
      if (!el) return;
      const box = el.getBoundingClientRect();
      const top = box.top + window.scrollY;
      // What sits under the window in the lane column (the message box), not the taller inspector beside it.
      const column = el.closest(".lane-main") ?? document.body;
      const end = Math.max(...[...column.children].map((c) => c.getBoundingClientRect().bottom)) + parseFloat(getComputedStyle(column).paddingBottom || "0");
      const below = end - box.bottom;
      setFit(Math.max(window.innerWidth <= 760 ? 300 : 340, Math.floor(window.innerHeight - top - below - 16)));
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [steps.length > 0]); // eslint-disable-line react-hooks/exhaustive-deps
  // Resizing the window keeps you at the latest step if you were there.
  useLayoutEffect(() => { if (pinned.current) toEnd(); }, [fit]); // eslint-disable-line react-hooks/exhaustive-deps
  const needsYou = waiting.length > 0;
  const row = (item: Item) => born.current !== null && item.seq > born.current ? <div className="rise" key={item.seq}>{plain(item)}</div> : plain(item);
  const plain = (item: Item) => !("kind" in item) ? <StepRow key={item.seq} step={item} events={events} waiting={waiting} reload={reload} agent={agent} />
    : item.kind === "worked" ? <WorkedRow key={item.seq} item={item} events={events} waiting={waiting} reload={reload} agent={agent} />
    : item.what === "tests" || item.what === "commit" || item.what === "push" ? <MilestoneRow key={item.seq} item={item} />
    : <StepRow key={item.seq} step={item.step} events={events} waiting={waiting} reload={reload} agent={agent} />;
  return <>
    {filter === "progress" ? <Now lane={lane} events={events} waiting={waiting} /> : null}
    {!steps.length ? <Empty>{filter === "all" || filter === "progress" ? "No steps yet" : "None of this kind"}</Empty>
      : <div className="steps-win">
        <div className="steps-pane" ref={pane} onScroll={onScroll} role="log" aria-label="Steps" tabIndex={0} style={fit ? { maxHeight: fit } : undefined}>
          <div className="sec-b" style={{ padding: "8px 18px 12px" }}><div className="spine">
            {first ? row(first) : null}
            {hidden ? <div className="more-steps"><button className="lnk" onClick={earlier}>{`Show ${Math.min(WINDOW, hidden)} earlier ${filter === "progress" ? "rows" : "steps"}`}</button><span className="mono muted" style={{ fontSize: 12 }}>{hidden} hidden</span></div> : null}
            {steps.slice(hidden).filter((s) => s !== first).map(row)}
          </div></div>
        </div>
        {!atEnd ? <button className={`btn sm jump${needsYou ? " you" : ""}`} onClick={() => toEnd(true)}>
          <Chevron down />{needsYou ? "Waiting for you" : unseen ? `${unseen} new ${unseen === 1 ? "step" : "steps"}` : "Latest"}</button> : null}
      </div>}
  </>;
}

/** What the lane is doing now and how far its plan has got, above the progress rows. */
function Now({ lane, events, waiting }: { lane: Lane; events: LaneEvent[]; waiting: InboxItem[] }) {
  const [open, setOpen] = useState(false);
  const [asked, setAsked] = useState("");
  const plan = events.findLast((e) => e.type === "agent.plan");
  const entries = plan?.type === "agent.plan" ? plan.payload.entries : [];
  const done = entries.filter((e) => e.status === "completed").length;
  const current = entries.find((e) => e.status === "in_progress") ?? entries.find((e) => e.status === "pending");
  const mine = waiting.filter((i) => i.lane === lane.id);
  const idle = isIdle(lane, events);
  const g = mine.length ? "wait" : lane.state === "failed" ? "fail" : idle ? "idle" : lane.state === "working" ? "work" : "idle";
  const usage = events.findLast((e) => e.type === "usage");
  const share = usage?.type === "usage" && usage.payload.contextSize ? usage.payload.contextUsed / usage.payload.contextSize : 0;
  const [restarted, setRestarted] = useState("");
  const restart = () => { if (window.confirm("The agent writes a summary of the work so far, then a fresh session continues from it in the same checkout. Takes a minute or two.")) void postJson(`/api/lanes/${lane.id}/handoff`, {}).then(() => setRestarted("Writing the summary · the fresh session starts after"), (e) => setRestarted(errorMessage(e))); };
  const askForPlan = () => void postJson(`/api/lanes/${lane.id}/prompt`, { text: PLAN_PROMPT, immediate: false }).then(() => setAsked("Asked · it writes one after its current step"), (e) => setAsked(errorMessage(e)));
  return <div className="now">
    <div className="now-r"><span className="lbl">Now</span><Glyph g={g}>{laneNow(lane, events, waiting)}</Glyph></div>
    <div className="now-r"><span className="lbl">Plan</span>
      {entries.length ? <button className="planbar" aria-expanded={open} onClick={() => setOpen(!open)} title={open ? "Hide the plan" : "Show the plan"}>
        <span className="segs" aria-hidden="true">{entries.map((e, i) => <i key={i} className={e.status === "completed" ? "d" : e.status === "in_progress" ? "p" : ""} />)}</span>
        <span>{done} of {entries.length}{current ? <span className="muted"> · {current.status === "in_progress" ? "on" : "next"}: {current.text}</span> : null}</span></button>
        : <><Glyph g="idle">No plan yet</Glyph>{asked ? <span className="muted" style={{ fontSize: 13 }}>{asked}</span> : lane.state === "working" || lane.state === "needs_you" ? <button className="btn ghost sm" onClick={askForPlan}>Ask for a plan</button> : null}</>}
    </div>
    {share >= 0.7 && (lane.state === "working" || lane.state === "needs_you") ? <div className="now-r"><span className="lbl">Context</span>
      <Glyph g={share >= 0.85 ? "fail" : "wait"}>{`${Math.round(share * 100)}% full`}</Glyph>
      {restarted ? <span className="muted" style={{ fontSize: 13 }}>{restarted}</span> : <button className="btn ghost sm" title="The agent writes a summary, and a fresh session continues from it in the same checkout" onClick={restart}>Restart with a summary</button>}</div> : null}
    {open ? <div className="plan" style={{ padding: "4px 0 6px 92px" }}>{entries.map((entry, i) => <Glyph key={i} g={entry.status === "completed" ? "done" : entry.status === "in_progress" ? "think" : "idle"}>{entry.text}</Glyph>)}</div> : null}
  </div>;
}

export const PLAN_PROMPT = "Before you continue: write a short plan of what is left (3 to 7 steps) with your plan or todo tool, mark what is done, then carry on.";

/** A stretch of work between two milestones, folded into one line; open it to see each step. */
function WorkedRow({ item, events, waiting, reload, agent }: { item: Extract<ProgressItem, { kind: "worked" }>; events: LaneEvent[]; waiting: InboxItem[]; reload: () => void; agent: string }) {
  const [open, setOpen] = useState(false);
  return <>
    <div className="st3">
      <span className="tm">{time(item.at)}</span>
      <Tile family={item.edited.length ? "change" : "look"} icon={item.edited.length ? "edit" : "read"} />
      <div style={{ minWidth: 0 }}><button className="tgl wk-line" aria-expanded={open} onClick={() => setOpen(!open)}><Chevron />{workedLine(item)}</button>
        {item.failed ? <span className="muted" style={{ display: "block", fontSize: 12.5, marginLeft: 17 }}>{item.failed} {item.failed === 1 ? "step" : "steps"} failed along the way</span> : null}</div>
      <span className="mono muted" style={{ fontSize: 12 }}>{item.steps.length} {item.steps.length === 1 ? "step" : "steps"}</span>
    </div>
    {open ? <div style={{ marginLeft: 24, borderLeft: "2px solid var(--line-soft)" }}>{item.steps.map((step) => <StepRow key={step.seq} step={step} events={events} waiting={waiting} reload={reload} agent={agent} />)}</div> : null}
  </>;
}

/** Tests, commits and pushes, said plainly, with the command one click away. */
function MilestoneRow({ item }: { item: Extract<ProgressItem, { kind: "milestone" }> }) {
  const [open, setOpen] = useState(false);
  const icon: IconName = item.what === "tests" ? "test" : item.what === "push" ? "subagent" : "checkpoint";
  return <div className="st3">
    <span className="tm">{time(item.at)}</span>
    <Tile family={item.ok === false ? "you" : "run"} icon={icon} />
    <div style={{ minWidth: 0 }}><b style={{ fontSize: 15, display: "block" }}>{item.title}</b>
      <button className="tgl" aria-expanded={open} onClick={() => setOpen(!open)}><Chevron />{open ? "Hide command" : "Command"}</button>
      {open ? <div className="out" style={{ marginTop: 6 }}>{item.step.title}</div> : null}</div>
    <span className={`sig${item.ok === false ? " fail" : ""}`}>{item.what === "tests" ? item.ok ? "passed" : "failed" : item.what}</span>
  </div>;
}

function tileFor(step: Step): IconName {
  if (step.tool) return iconFor(step.tool.kind);
  switch (step.type) {
    case "text": return "message";
    case "thought": return "think";
    case "plan": return "plan";
    case "permission": return step.event.type === "permission.requested" && step.event.payload.kind === "question" ? "question" : "permission";
    case "check": return "test";
    default: return step.family === "team" ? "subagent" : step.family === "you" ? "permission" : step.family === "run" ? "execute" : "think";
  }
}

function StepRow({ step, events, waiting, reload, agent }: { step: Step; events: LaneEvent[]; waiting: InboxItem[]; reload: () => void; agent: string }) {
  const [open, setOpen] = useState(false);
  let title: string = step.title;
  let sub: string | null = null;
  let right: ReactNode = null;
  let extra: ReactNode = null;
  if (step.type === "text") {
    title = step.family === "you" ? "You" : agent;
    const text = step.text ?? "";
    // A long message (a whole plan) shows its start; the rest opens in place, kept as written.
    if (text.length > 600 || text.split("\n").length > 8) {
      extra = <><div className="sb" style={{ whiteSpace: "pre-wrap" }}>{open ? text : `${text.split("\n").slice(0, 6).join("\n").slice(0, 500)}…`}</div><button className="tgl" aria-expanded={open} onClick={() => setOpen(!open)}><Chevron />{open ? "Show less" : `Show all ${text.split("\n").length} lines`}</button></>;
    } else sub = text;
  }
  if (step.type === "thought") { title = "Thinking"; extra = <><button className="tgl" aria-expanded={open} onClick={() => setOpen(!open)}><Chevron />{open ? "Hide thinking" : "Show thinking"}</button>{open ? <div className="panel mind thought">{step.text}</div> : null}</>; }
  if (step.type === "plan" && step.event.type === "agent.plan") {
    const entries = step.event.payload.entries;
    title = `Wrote a ${entries.length}-step plan`;
    const now = entries.find((e) => e.status === "in_progress");
    sub = now ? `Now: ${now.text}` : null;
  }
  if (step.tool) {
    const { diff, tests, counts, status, failedBefore, files, summary } = step.tool;
    if (files.length) extra = <div className="files">{files.slice(0, 4).map((f) => <span className="fchip" key={f}>{f.split("/").at(-1)}</span>)}{files.length > 4 ? <span className="fchip">+{files.length - 4}</span> : null}</div>;
    if (summary) extra = <>{extra}<button className="tgl" aria-expanded={open} onClick={() => setOpen(!open)} style={{ color: "var(--text-2)" }}><Chevron />{open ? "Hide output" : "Show output"}</button>{open ? <div className="out">{summary}</div> : null}</>;
    if (diff) { const total = diff.added + diff.removed || 1; right = <><span className="diffbar" aria-hidden="true"><i className="a" style={{ width: `${diff.added / total * 100}%` }} /><i className="d" style={{ width: `${diff.removed / total * 100}%` }} /></span><span className="mono" style={{ fontSize: 12 }} aria-label={`${diff.added} lines added, ${diff.removed} removed`}><span style={{ color: "var(--ok-ink)" }}>+{diff.added}</span> <span style={{ color: "var(--bad-ink)" }}>−{diff.removed}</span></span></>; }
    else if (tests?.length) { const passed = tests.filter((t) => t.passed).length; right = <><span className="pips" aria-hidden="true">{tests.slice(0, 60).map((t, i) => <i key={i} className={t.passed ? "" : "f"} title={t.name} />)}</span><span className="mono" style={{ fontSize: 12 }}>{passed} / {tests.length}</span></>; }
    else if (counts?.total) { const pips = Math.min(counts.total, 60); const bad = Math.round(counts.failed / counts.total * pips); right = <><span className="pips" aria-hidden="true">{Array.from({ length: pips }, (_, i) => <i key={i} className={i >= pips - bad ? "f" : ""} />)}</span><span className="mono" style={{ fontSize: 12 }} aria-label={`${counts.passed} of ${counts.total} passed, ${counts.tool}`}>{counts.passed} / {counts.total}</span></>; }
    // A command that exited non-zero says so with its code (a failed `test -d` is not a broken tool); the output is under Show output.
    if (status === "failed") right = <>{right}<span className="sig fail" title={step.tool.exitCode != null ? "The command exited with this code" : undefined}>{step.tool.exitCode != null ? `exit ${step.tool.exitCode}` : "failed"}</span></>;
    else if (failedBefore && status === "completed") right = <>{right}<span className="sig">failed, then fixed</span></>;
    else if (status === "in_progress" || status === "pending") right = <>{right}<span className="sig wait">running</span></>;
  }
  if (step.type === "check" && step.event.type === "check.result") { sub = step.event.payload.detail ?? null; right = <span className={`sig${step.event.payload.passed ? "" : " fail"}`}>{step.event.payload.passed ? "passed" : "failed"}</span>; }
  if (step.type === "status") sub = step.text ?? null;

  if (step.type === "permission" && step.event.type === "permission.requested") {
    const request = step.event.payload;
    const pending = waiting.find((item) => item.id === `${step.event.lane}#${request.requestId}`);
    const answer = events.find((e) => e.type === "permission.answered" && e.payload.requestId === request.requestId);
    if (pending) return <div className="st3"><span className="tm">now</span><Tile family="you" icon={tileFor(step)} /><PermissionPanel item={pending} detail={request.held ? `Auto left this for you: it ${request.held}.` : request.detail} answered={reload} agent={agent} /><span /></div>;
    if (answer?.type === "permission.answered") {
      const chosen = request.options.find((o) => o.id === answer.payload.optionId);
      const allowed = chosen?.kind.startsWith("allow");
      right = <span className={`sig${allowed ? "" : " wait"}`}>{chosen ? `${chosen.label.toLowerCase()} · ${answer.payload.by === "web" ? "here" : answer.payload.by === "auto" ? "auto" : `from ${answer.payload.by}`}` : "cancelled"}</span>;
    } else right = <span className="sig wait">waiting on you</span>;
    sub = request.detail ?? null;
  }
  return <div className={`st3${step.tool?.failedBefore ? " fixed" : ""}`}>
    <span className="tm">{time(step.at)}</span>
    <Tile family={step.family} icon={tileFor(step)} label={step.tool?.kind ?? step.type} />
    <div style={{ minWidth: 0 }}><div className="tt">{title}</div>{sub ? <div className="sb">{sub}</div> : null}{extra}</div>
    <div className="rt">{right}</div>
  </div>;
}

function PermissionPanel({ item, detail, answered, agent }: { item: InboxItem; detail?: string; answered: () => void; agent: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const respond = async (optionId: string) => {
    setBusy(true); setError("");
    try { await answerItem(item, optionId); answered(); } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  };
  return <div className="panel you perm" style={{ minWidth: 0 }}>
    <div className="hd"><Glyph g="wait" /><b>{item.kind === "question" ? `${agent} asks` : `${agent} wants to`}: {item.title}</b><span className="t">waiting {ago(item.since)}</span></div>
    {detail ? <div className="out" style={{ marginTop: 10 }}>{detail}</div> : null}
    <div className="acts">{item.options.map((o, i) => <button key={o.id} className={`btn sm${i === 0 || o.kind === "allow_once" ? "" : " ghost"}`} disabled={busy} onClick={() => void respond(o.id)}>{o.label}</button>)}</div>
    {error ? <p role="alert" style={{ margin: "8px 0 0" }}>{error}</p> : null}
  </div>;
}

function Chevron({ down = false }: { down?: boolean }) {
  return <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" aria-hidden="true" style={down ? { transform: "rotate(90deg)" } : undefined}><path d="m9 6 6 6-6 6" /></svg>;
}
