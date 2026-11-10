import { useEffect, useState } from "react";
import { Link } from "react-router";
import type { BoardLane, Health, InboxItem, Lane, Project, ResourcesOverview, UsageSummary } from "@contextlanes/protocol";
import { answerItem, errorMessage, reviewLink, useInbox, useJson } from "../api";
import { Cmd, Glyph, LaneBadge, StateGlyph, Tile, ago, agoText, type IconName } from "../components/ui";

import { BOARD_COLUMNS, boardColumn } from "../work/board";
import { useFeatures } from "../features";

const KIND_ICON: Record<InboxItem["kind"], IconName> = { permission: "permission", question: "question", review: "checkpoint", approval: "environment", collision: "subagent" };

/** Home: what needs you, then one tile per project. */
export function ProjectsPage() {
  const [projects, , reloadProjects] = useJson<Project[]>("/api/projects");
  // A project added from the machine shows up here without a reload.
  useEffect(() => { const timer = setInterval(reloadProjects, 10_000); return () => clearInterval(timer); }, [reloadProjects]);
  const [board, , reloadBoard] = useJson<BoardLane[]>("/api/board");
  const lanes = board?.map(card => card.lane);
  const [waiting] = useInbox();
  useEffect(reloadBoard, [waiting, reloadBoard]);
  const [health] = useJson<Health>("/api/health");
  const [resources, , reloadResources] = useJson<ResourcesOverview>("/api/resources");
  const [usage, , reloadUsage] = useJson<UsageSummary>("/api/usage");
  const reportedLimits = (usage?.limits ?? []).filter((limit) => Date.parse(limit.resetsAt) > Date.now());
  useEffect(() => { const timer = setInterval(() => { reloadResources(); reloadUsage(); reloadBoard(); }, 30_000); return () => clearInterval(timer); }, [reloadResources, reloadUsage, reloadBoard]);
  return (
    <main className="pg">
      <NeedsYou lanes={lanes ?? []} projects={projects ?? []} />
      <section aria-labelledby="projects-h">
        <div className="ph"><h2 id="projects-h">Projects</h2><span className="m">{projects ? `${projects.length} on ${health?.host ?? "this machine"}` : ""}</span>
          <div className="e"><Cmd note="add a repository">cl add [path]</Cmd></div></div>
        {projects?.length && !board ? <p role="status">Loading lanes…</p> : null}
        <div className="tiles" data-key-list>
          {(board ? projects ?? [] : []).map((p) => <ProjectTile key={p.id} project={p} lanes={(lanes ?? []).filter((l) => l.project === p.id)} cards={(board ?? []).filter(c => c.lane.project === p.id)} waiting={waiting ?? []} services={resources?.projects.find((fact) => fact.project === p.id)} />)}
          {projects && !projects.length ? <div className="tile add">No repositories yet<span className="muted" style={{ fontWeight: 400, fontSize: 13.5 }}>On the machine, run this inside a repository:</span><Cmd>cl add</Cmd></div> : null}
        </div>
        {(resources?.gpus?.length || reportedLimits.length) ? <div className="sec machine-strip"><div className="sec-r" style={{ flexWrap: "wrap" }}><span className="lbl">{health?.host ?? "This machine"}</span>
          {reportedLimits.map((limit) => <span className="mono" style={{ fontSize: 12 }} key={`${limit.agent}/${limit.window}`}>{limit.agent === "claude-code" ? "Claude" : limit.agent} {limit.usedPct.toFixed(0)}% of {limit.window}</span>)}
          {resources?.gpus?.map((gpu, i) => <span className="mono" style={{ fontSize: 12 }} key={`${gpu.name}/${i}`}>{gpu.name}{gpu.usePct !== null ? ` · GPU ${gpu.usePct}%` : ""}{gpu.memoryUsedMiB !== null ? ` · ${gpu.memoryUsedMiB} MiB${gpu.memoryTotalMiB !== null ? ` of ${gpu.memoryTotalMiB} MiB` : ""}` : ""}</span>)}
        </div></div> : null}
      </section>
    </main>
  );
}

function ProjectTile({ project, lanes, cards, waiting, services }: { project: Project; lanes: Lane[]; cards: BoardLane[]; waiting: InboxItem[]; services?: ResourcesOverview["projects"][number] }) {
  // Only review moves lanes to In review and Merged, so those counts show only with it, as on the board.
  const features = useFeatures();
  const columns = BOARD_COLUMNS.filter((column) => features.review || !["In review", "Merged"].includes(column));
  const open = lanes.filter((l) => !["merged", "cleaned", "archived"].includes(l.state));
  const latest = lanes.map((l) => l.createdAt).sort().at(-1);
  const line = cards.length ? columns.map(column => <span key={column}>{column} {cards.filter(c => boardColumn(c, waiting.some(i => i.lane === c.lane.id)) === column).length}</span>) : <span>{latest ? `last lane ${agoText(latest)}` : "no lanes yet"}</span>;
  const needs = cards.filter(c => boardColumn(c, waiting.some(i => i.lane === c.lane.id)) === "Needs you");
  return <section className="project-compact"><Link className="tile" data-list-item to={`/p/${project.id}/work`}>
    <div className="tb">
      <div className="nm"><b>{project.name}</b><span className="mono muted">{project.path.split("/").at(-1)}</span></div>
      <div className="lanes">
        {open.slice(0, 8).map((l) => <span key={l.id}><LaneBadge id={l.id} colour={l.colour} /><StateGlyph state={l.state} /></span>)}
        {open.length > 8 ? <span className="mono muted" style={{ fontSize: 12 }}>+{open.length - 8}</span> : null}
        {!open.length ? <Glyph g="idle">No lanes</Glyph> : null}
      </div>
    </div>
    <div className="tf">{line}{services?.up ? <Glyph g="done">{`${services.up} up`}</Glyph> : null}{services?.down ? <Glyph g="fail">{`${services.down} down`}</Glyph> : null}</div>
  </Link>{needs.map(c => <Link className="sec-r project-need" key={c.lane.id} to={`/p/${project.id}/work?lane=${encodeURIComponent(c.lane.id)}`}><LaneBadge id={c.lane.id} colour={c.lane.colour} /><Glyph g="wait">Needs you</Glyph><span>{c.lane.task}</span></Link>)}</section>;
}

function NeedsYou({ lanes, projects }: { lanes: Lane[]; projects: Project[] }) {
  const [items, , reload] = useInbox();
  const shown = (items ?? []).slice(0, 4);
  // Amber only when something waits: with nothing waiting this is one quiet line, not an amber card.
  if (items && !items.length) return <section className="sec" aria-labelledby="need-h"><div className="sec-r"><Glyph g="done" /><span id="need-h" className="muted">Nothing needs you</span><Link className="lnk" style={{ marginLeft: "auto" }} to="/inbox">Inbox →</Link></div></section>;
  return <section className="sec you" aria-labelledby="need-h">
    <div className="sec-h"><i className="g wait" aria-hidden="true" /><h2 id="need-h">Needs you</h2>{items?.length ? <span className="m">{shown.length} of {items.length}</span> : null}<div className="e"><Link className="lnk" to="/inbox">Open inbox →</Link></div></div>
    {shown.map((item) => <NeedRow key={item.id} item={item} lane={lanes.find((l) => l.id === item.lane)} project={projects.find((p) => item.lane.startsWith(`${p.id}/`))} answered={reload} />)}
  </section>;
}

function NeedRow({ item, lane, project, answered }: { item: InboxItem; lane?: Lane; project?: Project; answered: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const allow = item.options.find((o) => o.kind === "allow_once");
  const deny = item.options.find((o) => o.kind === "reject_once");
  const respond = async (optionId: string) => {
    setBusy(true); setError("");
    try { await answerItem(item, optionId); answered(); } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  };
  const laneLink = `/p/${item.lane.split("/")[0]}/work?lane=${encodeURIComponent(item.lane)}`;
  return <div className="sec-r need">
    <Tile family="you" icon={KIND_ICON[item.kind]} small label={item.kind} />
    <Link className="who" to={laneLink}>{lane ? <LaneBadge id={lane.id} colour={lane.colour} /> : null}<span className="mono">{project?.name ?? item.lane}</span></Link>
    <span className="what">{item.title}{error ? <span role="alert" style={{ display: "block" }}>{error}</span> : null}</span>
    <span className="act"><span className="t">{ago(item.since)}</span>
      {item.kind === "permission" && allow && deny ? <><button className="btn sm" disabled={busy} onClick={() => void respond(allow.id)}>{allow.label}</button><button className="btn ghost sm" disabled={busy} onClick={() => void respond(deny.id)}>{deny.label}</button></>
        : <Link className="btn ghost sm" to={item.kind === "review" ? reviewLink(item.lane) : item.kind === "collision" ? `/p/${item.lane.split("/")[0]}/architecture` : `/inbox?item=${encodeURIComponent(item.id)}`}>{item.kind === "question" ? "Reply" : "Open"}</Link>}
    </span>
  </div>;
}
