import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { InboxItem, LaneEvent } from "@contextlanes/protocol";
import { answerItem, errorMessage } from "../api";
import { Empty, Glyph, Tile, ago, iconFor, type IconName } from "../components/ui";
import { stepsFor, type Step } from "./model";

export type Filter = "all" | "thinking" | "changes";
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

export function Steps({ events, waiting, reload, agent, filter }: { events: LaneEvent[]; waiting: InboxItem[]; reload: () => void; agent: string; filter: Filter }) {
  const all = useMemo(() => stepsFor(events), [events]);
  const steps = useMemo(() => all.filter((s) => filter === "all" || (filter === "thinking" ? s.family === "mind" && s.type !== "text" : s.family === "change")), [all, filter]);
  const [shown, setShown] = useState(WINDOW);
  const hidden = Math.max(0, steps.length - shown);
  // The first message (the task) always stays on top, so the lane's purpose is never scrolled away.
  const first = hidden && steps[0]?.type === "text" && steps[0].family === "you" ? steps[0] : null;
  const pane = useRef<HTMLDivElement>(null);
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
    if (pinned.current || steps.at(-1)?.family === "you" && added > 0) toEnd();
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
  return <>
    {!steps.length ? <Empty>{filter === "all" ? "No steps yet" : "None of this kind"}</Empty>
      : <div className="steps-win">
        <div className="steps-pane" ref={pane} onScroll={onScroll} role="log" aria-label="Steps" tabIndex={0} style={fit ? { maxHeight: fit } : undefined}>
          <div className="sec-b" style={{ padding: "8px 18px 12px" }}><div className="spine">
            {first ? <StepRow key={first.seq} step={first} events={events} waiting={waiting} reload={reload} agent={agent} /> : null}
            {hidden ? <div className="more-steps"><button className="lnk" onClick={earlier}>{`Show ${Math.min(WINDOW, hidden)} earlier steps`}</button><span className="mono muted" style={{ fontSize: 12 }}>{hidden} hidden</span></div> : null}
            {steps.slice(hidden).filter((s) => s !== first).map((step) => <StepRow key={step.seq} step={step} events={events} waiting={waiting} reload={reload} agent={agent} />)}
          </div></div>
        </div>
        {!atEnd ? <button className={`btn sm jump${needsYou ? " you" : ""}`} onClick={() => toEnd(true)}>
          <Chevron down />{needsYou ? "Waiting for you" : unseen ? `${unseen} new ${unseen === 1 ? "step" : "steps"}` : "Latest"}</button> : null}
      </div>}
  </>;
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
