import { clsx } from "clsx";
import { useCallback, useEffect, useLayoutEffect, useMemo, useState, type ReactNode } from "react";
import { Link, NavLink, Outlet, useMatch, useNavigate, useOutletContext, useParams, useSearchParams } from "react-router";
import type { AskAnswer, Health, Lane, Project, ProjectBranches, ProjectEnvironments } from "@contextlanes/protocol";
import { errorMessage, postJson, useJson, useLiveInbox, InboxContext, useInbox } from "../api";
import { keyAction, typingTarget } from "../keys";
import { useWork } from "../work/useWork";
import { READY, useFeatures } from "../features";
import { Command } from "cmdk";
import { AgentMark, Dialog, Glyph, LaneBadge, StateGlyph } from "./ui";

export function Shell() {
  const features = useFeatures();
  const [health, down, recheck] = useJson<Health>("/api/health");
  // The machine dot follows the daemon: checked every 30 seconds, so a stopped daemon shows as offline.
  useEffect(() => { const t = setInterval(recheck, 30_000); return () => clearInterval(t); }, [recheck]);
  const inboxQuery = useLiveInbox();
  const [inbox] = inboxQuery;
  const [jump, setJump] = useState(false);
  const [help, setHelp] = useState(false);
  const [lanes, , reloadLanes] = useJson<Lane[]>("/api/lanes");
  useEffect(reloadLanes, [inbox, reloadLanes]);
  const project = useMatch("/p/:project/*")?.params.project;
  const [params] = useSearchParams();
  const selected = lanes?.find(l => l.id === params.get("lane"));
  const navigate = useNavigate();
  const inProject = useMatch("/p/*") !== null;
  useLayoutEffect(() => {
    const key = (event: KeyboardEvent) => {
      const action = keyAction(event, typingTarget(event.target), !!document.querySelector('[role="dialog"]'));
      if (!action) return;
      event.preventDefault();
      if (typeof action === "object") {
        const lane = (lanes ?? []).filter(l => l.state !== "archived" && (!project || l.project === project))[action.lane];
        if (lane) navigate(`/p/${lane.project}/work?lane=${encodeURIComponent(lane.id)}`);
      } else if (action === "palette") setJump(true);
      else if (action === "help") setHelp(true);
      else if (action === "split-right" || action === "split-down") document.dispatchEvent(new CustomEvent("contextlanes:split", { detail: action === "split-right" ? "row" : "column" }));
      else if (action === "review") {
        const focused = document.activeElement?.closest("[data-lane]")?.getAttribute("data-lane");
        const lane = focused ?? selected?.id;
        const id = lane?.split("/")[0] ?? project;
        if (id) navigate(`/p/${id}/review${lane ? `?lane=${encodeURIComponent(lane)}` : ""}`);
      } else if (action === "answer") {
        const answer = document.querySelector<HTMLButtonElement>("[data-answer]:not(:disabled)");
        if (answer) answer.focus();
        else {
          const focused = document.activeElement?.closest("[data-lane]")?.getAttribute("data-lane") ?? selected?.id;
          const question = inbox?.find(i => !focused || i.lane === focused);
          if (question) navigate(`/inbox?item=${encodeURIComponent(question.id)}`);
        }
      } else {
        const active = document.activeElement;
        const list = active?.closest("[data-key-list], [role=listbox], ul, ol, table, nav, .sec, .agents") ?? document;
        let rows = [...list.querySelectorAll<HTMLElement>("[data-list-item], [role=option]")];
        if (!rows.length) rows = [...list.querySelectorAll<HTMLElement>("a[href], button:not(:disabled), summary, [tabindex=\"0\"]")];
        rows = rows.filter(el => el.getClientRects().length);
        const at = rows.findIndex(el => el === active || el.contains(active));
        rows[Math.max(0, Math.min(rows.length - 1, at < 0 ? 0 : at + (action === "next" ? 1 : -1)))]?.focus();
      }
    };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, [lanes, project, selected?.id, inbox, navigate]);
  return (
    <InboxContext.Provider value={inboxQuery}>
      <header className="top status-top" aria-busy={lanes === null}>
        <NavLink className="wm" to="/">ContextLanes</NavLink>
        <span className={clsx("host", down && "down")} title={down ? "Daemon not reachable" : "Machine online"}><i />{health?.host ?? "This machine"}</span>
        <nav className="status-breadcrumbs" aria-label="Breadcrumbs">{project ? <><span>/</span><Link to={`/p/${project}/work`}>{project}</Link></> : null}{selected ? <><span>/</span><span>{selected.id.split("/")[1]} {selected.kind === "shell" ? "no agent" : selected.agent}</span></> : null}</nav>
        <nav className="gnav" aria-label="Main">
          <NavLink to="/" end className={({ isActive }) => isActive || inProject ? "active" : ""}>Projects</NavLink>
          <NavLink to="/inbox">Inbox{inbox?.length ? <span className="ib">{inbox.length}</span> : null}</NavLink>
          {features.acp || features.helper || features.insights ? <NavLink to="/models">Models</NavLink> : null}
          <NavLink to="/settings">Settings</NavLink>
        </nav>
        <button className="ask" onClick={() => setJump(true)}>Command<span className="kbd">⌘K</span></button>
        <button className="lnk key-help" aria-label="Keyboard shortcuts" onClick={() => setHelp(true)}>?</button>
      </header>
      {help ? <Dialog title="Keyboard shortcuts" onClose={() => setHelp(false)}><dl className="key-list">{[["⌘1–9", "Jump to a lane"], ["j / k", "Move through the focused list"], ["a", "Open the selected question or focus its answers"], ["r", "Open Review"], [": / ⌘K", "Command palette"], ["⌘D / ⌘⇧D", "Split the selected pane right / down"], ["?", "Show these keys"]].map(([key, text]) => <div key={key}><dt>{key}</dt><dd>{text}</dd></div>)}</dl><p className="muted">Ctrl works in place of ⌘. Shortcuts stay off while typing or using the terminal. Choose an answer yourself with Tab and Enter.</p></Dialog> : null}
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
  const [answer, setAnswer] = useState<{ project: string; busy: boolean; result?: AskAnswer; error?: string } | null>(null);
  const navigate = useNavigate();
  const here = useMatch("/p/:project/*")?.params.project;
  const ask = (project: string) => { setAnswer({ project, busy: true }); void postJson<AskAnswer>(`/api/projects/${project}/ask`, { question: query }).then((result) => setAnswer({ project, busy: false, result }), (e) => setAnswer({ project, busy: false, error: errorMessage(e) })); };
  const features = useFeatures();
  const go = (to: string) => { if (to.startsWith("ask:")) { ask(to.slice(4)); return; } onClose(); navigate(to); };
  // A sentence rather than a name: offer to start a lane with it as the task, and (with insights) to ask about it.
  const sentence = query.trim().split(/\s+/).length >= 3 ? query.trim() : "";
  const targets = sentence ? (projects ?? []).filter((p) => !here || p.id === here).slice(0, 3) : [];
  // cmdk ranks, filters and handles the keys; each item's value is what it matches on.
  return <Dialog title="Jump" onClose={onClose}>
    <Command label="Jump to a project or lane" className="jumpk" loop>
      <div className="pathin"><Command.Input className="in" autoFocus placeholder="Type a project, lane or task" value={query} onValueChange={setQuery} /></div>
      <Command.List className="jump-list" data-key-list>
        <Command.Empty className="empty">Nothing matches · try a project, a task or a question</Command.Empty>
        {features.insights ? targets.map((p) => <Command.Item key={`ask:${p.id}`} value={`ask:${p.id}`} forceMount onSelect={() => go(`ask:${p.id}`)}><span>Ask about {p.name}: <b>{sentence}</b></span><span className="m">local model</span></Command.Item>) : null}
        {(lanes ?? []).map((lane) => <Command.Item key={lane.id} value={lane.id} keywords={[lane.task, lane.project]} onSelect={() => go(`/p/${lane.project}/work?lane=${encodeURIComponent(lane.id)}`)}>
          <LaneBadge id={lane.id} colour={lane.colour} /><span>{lane.task}</span><span className="m">{lane.id}</span>
        </Command.Item>)}
        {(projects ?? []).map((project) =>
          <Command.Item key={`p:${project.id}`} value={`p:${project.id}`} keywords={[project.name, project.id]} onSelect={() => go(`/p/${project.id}/work`)}><span><b>{project.name}</b></span><span className="m">project</span></Command.Item>)}
      </Command.List>
    </Command>
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

/** Work and Run are the core; the other tabs show only while their feature is on. */
const projectTabs = (f: ReturnType<typeof useFeatures>) => ([
  ["work", "Work", true],
  ["review", "Review", f.review],
  ["run", "Run", READY.run],
  ["architecture", "Architecture", f.architecture],
  ["insights", "Insights", f.insights],
] as const).filter(([, , ready]) => ready);

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
  const features = useFeatures();
  const tabs = projectTabs(features);
  const reviews = work.lanes.filter((l) => l.state === "in_review").length;
  const up = [...new Set(environments?.lanes.flatMap((l) => l.environment?.services.filter((s) => s.state === "healthy").map((s) => s.name) ?? []) ?? [])];
  return (
    <>
      <section className="band" aria-label="Project">
        <div className="in">
          <div><div className="meta"><Link to="/">Projects</Link>{repoName.split("/").pop()!.toLowerCase() !== (info?.name ?? project).toLowerCase() ? ` / repo ${repoName}` : ` / ${repoName}`}{branches?.current ? ` · branch ${branches.current}` : ""}</div><h1>{info?.name ?? project}</h1></div>
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
