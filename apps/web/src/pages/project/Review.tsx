import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useParams, useSearchParams } from "react-router";
import type { Checkpoint, DetectedAgent, Lane, LaneEvent } from "@contextlanes/protocol";
import { apiFetch, errorMessage, getJson, postJson, useInbox, useJson, useImage } from "../../api";
import { useProjectWork } from "../../components/Shell";
import { AGENT_NAMES, AgentMark, Dialog, Empty, Fact, Glyph, LaneBadge, Section, laneNumber, agoText } from "../../components/ui";
import { loadHistory, stepsFor } from "../../work/model";

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

/** Collisions this lane is still in, from its own events. */
export function sharing(events: LaneEvent[], lane: string): { module: string; others: string[] }[] {
  const open = new Map<string, string[]>();
  for (const e of events) {
    if (e.type === "collision.detected") open.set(e.payload.module, e.payload.lanes.filter((l) => l !== lane));
    else if (e.type === "collision.cleared") open.delete(e.payload.module);
  }
  return [...open].map(([module, others]) => ({ module, others }));
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
  const changes = events.filter((e) => e.type === "checkpoint.created" || e.type === "checkpoint.decided" || e.type === "checkpoint.judged").length;
  useEffect(reload, [reload, changes]);
  const latest = (lane: string) => checkpoints?.find((c) => c.lane === lane);
  const ready = lanes.filter((l) => l.state === "in_review" && latest(l.id));
  const waiting = lanes.filter((l) => l.state === "needs_you" || l.state === "working");
  const lane = ready.find((l) => l.id === params.get("lane")) ?? ready[0] ?? null;
  const checkpoint = lane ? latest(lane.id)! : null;
  const number = checkpoint ? checkpoints!.filter((c) => c.lane === checkpoint.lane).length : 0;
  return <div className="rvw">
    <aside className="rvl" aria-label="Checkpoints">
      <div>
        <span className="lbl">Ready <span>{ready.length}</span></span>
        {ready.map((l) => { const c = latest(l.id)!; const t = totals(c.files); return <button key={l.id} className={`rvi${l.id === lane?.id ? " on" : ""}`} aria-current={l.id === lane?.id ? "true" : undefined} onClick={() => setParams({ lane: l.id })}>
          <LaneBadge id={l.id} colour={l.colour} /><b>{l.task}</b>{(() => { const [g, word] = mark(c); return <i className={`g ${g}`} role="img" aria-label={word} title={word} />; })()}<small>+{t.added} -{t.removed} · {c.files.length} {c.files.length === 1 ? "file" : "files"}</small>
        </button>; })}
        {checkpoints && !ready.length ? <Glyph g="idle">None ready</Glyph> : null}
      </div>
      {waiting.length ? <div>
        <span className="lbl">Not ready <span>{waiting.length}</span></span>
        {waiting.map((l) => <Link key={l.id} className="rvi" to={`/p/${project}/work?lane=${encodeURIComponent(l.id)}`}><LaneBadge id={l.id} colour={l.colour} /><b>{l.task}</b><i className={`g ${l.state === "needs_you" ? "wait" : "work"}`} role="img" aria-label={l.state === "needs_you" ? "Needs you" : "Working"} /><small>{l.state === "needs_you" ? "needs you" : "working"}</small></Link>)}
      </div> : null}
    </aside>
    <main className="rvm" aria-label="Checkpoint">
      {error ? <p role="alert">{error.message} <button className="btn ghost sm" onClick={reload}>Try again</button></p> : null}
      {lane && checkpoint ? <Packet key={checkpoint.id} lane={lane} checkpoint={checkpoint} number={number} decided={reload} parent={lanes.find((l) => l.id !== lane.id && l.branch === lane.base && ["working", "needs_you", "in_review", "setting_up"].includes(l.state)) ?? null} />
        : <section className="sec"><Empty icon="checkpoint" family="you">Nothing to review</Empty>
          <div className="sec-r"><ol className="flow" aria-label="How work reaches review"><li>Agent works in a lane</li><li>Ask for review</li><li>Checks and screenshots</li><li>You merge or send back</li></ol></div></section>}
    </main>
  </div>;
}

const VERDICT = { merge: ["done", "Merge"], "fix first": ["wait", "Fix first"], "do not merge": ["fail", "Don't merge"] } as const;
const SEVERITY = { blocker: ["fail", "Blocker"], "should fix": ["wait", "Should fix"], nit: ["idle", "Nit"] } as const;

/** The left list's mark for a checkpoint: the judge's verdict when there is one, else whether the checks pass. */
function mark(c: Checkpoint): [string, string] {
  const j = c.judge;
  if (j?.state === "done" && j.verdict) return [VERDICT[j.verdict][0], VERDICT[j.verdict][1]];
  if (j?.state === "running") return ["think", "Judging"];
  return clean(c) ? ["done", "Checks pass"] : ["wait", "Look closer"];
}

function Packet({ lane, checkpoint, number, decided, parent }: { lane: Lane; checkpoint: Checkpoint; number: number; decided: () => void; parent: Lane | null }) {
  const [history, setHistory] = useState<LaneEvent[]>([]);
  useEffect(() => {
    const abort = new AbortController();
    void loadHistory(lane.id, apiFetch, abort.signal).then(setHistory, () => {});
    return () => abort.abort();
  }, [lane.id]);
  // A finding opens its file's diff below.
  const [focus, setFocus] = useState<{ file: string; n: number } | null>(null);
  const shots = checkpoint.screenshots;
  const base = lane.base ?? "main";
  const steps = useMemo(() => stepsFor(history).filter((s) => s.type === "tool"), [history]);
  return <>
    <header className="rvh">
      <div className="who"><LaneBadge id={lane.id} colour={lane.colour} /><AgentMark agent={lane.agent} small />{lane.branch} → {base} · {AGENT_NAMES[lane.agent] ?? lane.agent}
        {steps.length ? <> · <Link className="lnk" to={`/p/${lane.project}/work?lane=${encodeURIComponent(lane.id)}`}>{steps.length} steps over {duration(steps[0]!.at, steps.at(-1)!.at)} →</Link></> : null}</div>
      <h1>{lane.task} · checkpoint {number}</h1>
      <p>{checkpoint.summary}</p>
    </header>
    <Verdict checkpoint={checkpoint} open={(file) => setFocus((f) => ({ file, n: (f?.n ?? 0) + 1 }))} />
    <Evidence lane={lane} checkpoint={checkpoint} history={history} />
    {shots.map((shot) => <Section key={shot.path} title="Before and after" meta={`${shot.path} · ${clock(checkpoint.createdAt)}`} end={shot.url ? <a className="lnk mono" href={shot.url} target="_blank" rel="noreferrer">{new URL(shot.url).host} ↗</a> : undefined}>
      <div className="ba">
        <Shot checkpoint={checkpoint} file={shot.before} tag={<span className="fchip">{base}</span>} label={`Before this lane`} />
        <Shot checkpoint={checkpoint} file={shot.after} tag={<span className={`lb ${lane.colour}`}>lane {lane.id.slice(lane.id.lastIndexOf("/") + 1)}</span>} label={`${checkpoint.files.length} changed ${checkpoint.files.length === 1 ? "file" : "files"}`} changes={shot.changes} />
      </div>
      {shot.note ? <div className="sec-f" style={{ fontSize: 13 }}>{shot.note}</div> : null}
    </Section>)}
    {checkpoint.secondReview ? <SecondReview review={checkpoint.secondReview} project={lane.project} /> : null}
    <Files checkpoint={checkpoint} focus={focus} />
    <Decision lane={lane} checkpoint={checkpoint} decided={decided} parent={parent} />
  </>;
}

/** The local judge's read of the change: verdict, one line, and the findings to look at. */
function Verdict({ checkpoint, open }: { checkpoint: Checkpoint; open: (file: string) => void }) {
  const j = checkpoint.judge;
  const [error, setError] = useState("");
  const again = () => { setError(""); void postJson(`/api/checkpoints/${checkpoint.id}/judge`, {}).catch((e) => setError(errorMessage(e))); };
  const decided = !!checkpoint.decision;
  const button = !decided && j?.state !== "running" ? <button className="btn ghost sm" onClick={again}>{j ? "Judge again" : "Judge it"}</button> : undefined;
  if (!j || j.state === "off") return <Section title="Verdict" end={j ? <Link className="btn ghost sm" to="/models">Add a local model</Link> : button}>
    <Empty icon="think" family="mind">{j ? "No local model to judge it" : "Not judged"}</Empty></Section>;
  if (j.state === "running") return <Section title="Verdict" meta={`${j.model ?? "local model"} is reading the change`}><div className="sec-r"><Glyph g="think">Judging</Glyph></div></Section>;
  if (j.state === "failed") return <Section title="Verdict" meta={j.model ?? undefined} end={button}>
    <div className="sec-r"><Fact g="fail" detail={agoText(j.at)}>Could not judge</Fact></div>
    {j.error ? <div className="sec-b muted" style={{ fontSize: 13, paddingTop: 0 }}>{j.error}</div> : null}
    {error ? <p role="alert" className="sec-b">{error}</p> : null}</Section>;
  const [g, word] = VERDICT[j.verdict ?? "fix first"];
  return <Section title="Verdict" meta={`${j.model ?? "local model"} · ${agoText(j.at)}`} help="A local model read the diff, plan and checks. It never merges; you decide. Each finding names a file in the change, and a 'merge' is lowered when checks failed or it found a blocker." end={button}>
    <div className="sec-r" style={{ gap: 14, flexWrap: "wrap" }}><span style={{ fontSize: 17, fontWeight: 700 }}><Glyph g={g}>{word}</Glyph></span>{j.headline ? <span style={{ fontSize: 15, minWidth: 0, flex: "1 1 320px" }}>{j.headline}</span> : null}</div>
    {j.findings.map((f, i) => { const [fg, fw] = SEVERITY[f.severity]; return <div className={`rvr${f.severity === "blocker" ? " you" : ""}`} key={i}>
      <span style={{ minWidth: 92, alignSelf: "flex-start", paddingTop: 1 }}><Glyph g={fg}>{fw}</Glyph></span>
      <span style={{ flex: 1 }}>{f.text}<button className="lnk mono" style={{ display: "block", fontSize: 12, marginTop: 3, textAlign: "left", overflowWrap: "anywhere" }} onClick={() => open(f.file)}>{f.file}{f.line ? `:${f.line}` : ""}</button></span>
    </div>; })}
    {!j.findings.length ? <div className="rvr"><Fact g="done">Nothing to flag</Fact></div> : null}
    {j.skipped.length ? <div className="sec-f muted" style={{ fontSize: 12.5 }}>Not read: {j.skipped.slice(0, 4).join(", ")}{j.skipped.length > 4 ? ` and ${j.skipped.length - 4} more` : ""}</div> : null}
    {error ? <p role="alert" className="sec-b">{error}</p> : null}
  </Section>;
}

/** What was measured, in one place: checks, preview, tests after the last edit, plan, shared modules. */
function Evidence({ lane, checkpoint, history }: { lane: Lane; checkpoint: Checkpoint; history: LaneEvent[] }) {
  const [plan, setPlan] = useState(false);
  const shots = checkpoint.screenshots;
  const previewed = shots.some((s) => s.after);
  const done = checkpoint.plan.filter((p) => p.status === "completed").length;
  const tested = checkpoint.process.find((p) => p.label.startsWith("Ran the tests"));
  const shared = sharing(history, lane.id);
  return <Section title="Evidence" meta={`${checkpoint.checks.length} ${checkpoint.checks.length === 1 ? "check" : "checks"}${checkpoint.plan.length ? ` · plan ${done} of ${checkpoint.plan.length}` : ""}`}>
    {checkpoint.checks.map((check) => <CheckRow key={check.name} check={check} />)}
    {!checkpoint.checks.length ? <div className="rvr"><Fact g="idle" detail="add them to the recipe on Run">No checks</Fact></div> : null}
    {tested ? <div className="rvr"><i className={`g ${tested.ok ? "done" : "wait"}`} role="img" aria-label={tested.ok ? "Yes" : "No"} /><span>{tested.ok ? "Tests ran after the last change" : "No tests after the last change"}</span></div> : null}
    {shots.length ? <div className="rvr"><i className={`g ${previewed ? "done" : "wait"}`} role="img" aria-label={previewed ? "Passed" : "Look closer"} /><span>{previewed ? "Preview works" : "No preview picture"}</span><span className="r">{clock(checkpoint.createdAt)}</span></div> : null}
    {checkpoint.plan.length ? <button className="frow" style={{ fontFamily: "inherit", fontSize: 14 }} aria-expanded={plan} onClick={() => setPlan(!plan)}><i className={`g ${done === checkpoint.plan.length ? "done" : "wait"}`} aria-hidden="true" /><span>Plan {done} of {checkpoint.plan.length} done</span><span className="n muted" style={{ marginLeft: "auto" }}>{plan ? "hide" : "show"}</span></button>
      : <div className="rvr"><Fact g="idle">No plan written</Fact></div>}
    {plan ? checkpoint.plan.map((p, i) => <div className="rvr" key={i} style={{ paddingLeft: 38 }}><i className={`g ${p.status === "completed" ? "done" : p.status === "in_progress" ? "think" : "idle"}`} role="img" aria-label={p.status.replace("_", " ")} /><span>{p.text}</span></div>) : null}
    {checkpoint.unplanned.length ? <div className="rvr you"><i className="g wait" role="img" aria-label="Look closer" /><span>Not in the plan: {checkpoint.unplanned.slice(0, 3).join(", ")}{checkpoint.unplanned.length > 3 ? ` and ${checkpoint.unplanned.length - 3} more` : ""}</span></div> : null}
    {shared.map((c) => <div className="rvr" key={c.module}><i className="g wait" role="img" aria-label="Look closer" /><span>Shares {c.module} with {c.others.map(laneNumber).join(" and ")}</span><span className="r"><Link className="lnk" to={`/p/${lane.project}/architecture`}>Architecture →</Link></span></div>)}
  </Section>;
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

function DiffLines({ text }: { text: string }) {
  return <div className="dfv">{text.split("\n").map((line, i) => <div key={i} className={/^(diff |index |--- |\+\+\+ )/.test(line) ? "meta" : line.startsWith("@@") ? "hunk" : line.startsWith("+") ? "add" : line.startsWith("-") ? "del" : ""}>{line || " "}</div>)}</div>;
}

function Bar({ added, removed }: { added: number; removed: number }) {
  const all = added + removed || 1;
  return <span className="diffbar" aria-hidden="true"><i className="a" style={{ width: `${added / all * 100}%` }} /><i className="d" style={{ width: `${removed / all * 100}%` }} /></span>;
}

function Files({ checkpoint, focus }: { checkpoint: Checkpoint; focus: { file: string; n: number } | null }) {
  const t = totals(checkpoint.files);
  const [open, setOpen] = useState<string | null>(null);
  const [diff, setDiff] = useState<{ key: string; text: string } | null>(null);
  const wanted = useRef<string | null>(null);
  const [error, setError] = useState("");
  const [more, setMore] = useState(false);
  const load = async (file: string | null) => {
    const key = file ?? "*";
    setError("");
    if (open === key) { setOpen(null); return; }
    setOpen(key);
    wanted.current = key;
    try {
      const text = (await getJson<{ diff: string }>(`/api/checkpoints/${checkpoint.id}/diff${file === null ? "" : `?file=${encodeURIComponent(file)}`}`)).diff;
      // A slower answer for a file clicked earlier must not replace the one open now.
      if (wanted.current === key) setDiff({ key, text });
    } catch (err) { if (wanted.current === key) setError(errorMessage(err)); }
  };
  // Biggest first, with lockfiles and build output last: large, generated, and rarely what to read.
  const generated = (p: string) => /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|Cargo\.lock|poetry\.lock|uv\.lock|go\.sum)$|(^|\/)(dist|build|vendor)\/|\.(min\.(js|css)|map|snap)$/.test(p);
  const sorted = [...checkpoint.files].sort((a, b) => Number(generated(a.path)) - Number(generated(b.path)) || b.added + b.removed - a.added - a.removed);
  // A finding's file opens here and scrolls into view.
  useEffect(() => {
    if (!focus) return;
    if (!sorted.slice(0, 3).some((f) => f.path === focus.file)) setMore(true);
    if (open !== focus.file) void load(focus.file);
    requestAnimationFrame(() => document.getElementById(`file-${focus.file}`)?.scrollIntoView({ behavior: "smooth", block: "start" }));
  }, [focus]); // eslint-disable-line react-hooks/exhaustive-deps
  const shown = more ? sorted : sorted.slice(0, 3);
  const rest = sorted.slice(shown.length);
  const restTotal = totals(rest);
  return <Section title="Files" meta={`${checkpoint.files.length} · +${t.added} -${t.removed}`} end={<button className="btn ghost sm" aria-expanded={open === "*"} onClick={() => void load(null)}>{open === "*" ? "Close full diff" : "Open full diff"}</button>}>
    {error ? <p role="alert" className="sec-b">{error}</p> : null}
    {open === "*" && diff?.key === "*" ? <DiffLines text={diff.text} /> : null}
    {shown.map((file) => <div key={file.path} id={`file-${file.path}`} style={{ scrollMarginTop: 16 }}>
      <button className="frow" aria-expanded={open === file.path} onClick={() => void load(file.path)}><span>{file.path}</span><Bar added={file.added} removed={file.removed} /><span className="n"><i>+{file.added}</i> <em>-{file.removed}</em></span></button>
      {open === file.path && diff?.key === file.path ? <DiffLines text={diff.text} /> : null}
    </div>)}
    {rest.length ? <button className="frow" onClick={() => setMore(true)}><span>{rest.length} more {rest.length === 1 ? "file" : "files"}</span><Bar added={restTotal.added} removed={restTotal.removed} /><span className="n"><i>+{restTotal.added}</i> <em>-{restTotal.removed}</em></span></button> : null}
  </Section>;
}

/** The other agent's review, as a section of the packet. */
function SecondReview({ review, project }: { review: NonNullable<Checkpoint["secondReview"]>; project: string }) {
  const name = AGENT_NAMES[review.agent] ?? review.agent;
  return <Section title={`Second review · ${name}`} meta={review.state === "running" ? "reading the change, read-only" : agoText(review.at)} end={<Link className="lnk" to={`/p/${project}/work?lane=${encodeURIComponent(review.lane)}`}>Its steps →</Link>}>
    <div className="sec-b">{review.state === "running" ? <span className="muted">{name} is reviewing in lane {review.lane.slice(review.lane.lastIndexOf("/") + 1)}. Its findings appear here when it finishes.</span>
      : review.text ? <div style={{ whiteSpace: "pre-wrap", fontSize: 14, lineHeight: 1.55 }}>{review.text}</div> : <span role="alert">{name} finished without writing a review.</span>}</div>
  </Section>;
}

function Decision({ lane, checkpoint, decided, parent }: { lane: Lane; checkpoint: Checkpoint; decided: () => void; parent: Lane | null }) {
  const [, , reloadInbox] = useInbox();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [asking, setAsking] = useState(false);
  const failing = checkpoint.checks.filter((c) => !c.passed).length;
  const [agents] = useJson<DetectedAgent[]>("/api/setup/agents");
  const reviewer = (agents ?? []).find((a) => a.status === "Ready" && a.id !== lane.agent && a.id !== "opencode")?.id ?? (agents ?? []).find((a) => a.status === "Ready" && a.id !== lane.agent)?.id ?? null;
  const [estimate] = useJson<{ tokens: number }>(reviewer && !checkpoint.secondReview ? `/api/checkpoints/${checkpoint.id}/second-review` : null);
  const send = async (path: string, body: unknown) => {
    setBusy(true); setError("");
    try { await postJson(`/api/lanes/${lane.id}/${path}`, body); setAsking(false); decided(); reloadInbox(); }
    catch (err) { setError(errorMessage(err)); }
    finally { setBusy(false); }
  };
  return <section className="sec" aria-label="Decision"><div className="rva">
    <button className={`btn${checkpoint.judge?.verdict && checkpoint.judge.verdict !== "merge" ? " ghost" : ""}`} disabled={busy} onClick={() => void send("approve", {})}>{busy && !asking ? parent ? "Sending to the parent…" : "Rebasing and pushing…" : parent ? `Approve into lane ${laneNumber(parent.id)}` : "Approve and merge"}</button>
    <button className="btn ghost" disabled={busy} onClick={() => {
      // The judge's blockers and should-fixes start the note, one per line; edit before sending.
      const found = (checkpoint.judge?.findings ?? []).filter((f) => f.severity !== "nit");
      if (!note.trim() && found.length) setNote(found.map((f) => `- ${f.file}${f.line ? `:${f.line}` : ""}: ${f.text}`).join("\n"));
      setAsking(true);
    }}>Request changes</button>
    {reviewer && !checkpoint.secondReview ? <button className="btn ghost" disabled={busy} onClick={() => void postJson(`/api/checkpoints/${checkpoint.id}/second-review`, { agent: reviewer }).then(decided, (e) => setError(errorMessage(e)))}>Ask {AGENT_NAMES[reviewer] ?? reviewer} to review</button> : null}
    {error && !asking ? <span role="alert" className="note">{error}</span> : reviewer && !checkpoint.secondReview && estimate ? <span className="note mono">second review ≈ {Math.round(estimate.tokens / 1000)}k tokens</span> : failing ? <span className="note"><Glyph g="fail">{failing} {failing === 1 ? "check" : "checks"} failed</Glyph></span> : <span className="note">{parent ? `lane ${laneNumber(parent.id)}'s agent merges it into its branch` : `opens a pull request into ${lane.base ?? "main"}`}</span>}
  </div>
  {asking ? <Dialog title="Request changes" meta={`back to ${AGENT_NAMES[lane.agent] ?? lane.agent} in this lane`} onClose={() => setAsking(false)}
    footer={<><button className="btn ghost" onClick={() => setAsking(false)}>Cancel</button><button className="btn" disabled={busy || !note.trim()} onClick={() => void send("request-changes", { note })}>Send to the agent</button></>}>
    <textarea className="in" rows={5} autoFocus aria-label="What should change" placeholder="What should change" value={note} onChange={(e) => setNote(e.target.value)} />
    {error ? <p role="alert" style={{ marginBottom: 0 }}>{error}</p> : null}
  </Dialog> : null}
  </section>;
}
