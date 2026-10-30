import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link, useParams, useSearchParams } from "react-router";
import type { Checkpoint, Lane, LaneEvent } from "@contextlanes/protocol";
import { apiFetch, errorMessage, getJson, postJson, useInbox, useJson, useImage } from "../../api";
import { useProjectWork } from "../../components/Shell";
import { AGENT_NAMES, AgentMark, Dialog, Empty, Glyph, LaneBadge, Section, Tile, iconFor } from "../../components/ui";
import { loadHistory, stepsFor } from "../../work/model";

const WORDS = { strong: "Strong", mixed: "Mixed", weak: "Weak" } as const;
const SIGNAL = { strong: "", mixed: " wait", weak: " fail" } as const;
const clock = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const totals = (files: Checkpoint["files"]) => files.reduce((sum, f) => ({ added: sum.added + f.added, removed: sum.removed + f.removed }), { added: 0, removed: 0 });
/** "Tests pass 44 / 44", "Types clean · tsc", "2 lint warnings · eslint": the tool's own summary when it printed one. */
function CheckRow({ check }: { check: Checkpoint["checks"][number] }) {
  const c = check.counts;
  const warned = check.passed && !!c?.warnings;
  const words = !c ? check.name
    : c.total !== null ? `${check.name} ${check.passed ? "pass" : "fail"}`
    : warned ? `${c.warnings} ${c.warnings === 1 ? "warning" : "warnings"}`
    : check.passed ? `${check.name} clean` : `${c.failed} ${c.failed === 1 ? "error" : "errors"}`;
  const right = !c ? (check.ms < 1000 ? `${check.ms} ms` : `${Math.round(check.ms / 100) / 10} s`)
    : c.total !== null ? `${c.passed} / ${c.total}` : c.tool;
  return <div className="rvr" title={check.detail || undefined}><i className={`g ${warned ? "wait" : check.passed ? "done" : "fail"}`} role="img" aria-label={warned ? "Look closer" : check.passed ? "Passed" : "Failed"} /><span>{words}</span><span className="r">{right}{c && c.total !== null ? <span className="muted"> · {c.tool}</span> : null}</span></div>;
}

const clean = (c: Checkpoint) => c.checks.every((check) => check.passed) && !c.unplanned.length;

function duration(from: string, to: string): string {
  const minutes = Math.max(0, Math.round((Date.parse(to) - Date.parse(from)) / 60_000));
  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** Review: what is ready on the left; the selected checkpoint's evidence and the decision on the right. */
export function ReviewPage() {
  const { project = "" } = useParams();
  const { lanes, events } = useProjectWork();
  const [checkpoints, error, reload] = useJson<Checkpoint[]>(`/api/projects/${project}/checkpoints`);
  const [params, setParams] = useSearchParams();
  const changes = events.filter((e) => e.type === "checkpoint.created" || e.type === "checkpoint.decided").length;
  useEffect(reload, [reload, changes]);
  const latest = (lane: string) => checkpoints?.find((c) => c.lane === lane);
  const ready = lanes.filter((l) => l.state === "in_review" && latest(l.id));
  const waiting = lanes.filter((l) => l.state === "needs_you");
  const lane = ready.find((l) => l.id === params.get("lane")) ?? ready[0] ?? null;
  const checkpoint = lane ? latest(lane.id)! : null;
  const number = checkpoint ? checkpoints!.filter((c) => c.lane === checkpoint.lane).length : 0;
  return <div className="rvw">
    <aside className="rvl" aria-label="Checkpoints">
      <div>
        <span className="lbl">Ready <span>{ready.length}</span></span>
        {ready.map((l) => { const c = latest(l.id)!; const t = totals(c.files); return <button key={l.id} className={`rvi${l.id === lane?.id ? " on" : ""}`} aria-current={l.id === lane?.id ? "true" : undefined} onClick={() => setParams({ lane: l.id })}>
          <LaneBadge id={l.id} colour={l.colour} /><b>{l.task}</b><i className={`g ${clean(c) ? "done" : "wait"}`} role="img" aria-label={clean(c) ? "Checks pass" : "Look closer"} /><small>+{t.added} -{t.removed} · {c.files.length} {c.files.length === 1 ? "file" : "files"}</small>
        </button>; })}
        {checkpoints && !ready.length ? <span className="muted" style={{ fontSize: 13.5 }}>Nothing is ready yet.</span> : null}
      </div>
      {waiting.length ? <div>
        <span className="lbl">Not ready <span>{waiting.length}</span></span>
        {waiting.map((l) => <Link key={l.id} className="rvi" to={`/p/${project}/work?lane=${encodeURIComponent(l.id)}`}><LaneBadge id={l.id} colour={l.colour} /><b>{l.task}</b><i className="g wait" role="img" aria-label="Needs you" /><small>needs your answer</small></Link>)}
      </div> : null}
    </aside>
    <main className="rvm" aria-label="Checkpoint">
      {error ? <p role="alert">{error.message} <button className="btn ghost sm" onClick={reload}>Try again</button></p> : null}
      {lane && checkpoint ? <Packet key={checkpoint.id} lane={lane} checkpoint={checkpoint} number={number} decided={reload} />
        : <section className="sec"><Empty>When an agent sends a checkpoint, its checks, screenshots, plan and files appear here for you to decide on.</Empty></section>}
    </main>
  </div>;
}

function Packet({ lane, checkpoint, number, decided }: { lane: Lane; checkpoint: Checkpoint; number: number; decided: () => void }) {
  const [history, setHistory] = useState<LaneEvent[]>([]);
  useEffect(() => {
    const abort = new AbortController();
    void loadHistory(lane.id, apiFetch, abort.signal).then(setHistory, () => {});
    return () => abort.abort();
  }, [lane.id]);
  const shots = checkpoint.screenshots;
  const previewed = shots.some((s) => s.after);
  const results = checkpoint.checks.length + (shots.length ? 1 : 0);
  const done = checkpoint.plan.filter((p) => p.status === "completed").length;
  const base = lane.base ?? "main";
  return <>
    <header className="rvh">
      <div className="who"><LaneBadge id={lane.id} colour={lane.colour} /><AgentMark agent={lane.agent} small />{lane.branch} → {base} · {AGENT_NAMES[lane.agent] ?? lane.agent}</div>
      <h1>{lane.task} · checkpoint {number}</h1>
      <p>{checkpoint.summary}</p>
    </header>
    <div className="rv3">
      <Section title="Result" end={results ? <span className="mono muted" style={{ fontSize: 12 }}>{results} {results === 1 ? "check" : "checks"}</span> : undefined}>
        {checkpoint.checks.map((check) => <CheckRow key={check.name} check={check} />)}
        {shots.length ? <div className="rvr"><i className={`g ${previewed ? "done" : "wait"}`} role="img" aria-label={previewed ? "Passed" : "Look closer"} /><span>{previewed ? "Preview works" : "No preview picture"}</span><span className="r">{clock(checkpoint.createdAt)}</span></div> : null}
        {!results ? <div className="rvr muted">The recipe has no checks.</div> : null}
      </Section>
      <Section title="Process" end={<span className={`sig${SIGNAL[checkpoint.signal]}`}>Signal {WORDS[checkpoint.signal]}</span>}>
        {checkpoint.process.map((p) => <div className="rvr" key={p.label}><i className={`g ${p.ok ? "done" : "wait"}`} role="img" aria-label={p.ok ? "Yes" : "No"} /><span>{p.label}</span></div>)}
      </Section>
      <Section title="Plan vs done" end={checkpoint.plan.length ? <span className="mono muted" style={{ fontSize: 12 }}>{done} of {checkpoint.plan.length}</span> : undefined}>
        {checkpoint.plan.map((p, i) => <div className="rvr" key={i}><i className={`g ${p.status === "completed" ? "done" : p.status === "in_progress" ? "think" : "idle"}`} role="img" aria-label={p.status.replace("_", " ")} /><span>{p.text}</span></div>)}
        {!checkpoint.plan.length ? <div className="rvr muted">The agent wrote no plan.</div> : null}
        {checkpoint.unplanned.length ? <div className="rvr you"><i className="g wait" role="img" aria-label="Look closer" /><span>Not in the plan: {checkpoint.unplanned.slice(0, 3).join(", ")}{checkpoint.unplanned.length > 3 ? ` and ${checkpoint.unplanned.length - 3} more` : ""}</span></div> : null}
      </Section>
    </div>
    {shots.map((shot) => <Section key={shot.path} title="Before and after" meta={`${shot.path} · ${clock(checkpoint.createdAt)}`} end={shot.url ? <a className="lnk mono" href={shot.url} target="_blank" rel="noreferrer">{new URL(shot.url).host} ↗</a> : undefined}>
      <div className="ba">
        <Shot checkpoint={checkpoint} file={shot.before} tag={<span className="fchip">{base}</span>} label={`Before this lane`} />
        <Shot checkpoint={checkpoint} file={shot.after} tag={<span className={`lb ${lane.colour}`}>lane {lane.id.slice(lane.id.lastIndexOf("/") + 1)}</span>} label={`${checkpoint.files.length} changed ${checkpoint.files.length === 1 ? "file" : "files"}`} changes={shot.changes} />
      </div>
      {shot.note ? <div className="sec-f" style={{ fontSize: 13 }}>{shot.note}</div> : null}
    </Section>)}
    <Trail lane={lane} events={history} />
    <Files checkpoint={checkpoint} />
    <Decision lane={lane} checkpoint={checkpoint} decided={decided} />
  </>;
}

function Shot({ checkpoint, file, tag, label, changes }: { checkpoint: Checkpoint; file: string | null; tag: ReactNode; label: string; changes?: Checkpoint["screenshots"][number]["changes"] }) {
  const src = useImage(file ? `/api/checkpoints/${checkpoint.id}/shots/${file}` : null);
  const pct = (v: number, of: number) => `${(v / of) * 100}%`;
  const count = changes?.areas.length ?? 0;
  return <figure className="shot">
    <div className="frame"><div className="bar" />{src ? <div className="pic"><img src={src} alt={label} />{changes?.areas.map((a, i) => <span key={i} className="area" aria-hidden="true" style={{ left: pct(a.x, changes.width), top: pct(a.y, changes.height), width: pct(a.w, changes.width), height: pct(a.h, changes.height) }} />)}</div> : <div className="none">{file ? "Loading…" : "No picture"}</div>}</div>
    <figcaption className="cap">{tag}{label}{changes ? ` · ${count ? `${count} changed ${count === 1 ? "area" : "areas"}` : "no visible change"}` : ""}</figcaption>
  </figure>;
}

function Trail({ lane, events }: { lane: Lane; events: LaneEvent[] }) {
  const steps = useMemo(() => stepsFor(events).filter((s) => s.type === "tool" || s.type === "plan" || s.type === "check"), [events]);
  if (!steps.length) return null;
  return <Section title="How it got here" meta={`${steps.length} ${steps.length === 1 ? "step" : "steps"} · ${duration(steps[0]!.at, steps.at(-1)!.at)}`} end={<Link className="lnk" to={`/p/${lane.project}/work?lane=${encodeURIComponent(lane.id)}`}>All steps in Work →</Link>}>
    <div className="trail">
      {steps.slice(-40).map((s) => { const tile = <Tile key={s.seq} family={s.family} icon={s.tool ? iconFor(s.tool.kind) : s.type === "plan" ? "plan" : "test"} small label={s.title} />; return s.tool?.failedBefore ? <span key={s.seq} className="bad">{tile}</span> : tile; })}
      {steps.some((s) => s.tool?.failedBefore) ? <span className="key"><i aria-hidden="true" />failed, then fixed</span> : null}
    </div>
  </Section>;
}

function DiffLines({ text }: { text: string }) {
  return <div className="dfv">{text.split("\n").map((line, i) => <div key={i} className={/^(diff |index |--- |\+\+\+ )/.test(line) ? "meta" : line.startsWith("@@") ? "hunk" : line.startsWith("+") ? "add" : line.startsWith("-") ? "del" : ""}>{line || " "}</div>)}</div>;
}

function Bar({ added, removed }: { added: number; removed: number }) {
  const all = added + removed || 1;
  return <span className="diffbar" aria-hidden="true"><i className="a" style={{ width: `${added / all * 100}%` }} /><i className="d" style={{ width: `${removed / all * 100}%` }} /></span>;
}

function Files({ checkpoint }: { checkpoint: Checkpoint }) {
  const t = totals(checkpoint.files);
  const [open, setOpen] = useState<string | null>(null);
  const [diff, setDiff] = useState<{ key: string; text: string } | null>(null);
  const [error, setError] = useState("");
  const [more, setMore] = useState(false);
  const load = async (file: string | null) => {
    const key = file ?? "*";
    setError("");
    if (open === key) { setOpen(null); return; }
    setOpen(key);
    try { setDiff({ key, text: (await getJson<{ diff: string }>(`/api/checkpoints/${checkpoint.id}/diff${file === null ? "" : `?file=${encodeURIComponent(file)}`}`)).diff }); }
    catch (err) { setError(errorMessage(err)); }
  };
  const sorted = [...checkpoint.files].sort((a, b) => b.added + b.removed - a.added - a.removed);
  const shown = more ? sorted : sorted.slice(0, 3);
  const rest = sorted.slice(shown.length);
  const restTotal = totals(rest);
  return <Section title="Files" meta={`${checkpoint.files.length} · +${t.added} -${t.removed}`} end={<button className="btn ghost sm" aria-expanded={open === "*"} onClick={() => void load(null)}>{open === "*" ? "Close full diff" : "Open full diff"}</button>}>
    {error ? <p role="alert" className="sec-b">{error}</p> : null}
    {open === "*" && diff?.key === "*" ? <DiffLines text={diff.text} /> : null}
    {shown.map((file) => <div key={file.path}>
      <button className="frow" aria-expanded={open === file.path} onClick={() => void load(file.path)}><span>{file.path}</span><Bar added={file.added} removed={file.removed} /><span className="n"><i>+{file.added}</i> <em>-{file.removed}</em></span></button>
      {open === file.path && diff?.key === file.path ? <DiffLines text={diff.text} /> : null}
    </div>)}
    {rest.length ? <button className="frow" onClick={() => setMore(true)}><span>{rest.length} more {rest.length === 1 ? "file" : "files"}</span><Bar added={restTotal.added} removed={restTotal.removed} /><span className="n"><i>+{restTotal.added}</i> <em>-{restTotal.removed}</em></span></button> : null}
  </Section>;
}

function Decision({ lane, checkpoint, decided }: { lane: Lane; checkpoint: Checkpoint; decided: () => void }) {
  const [, , reloadInbox] = useInbox();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [asking, setAsking] = useState(false);
  const failing = checkpoint.checks.filter((c) => !c.passed).length;
  const send = async (path: string, body: unknown) => {
    setBusy(true); setError("");
    try { await postJson(`/api/lanes/${lane.id}/${path}`, body); setAsking(false); decided(); reloadInbox(); }
    catch (err) { setError(errorMessage(err)); }
    finally { setBusy(false); }
  };
  return <section className="sec" aria-label="Decision"><div className="rva">
    <button className="btn" disabled={busy} onClick={() => void send("approve", {})}>{busy && !asking ? "Rebasing and pushing…" : "Approve and merge"}</button>
    <button className="btn ghost" disabled={busy} onClick={() => setAsking(true)}>Request changes</button>
    {error && !asking ? <span role="alert" className="note">{error}</span> : failing ? <span className="note"><Glyph g="fail">{failing} {failing === 1 ? "check" : "checks"} failed</Glyph></span> : <span className="note">opens a pull request into {lane.base ?? "main"}</span>}
  </div>
  {asking ? <Dialog title="Request changes" meta={`back to ${AGENT_NAMES[lane.agent] ?? lane.agent} in this lane`} onClose={() => setAsking(false)}
    footer={<><button className="btn ghost" onClick={() => setAsking(false)}>Cancel</button><button className="btn" disabled={busy || !note.trim()} onClick={() => void send("request-changes", { note })}>Send to the agent</button></>}>
    <textarea className="in" rows={5} autoFocus aria-label="What should change" placeholder="What should change" value={note} onChange={(e) => setNote(e.target.value)} />
    {error ? <p role="alert" style={{ marginBottom: 0 }}>{error}</p> : null}
  </Dialog> : null}
  </section>;
}
