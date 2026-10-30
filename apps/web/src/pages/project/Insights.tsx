import { useState } from "react";
import { Link, useParams } from "react-router";
import type { InsightsView, Project, ProjectSkill, Suggestion } from "@contextlanes/protocol";
import { errorMessage, getJson, postJson, useJson } from "../../api";
import { useProjectWork } from "../../components/Shell";
import { NewLaneDialog } from "../../components/NewLane";
import { Empty, LaneBadge, PageHeader, Section, Tile, agoText, type IconName } from "../../components/ui";

const TYPES: Record<Suggestion["type"], [string, IconName]> = { process: ["Process", "message"], code: ["Code", "edit"], tokens: ["Tokens", "read"], next: ["Next", "checkpoint"], notes: ["Notes", "plan"] };
const k = (n: number) => n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 10_000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
const day = (iso: string) => new Date(iso).toLocaleDateString([], { month: "short", day: "numeric" });

/**
 * Insights (insights.webp): the week's numbers, computed from the event log, then what the local model
 * makes of them. Each sentence and suggestion cites the numbers it used; nothing is applied without a click.
 */
export function InsightsPage() {
  const { project = "" } = useParams();
  const work = useProjectWork();
  const [view, error, reload] = useJson<InsightsView>(`/api/projects/${project}/insights`);
  const [projects] = useJson<Project[]>("/api/projects");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [filter, setFilter] = useState<Suggestion["type"] | "all">("all");
  const [notes, setNotes] = useState<string | null>(null);
  const [starting, setStarting] = useState<string | null>(null);
  const regenerate = () => { setBusy(true); setMessage(""); void postJson(`/api/projects/${project}/insights`, {}).then(reload, (e) => setMessage(errorMessage(e))).finally(() => setBusy(false)); };
  if (error) return <main className="pg"><PageHeader title="Insights" /><Section title="This week"><Empty>{error.message}</Empty></Section></main>;
  if (!view) return <main className="pg"><PageHeader title="Insights" /><Section title="This week"><Empty>Counting the week…</Empty></Section></main>;
  const stat = (id: string) => view.stats.find((s) => s.id === id);
  const shown = view.suggestions.filter((s) => filter === "all" || s.type === filter);
  const act = (s: Suggestion) => {
    const a = s.action;
    if (a.kind === "start_lane") return setStarting(a.task);
    if (a.kind === "fix_note") return void openNotes();
    if (a.kind === "add_note") return void addNote(a.text).catch((e) => setMessage(errorMessage(e)));
    if (a.kind === "allow_helper") return void postJson("/api/helper", { kind: a.helper, on: true }).then(() => setMessage(`The local helper's ${a.helper} is on.`), (e) => setMessage(errorMessage(e)));
  };
  const openNotes = async () => setNotes((await getJson<{ text: string }>(`/api/projects/${project}/notes`)).text);
  const addNote = async (text: string) => {
    const current = await getJson<{ text: string }>(`/api/projects/${project}/notes`);
    await postJson(`/api/projects/${project}/notes`, { text: `${current.text.trim()}\n${text}`.trim() }, "PUT");
    setMessage("Added to project notes. New lanes start with it."); reload();
  };
  const totalToday = view.today.reduce((n, t) => n + t.tokens, 0);
  return <main className="pg stack">
    <PageHeader title="Insights" meta="what the last week of lanes says about this project, and what to do about it"
      end={<span className="mono muted" style={{ fontSize: 12 }}>{view.model ? `written by ${view.model}${view.generatedAt ? ` · ${agoText(view.generatedAt)}` : ""}` : view.canWrite ? "not written yet" : "no local model"} · nightly and after each merge</span>} />
    <Section title="This week" meta={`${day(view.week.from)} – ${day(view.week.to)} · from ${view.week.events} lane events, ${view.week.merges} ${view.week.merges === 1 ? "merge" : "merges"}, CodeGraph`}
      end={view.canWrite ? <button className="btn ghost sm" disabled={busy} onClick={regenerate}>{busy ? "Writing…" : view.generatedAt ? "Regenerate" : "Write it now"}</button> : <Link className="lnk" to="/models">Add a local model →</Link>}>
      <div className="wk">
        <div className="sum">
          {view.summary.length ? view.summary.map((s, i) => <p key={i}>{s.text}{s.cites.map((c) => { const st = stat(c); return st ? <span className="cite" key={c} title={st.detail}>{st.value} {st.label}</span> : null; })}</p>)
            : <p className="muted" style={{ fontSize: 14 }}>{view.canWrite ? "No summary yet. Write it now, or wait for tonight's run." : "The numbers on the right are counted from the event log. A local model writes the summary and suggestions; add one under Models."}</p>}
          {message ? <p role="status" style={{ fontSize: 13 }}>{message}</p> : null}
        </div>
        <div className="facts4">
          <div><b>{view.facts.merges}</b><span>{view.facts.merges === 1 ? "merge" : "merges"}</span></div>
          <div><b>{k(view.facts.cloudTokens)}</b><span>cloud tokens</span></div>
          {view.facts.localShare === null ? null : <div><b>{Math.round(view.facts.localShare * 100)}%</b><span>of tokens on your GPUs</span></div>}
          {view.facts.medianWaitMinutes === null ? null : <div><b>{Math.round(view.facts.medianWaitMinutes)}m</b><span>median wait for you</span></div>}
        </div>
      </div>
    </Section>
    <Section title="Suggestions" meta={view.suggestions.length ? `${view.suggestions.length} · biggest first · each cites what it saw` : undefined}
      end={view.suggestions.length ? <div className="seg" role="group" aria-label="Show">{(["all", "process", "code", "tokens", "notes"] as const).map((f) => <button key={f} className={filter === f ? "on" : ""} aria-pressed={filter === f} onClick={() => setFilter(f)}>{f === "all" ? "All" : TYPES[f][0]}</button>)}</div> : undefined}>
      {!shown.length ? <Empty>{view.generatedAt ? "Nothing to suggest from this week." : "Suggestions appear once insights are written."}</Empty> : shown.map((s) => { const st = stat(s.stat); const [word, icon] = TYPES[s.type]; return <div className="sug" key={s.id}>
        <span className="ty"><Tile family="you" icon={icon} small />{word}</span>
        <span><b style={{ fontSize: 14.5 }}>{s.title}</b><span className="muted" style={{ display: "block", fontSize: 13.5 }}>{s.body}</span></span>
        <span className="m" title={st?.detail}><b>{st?.value ?? ""}</b><span>{st?.label}</span></span>
        <span>{s.action.kind === "add_note" ? <button className="btn sm" onClick={() => act(s)}>Add to notes</button>
          : s.action.kind === "start_lane" ? <button className="btn ghost sm" onClick={() => act(s)}>Start a lane</button>
          : s.action.kind === "allow_helper" ? <button className="btn sm" onClick={() => act(s)}>Allow</button>
          : s.action.kind === "review" ? <Link className="btn ghost sm" to={`/p/${project}/review?lane=${encodeURIComponent(s.action.lane)}`}>Review</Link>
          : <button className="btn ghost sm" onClick={() => act(s)}>Fix note</button>}</span>
        <button className="x" aria-label={`Dismiss: ${s.title}`} onClick={() => void postJson(`/api/projects/${project}/insights/${s.id}/dismiss`, {}).then(reload)}>×</button>
      </div>; })}
    </Section>
    <Section title="Usage today" meta={view.today.length ? `${k(totalToday)} tokens` : undefined}>
      {!view.today.length ? <Empty>No agent turns reported usage today.</Empty> : view.today.map((t) => { const lane = work.lanes.find((l) => l.id === t.lane); const pct = totalToday ? t.tokens / Math.max(...view.today.map((x) => x.tokens)) : 0; return <div className="urow2" key={t.lane}>
        <span style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>{lane ? <LaneBadge id={lane.id} colour={lane.colour} /> : null}<b style={{ fontSize: 14, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t.task}</b></span>
        <span className="ubar" aria-hidden="true" style={{ width: `${Math.max(4, pct * 100)}%` }}><i className="c" style={{ width: `${(t.cacheShare ?? 0) * 100}%` }} /><i className="f" style={{ width: `${(1 - (t.cacheShare ?? 0)) * 100}%` }} /></span>
        <span className="mono" style={{ textAlign: "right" }}><b>{k(t.tokens)}</b>{t.cacheShare !== null ? <span className="muted"> {Math.round(t.cacheShare * 100)}% cache</span> : null}</span>
      </div>; })}
      <div className="sec-f muted" style={{ fontSize: 12.5 }}>Dark is new input and output; grey is read from the agent's cache. The agents do not report how their context splits into rules, tools, files and conversation, so that breakdown is not shown.</div>
    </Section>
    <Section title="What every lane starts with" meta="kept short on purpose">
      <div className="sec-r wrap"><Tile family="mind" icon="plan" small /><span className="grow"><b>Project notes</b><span className="muted" style={{ display: "block", fontSize: 13 }}>{view.startsWith.notes.facts ? `${view.startsWith.notes.facts} ${view.startsWith.notes.facts === 1 ? "line" : "lines"}, put before every new lane's task` : "None yet. Facts every lane should know, like \"match times are UTC\"."}</span></span><span className="mono muted" style={{ fontSize: 12 }}>{view.startsWith.notes.tokens ? `≈ ${k(view.startsWith.notes.tokens)}` : ""}</span><button className="btn ghost sm" onClick={() => void openNotes()}>Edit</button></div>
      {notes !== null ? <div className="sec-b"><textarea className="in" rows={8} value={notes} maxLength={8000} onChange={(e) => setNotes(e.target.value)} aria-label="Project notes" />
        <div style={{ display: "flex", gap: 8, marginTop: 8 }}><button className="btn sm" onClick={() => void postJson(`/api/projects/${project}/notes`, { text: notes }, "PUT").then(() => { setNotes(null); reload(); }, (e) => setMessage(errorMessage(e)))}>Save</button><button className="btn ghost sm" onClick={() => setNotes(null)}>Cancel</button></div></div> : null}
      <div className="sec-r wrap"><Tile family="look" icon="read" small /><span className="grow"><b>Module briefs</b><span className="muted" style={{ display: "block", fontSize: 13 }}>{view.startsWith.briefs} written, rebuilt when their files change; agents ask with get_brief</span></span><span className="mono muted" style={{ fontSize: 12 }}>on demand</span><Link className="btn ghost sm" to={`/p/${project}/architecture`}>Architecture</Link></div>
      <SkillsBlock project={project} />
    </Section>
    {starting && projects ? <NewLaneDialog projects={projects} project={project} task={starting} onClose={() => setStarting(null)} /> : null}
  </main>;
}

/** Shared skills (4.6): SKILL.md files copied into each new lane where its agent reads them. */
function SkillsBlock({ project }: { project: string }) {
  const [skills, , reload] = useJson<ProjectSkill[]>(`/api/projects/${project}/skills`);
  const [editing, setEditing] = useState<ProjectSkill | null>(null);
  const [error, setError] = useState<string | null>(null);
  const blank = { name: "", description: "", body: "" };
  const save = async (form: HTMLFormElement) => {
    const d = new FormData(form);
    try { await postJson(`/api/projects/${project}/skills`, { name: d.get("name"), description: d.get("description"), body: d.get("body") }, "PUT"); setEditing(null); setError(null); reload(); }
    catch (e) { setError(errorMessage(e)); }
  };
  const remove = async (name: string) => { try { await postJson(`/api/projects/${project}/skills/${name}`, {}, "DELETE"); reload(); } catch (e) { setError(errorMessage(e)); } };
  return <>
    <div className="sec-r wrap"><Tile family="run" icon="checkpoint" small /><span className="grow"><b>Skills</b><span className="muted" style={{ display: "block", fontSize: 13 }}>{skills?.length ? `${skills.length} copied into every new lane: .claude/skills for Claude Code, .agents/skills for Codex and OpenCode, kept out of git` : "None yet. Steps an agent loads only when the task needs them, like how to cut a release."}</span></span><button className="btn ghost sm" onClick={() => setEditing(blank)}>Add</button></div>
    {skills?.map((s) => <div className="sec-r wrap sub" key={s.name}><span className="grow"><b className="mono" style={{ fontSize: 13 }}>{s.name}</b><span className="muted" style={{ display: "block", fontSize: 13 }}>{s.description}</span></span><button className="btn ghost sm" onClick={() => setEditing(s)}>Edit</button><button className="btn ghost sm" onClick={() => void remove(s.name)}>Remove</button></div>)}
    {editing ? <form className="sec-b" onSubmit={(e) => { e.preventDefault(); void save(e.currentTarget); }}>
      <div className="two"><label className="field">Name <span className="hint">lowercase, digits and dashes</span><input className="in" name="name" required pattern="[a-z0-9][a-z0-9-]{0,40}" defaultValue={editing.name} readOnly={!!editing.name} /></label>
        <label className="field">When to use it <span className="hint">the agent reads this to decide</span><input className="in" name="description" required maxLength={300} defaultValue={editing.description} /></label></div>
      <label className="field">Instructions<textarea className="in" name="body" rows={8} required maxLength={20000} defaultValue={editing.body} /></label>
      {error ? <p className="muted" role="alert">{error}</p> : null}
      <div style={{ display: "flex", gap: 8, marginTop: 8 }}><button className="btn sm" type="submit">Save</button><button className="btn ghost sm" type="button" onClick={() => { setEditing(null); setError(null); }}>Cancel</button></div>
    </form> : null}
  </>;
}
