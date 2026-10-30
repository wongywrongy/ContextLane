import { useState, type ReactNode } from "react";
import type { InboxItem, LaneEvent } from "@contextlanes/protocol";
import { answerItem, errorMessage } from "../api";
import { Empty, Glyph, Tile, ago, iconFor, type IconName } from "../components/ui";
import { stepsFor, type Step } from "./model";

export type Filter = "all" | "thinking" | "changes";
export function FilterSwitch({ value, change }: { value: Filter; change: (f: Filter) => void }) {
  return <div className="seg3" role="group" aria-label="Show">{(["all", "thinking", "changes"] as const).map((f) => <button key={f} className={value === f ? "on" : ""} aria-pressed={value === f} onClick={() => change(f)}>{f === "all" ? "All" : f === "thinking" ? "Thinking" : "Changes"}</button>)}</div>;
}
const time = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

/** The step trail from the Console board: time, kind tile on a spine, what happened, evidence on the right. */
export function Steps({ events, waiting, reload, agent, filter }: { events: LaneEvent[]; waiting: InboxItem[]; reload: () => void; agent: string; filter: Filter }) {
  const steps = stepsFor(events).filter((s) => filter === "all" || (filter === "thinking" ? s.family === "mind" && s.type !== "text" : s.family === "change"));
  return <>
    {!steps.length ? <Empty>{filter === "all" ? "Steps appear here as the agent plans, reads, edits and runs things." : "Nothing of this kind yet."}</Empty>
      : <div className="sec-b" style={{ padding: "8px 18px 12px" }}><div className="spine">
        {steps.map((step) => <StepRow key={step.seq} step={step} events={events} waiting={waiting} reload={reload} agent={agent} />)}
      </div></div>}
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
  if (step.type === "text") { title = step.family === "you" ? "You" : agent; sub = step.text ?? ""; }
  if (step.type === "thought") { title = "Thinking"; extra = <><button className="tgl" aria-expanded={open} onClick={() => setOpen(!open)}><Chevron />{open ? "Hide thinking" : "Show thinking"}</button>{open ? <div className="panel mind thought">{step.text}</div> : null}</>; }
  if (step.type === "plan" && step.event.type === "agent.plan") {
    const entries = step.event.payload.entries;
    title = `Wrote a ${entries.length}-step plan`;
    const now = entries.find((e) => e.status === "in_progress");
    sub = now ? `Now: ${now.text}` : null;
  }
  if (step.tool) {
    const { diff, tests, status, failedBefore, files, summary } = step.tool;
    if (files.length) extra = <div className="files">{files.slice(0, 4).map((f) => <span className="fchip" key={f}>{f.split("/").at(-1)}</span>)}{files.length > 4 ? <span className="fchip">+{files.length - 4}</span> : null}</div>;
    if (summary) extra = <>{extra}<button className="tgl" aria-expanded={open} onClick={() => setOpen(!open)} style={{ color: "var(--text-2)" }}><Chevron />{open ? "Hide output" : "Show output"}</button>{open ? <div className="out">{summary}</div> : null}</>;
    if (diff) { const total = diff.added + diff.removed || 1; right = <><span className="diffbar" aria-hidden="true"><i className="a" style={{ width: `${diff.added / total * 100}%` }} /><i className="d" style={{ width: `${diff.removed / total * 100}%` }} /></span><span className="mono" style={{ fontSize: 12 }} aria-label={`${diff.added} lines added, ${diff.removed} removed`}><span style={{ color: "var(--ok-ink)" }}>+{diff.added}</span> <span style={{ color: "var(--bad-ink)" }}>−{diff.removed}</span></span></>; }
    else if (tests?.length) { const passed = tests.filter((t) => t.passed).length; right = <><span className="pips" aria-hidden="true">{tests.slice(0, 60).map((t, i) => <i key={i} className={t.passed ? "" : "f"} title={t.name} />)}</span><span className="mono" style={{ fontSize: 12 }}>{passed} / {tests.length}</span></>; }
    if (status === "failed") right = <>{right}<span className="sig fail">failed</span></>;
    else if (failedBefore && status === "completed") right = <>{right}<span className="sig">failed, then fixed</span></>;
    else if (status === "in_progress" || status === "pending") right = <>{right}<span className="sig wait">running</span></>;
  }
  if (step.type === "check" && step.event.type === "check.result") { sub = step.event.payload.detail ?? null; right = <span className={`sig${step.event.payload.passed ? "" : " fail"}`}>{step.event.payload.passed ? "passed" : "failed"}</span>; }
  if (step.type === "status") sub = step.text ?? null;

  if (step.type === "permission" && step.event.type === "permission.requested") {
    const request = step.event.payload;
    const pending = waiting.find((item) => item.id === `${step.event.lane}#${request.requestId}`);
    const answer = events.find((e) => e.type === "permission.answered" && e.payload.requestId === request.requestId);
    if (pending) return <div className="st3"><span className="tm">now</span><Tile family="you" icon={tileFor(step)} /><PermissionPanel item={pending} detail={request.detail} answered={reload} agent={agent} /><span /></div>;
    if (answer?.type === "permission.answered") {
      const chosen = request.options.find((o) => o.id === answer.payload.optionId);
      const allowed = chosen?.kind.startsWith("allow");
      right = <span className={`sig${allowed ? "" : " wait"}`}>{chosen ? `${chosen.label.toLowerCase()} · ${answer.payload.by === "web" ? "here" : `from ${answer.payload.by}`}` : "cancelled"}</span>;
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

function Chevron() {
  return <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" aria-hidden="true"><path d="m9 6 6 6-6 6" /></svg>;
}
