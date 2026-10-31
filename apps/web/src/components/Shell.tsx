import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Link, NavLink, Outlet, useMatch, useNavigate, useOutletContext, useParams } from "react-router";
import type { AskAnswer, Health, Lane, Project, ProjectBranches, ProjectEnvironments } from "@contextlanes/protocol";
import { errorMessage, postJson, useJson, useLiveInbox, InboxContext, useInbox } from "../api";
import { useWork } from "../work/useWork";
import { READY } from "../features";
import { AgentMark, Dialog, Glyph, LaneBadge, StateGlyph, coverFor } from "./ui";

export function Shell() {
  const [health, down, recheck] = useJson<Health>("/api/health");
  // The machine dot follows the daemon: checked every 30 seconds, so a stopped daemon shows as offline.
  useEffect(() => { const t = setInterval(recheck, 30_000); return () => clearInterval(t); }, [recheck]);
  const inboxQuery = useLiveInbox();
  const [inbox] = inboxQuery;
  const [jump, setJump] = useState(false);
  const inProject = useMatch("/p/*") !== null;
  useEffect(() => {
    const key = (event: KeyboardEvent) => { if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") { event.preventDefault(); setJump(true); } };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, []);
  return (
    <InboxContext.Provider value={inboxQuery}>
      <header className="top">
        <NavLink className="wm" to="/">Context<span className="ln">Lanes</span></NavLink>
        <nav className="gnav" aria-label="Main">
          <NavLink to="/" end className={({ isActive }) => isActive || inProject ? "active" : ""}>Projects</NavLink>
          <NavLink to="/inbox">Inbox{inbox?.length ? <span className="ib">{inbox.length}</span> : null}</NavLink>
          <NavLink to="/models">Models</NavLink>
          <NavLink to="/settings">Settings</NavLink>
        </nav>
        <button className="ask" onClick={() => setJump(true)}>Ask, jump or start a lane<span className="kbd">⌘K</span></button>
        <span className={`host${down ? " down" : ""}`} title={down ? "Daemon not reachable" : "Machine online"}><i />{health?.host ?? "…"}</span>
      </header>
      {jump ? <JumpDialog onClose={() => setJump(false)} /> : null}
      <Outlet />
    </InboxContext.Provider>
  );
}

/** ⌘K: jump to any project or lane, start a lane from what you typed, or ask about a project (local model). */
function JumpDialog({ onClose }: { onClose: () => void }) {
  const [projects] = useJson<Project[]>("/api/projects");
  const [lanes] = useJson<Lane[]>("/api/lanes");
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [answer, setAnswer] = useState<{ project: string; busy: boolean; result?: AskAnswer; error?: string } | null>(null);
  const navigate = useNavigate();
  const here = useMatch("/p/:project/*")?.params.project;
  const ask = (project: string) => { setAnswer({ project, busy: true }); void postJson<AskAnswer>(`/api/projects/${project}/ask`, { question: query }).then((result) => setAnswer({ project, busy: false, result }), (e) => setAnswer({ project, busy: false, error: errorMessage(e) })); };
  const items = useMemo(() => {
    const q = query.trim().toLowerCase();
    const match = (text: string) => !q || text.toLowerCase().includes(q);
    const list: { key: string; to: string; label: ReactNode; meta: string }[] = [];
    for (const lane of lanes ?? []) if (match(`${lane.task} ${lane.id}`)) list.push({ key: lane.id, to: `/p/${lane.project}/work?lane=${encodeURIComponent(lane.id)}`, label: <><LaneBadge id={lane.id} colour={lane.colour} /><AgentMark agent={lane.agent} small /><span>{lane.task}</span><StateGlyph state={lane.state} /></>, meta: lane.project });
    for (const project of projects ?? []) if (match(`${project.name} ${project.id}`)) {
      list.push({ key: `p:${project.id}`, to: `/p/${project.id}/work`, label: <span><b>{project.name}</b></span>, meta: "project" });
      list.push({ key: `n:${project.id}`, to: `/p/${project.id}/work?new=1`, label: <span>Start a lane in {project.name}</span>, meta: "new lane" });
    }
    if (match("add repository")) list.push({ key: "add", to: "/?add=1", label: <span>Add a repository</span>, meta: "projects" });
    // A sentence rather than a name: offer to ask about it, or to start a lane with it as the task.
    if (q.split(/\s+/).length >= 3) {
      const targets = (projects ?? []).filter((p) => !here || p.id === here).slice(0, 3);
      for (const p of targets) list.unshift({ key: `ask:${p.id}`, to: `ask:${p.id}`, label: <span>Ask about {p.name}: <b>{query.trim()}</b></span>, meta: "local model" });
      for (const p of targets) list.push({ key: `start:${p.id}`, to: `/p/${p.id}/work?new=1&task=${encodeURIComponent(query.trim())}`, label: <span>Start a lane in {p.name}: {query.trim()}</span>, meta: "new lane" });
    }
    return list.slice(0, 30);
  }, [projects, lanes, query, here]);
  const go = (to: string) => { if (to.startsWith("ask:")) { ask(to.slice(4)); return; } onClose(); navigate(to); };
  return <Dialog title="Jump" onClose={onClose}>
    <div className="pathin"><input className="in" autoFocus aria-label="Jump to a project or lane" placeholder="Type a project, lane or task" value={query}
      onChange={(e) => { setQuery(e.target.value); setActive(0); }}
      onKeyDown={(e) => {
        if (e.key === "ArrowDown") { e.preventDefault(); setActive((i) => Math.min(i + 1, items.length - 1)); }
        if (e.key === "ArrowUp") { e.preventDefault(); setActive((i) => Math.max(i - 1, 0)); }
        if (e.key === "Enter" && items[active]) go(items[active]!.to);
      }} /></div>
    <div className="jump-list" role="listbox" aria-label="Results">
      {items.map((item, i) => <button key={item.key} role="option" aria-selected={i === active} className={i === active ? "on" : ""} onMouseEnter={() => setActive(i)} onClick={() => go(item.to)}>{item.label}<span className="m">{item.meta}</span></button>)}
      {!items.length ? <div className="empty">Nothing matches · try a project, a task or a question</div> : null}
    </div>
    {answer ? <div className="sec-b" role="status" aria-live="polite" style={{ borderTop: "1px solid var(--line-soft)", fontSize: 14, lineHeight: 1.55 }}>
      {answer.busy ? <span className="muted">Asking the local model…</span> : answer.error ? <span role="alert">{answer.error}</span> : answer.result ? <>
        <p style={{ margin: 0, whiteSpace: "pre-wrap" }}>{answer.result.answer}</p>
        {answer.result.sources.length ? <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 10 }}>{answer.result.sources.map((src) => <button key={src.id} className="fchip" style={{ border: 0, cursor: "pointer" }} onClick={() => go(src.kind === "lane" ? `/p/${answer.project}/work?lane=${encodeURIComponent(src.id.slice(5))}` : src.kind === "notes" ? `/p/${answer.project}/insights` : `/p/${answer.project}/architecture`)}>{src.label}</button>)}</div> : null}
        <span className="muted" style={{ display: "block", marginTop: 8, fontSize: 12 }}>{answer.result.model} · from your notes, code map, briefs and lanes</span>
      </> : null}
    </div> : null}
  </Dialog>;
}

export type WorkContext = ReturnType<typeof useWork> & { environments: ProjectEnvironments | null; reloadEnvironments: () => void };
export function useProjectWork(): WorkContext { return useOutletContext<WorkContext>(); }

const TABS = [
  ["work", "Work", true],
  ["review", "Review", READY.review],
  ["run", "Run", READY.run],
  ["architecture", "Architecture", READY.architecture],
  ["insights", "Insights", READY.insights],
] as const;

/** The project band (cover, name, live facts) and the tabs that have something to show. */
export function ProjectShell() {
  const { project = "" } = useParams();
  const [projects] = useJson<Project[]>("/api/projects");
  const work = useWork(project);
  const [environments, , reloadEnvironments] = useJson<ProjectEnvironments>(READY.run ? `/api/projects/${project}/environments` : null);
  const changes = useMemo(() => work.events.filter((e) => ["env.status", "recipe.approved", "recipe.requested", "lane.state"].includes(e.type)).length, [work.events]);
  const reload = useCallback(() => reloadEnvironments(), [reloadEnvironments]);
  useEffect(reload, [reload, changes]);
  const [inbox] = useInbox();
  const info = projects?.find((p) => p.id === project);
  const [branches] = useJson<ProjectBranches>(project ? `/api/projects/${project}/branches` : null);
  const repoName = info?.remote?.match(/github\.com[/:]([^/]+\/[^/.]+)/)?.[1] ?? info?.path.split("/").at(-1) ?? project;
  const active = work.lanes.filter((l) => !["merged", "cleaned", "archived"].includes(l.state));
  const waiting = inbox?.filter((i) => i.lane.startsWith(`${project}/`)).length ?? 0;
  const tabs = TABS.filter(([, , ready]) => ready);
  const reviews = work.lanes.filter((l) => l.state === "in_review").length;
  const up = [...new Set(environments?.lanes.flatMap((l) => l.environment?.services.filter((s) => s.state === "healthy").map((s) => s.name) ?? []) ?? [])];
  return (
    <>
      <section className="band" aria-label="Project">
        <div className={`cover ${coverFor(project)}`} />
        <div className="shade" />
        <div className="in">
          <div><div className="meta"><Link to="/">Projects</Link> / {repoName}{branches?.current ? ` · ${branches.current}` : ""}</div><h1>{info?.name ?? project}</h1></div>
          <div className="facts">
            <Glyph g="work">{active.length} {active.length === 1 ? "lane" : "lanes"}</Glyph>
            {waiting ? <Glyph g="wait">{waiting} need{waiting === 1 ? "s" : ""} you</Glyph> : null}
            {up.length ? <Glyph g="done">{up.join(" · ")} up</Glyph> : null}
          </div>
        </div>
      </section>
      {tabs.length > 1 ? <nav className="tabs" aria-label="Project">
        {tabs.map(([path, label]) => <NavLink key={path} to={`/p/${project}/${path}`}>{label}{path === "review" && reviews ? <span className="ib dark">{reviews}</span> : null}</NavLink>)}
      </nav> : null}
      <Outlet context={{ ...work, environments, reloadEnvironments } satisfies WorkContext} />
    </>
  );
}
