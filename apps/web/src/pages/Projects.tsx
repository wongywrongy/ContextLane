import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router";
import type { Health, InboxItem, Lane, Project, ResourcesOverview, UsageSummary } from "@contextlanes/protocol";
import { answerItem, errorMessage, reviewLink, useInbox, useJson } from "../api";
import { AddRepoDialog } from "../components/AddRepo";
import { Glyph, LaneBadge, StateGlyph, Tile, ago, agoText, coverFor, type IconName } from "../components/ui";

const KIND_ICON: Record<InboxItem["kind"], IconName> = { permission: "permission", question: "question", review: "checkpoint", approval: "environment", collision: "subagent" };

/** Home: what needs you, then one tile per project. */
export function ProjectsPage() {
  const [projects, , reloadProjects] = useJson<Project[]>("/api/projects");
  const [lanes] = useJson<Lane[]>("/api/lanes");
  const [health] = useJson<Health>("/api/health");
  const [resources, , reloadResources] = useJson<ResourcesOverview>("/api/resources");
  const [usage, , reloadUsage] = useJson<UsageSummary>("/api/usage");
  const reportedLimits = (usage?.limits ?? []).filter((limit) => Date.parse(limit.resetsAt) > Date.now());
  useEffect(() => { const timer = setInterval(() => { reloadResources(); reloadUsage(); }, 30_000); return () => clearInterval(timer); }, [reloadResources, reloadUsage]);
  const [params, setParams] = useSearchParams();
  const [adding, setAdding] = useState(params.get("add") === "1");
  const close = () => { setAdding(false); if (params.has("add")) setParams({}); };
  return (
    <main className="pg">
      <NeedsYou lanes={lanes ?? []} projects={projects ?? []} />
      <section aria-labelledby="projects-h">
        <div className="ph"><h2 id="projects-h">Projects</h2><span className="m">{projects ? `${projects.length} ${projects.length === 1 ? "repo" : "repos"} on ${health?.host ?? "this machine"}` : ""}</span>
          <div className="e"><button className="btn ghost sm" onClick={() => setAdding(true)}>Add repo</button></div></div>
        <div className="tiles">
          {(projects ?? []).map((p) => <ProjectTile key={p.id} project={p} lanes={(lanes ?? []).filter((l) => l.project === p.id)} services={resources?.projects.find((fact) => fact.project === p.id)} />)}
          {projects && !projects.length ? <button className="tile add" onClick={() => setAdding(true)}>+ Add your first repository<span className="muted" style={{ fontWeight: 400, fontSize: 13.5 }}>Pick from the repos your agents already use</span></button> : null}
        </div>
        {(resources?.gpus?.length || reportedLimits.length) ? <div className="sec-f" style={{ flexWrap: "wrap" }}>
          {reportedLimits.map((limit) => <span className="mono" style={{ fontSize: 12 }} key={`${limit.agent}/${limit.window}`}>{limit.agent === "claude-code" ? "Claude" : limit.agent} {limit.usedPct.toFixed(0)}% of {limit.window}</span>)}
          {resources?.gpus?.map((gpu, i) => <span className="mono" style={{ fontSize: 12 }} key={`${gpu.name}/${i}`}>{gpu.name}{gpu.usePct !== null ? ` · GPU ${gpu.usePct}%` : ""}{gpu.memoryUsedMiB !== null ? ` · ${gpu.memoryUsedMiB} MiB${gpu.memoryTotalMiB !== null ? ` of ${gpu.memoryTotalMiB} MiB` : ""}` : ""}</span>)}
        </div> : null}
      </section>
      {adding ? <AddRepoDialog onClose={close} onAdded={reloadProjects} /> : null}
    </main>
  );
}

function ProjectTile({ project, lanes, services }: { project: Project; lanes: Lane[]; services?: ResourcesOverview["projects"][number] }) {
  const open = lanes.filter((l) => !["merged", "cleaned", "archived"].includes(l.state));
  const latest = lanes.map((l) => l.createdAt).sort().at(-1);
  const counts = (["needs_you", "working", "in_review", "failed"] as const).map((s) => [s, open.filter((l) => l.state === s).length] as const).filter(([, n]) => n);
  const words: Record<string, string> = { needs_you: "need you", working: "working", in_review: "in review", failed: "failed" };
  const line = counts.length ? counts.map(([s, n]) => `${n} ${words[s]}`).join(" · ") : latest ? `last lane ${agoText(latest)}` : "no lanes yet";
  return <Link className="tile" to={`/p/${project.id}/work`}>
    <div className={`cover ${coverFor(project.id)}`} />
    <div className="tb">
      <div className="nm"><b>{project.name}</b><span className="mono muted">{project.path.split("/").at(-1)}</span></div>
      <div className="lanes">
        {open.slice(0, 8).map((l) => <span key={l.id}><LaneBadge id={l.id} colour={l.colour} /><StateGlyph state={l.state} /></span>)}
        {open.length > 8 ? <span className="mono muted" style={{ fontSize: 12 }}>+{open.length - 8}</span> : null}
        {!open.length ? <Glyph g="idle">No lanes</Glyph> : null}
      </div>
    </div>
    <div className="tf">{line}{services ? <> · {services.up} {services.up === 1 ? "service" : "services"} up{services.down ? ` · ${services.down} down` : ""}</> : null}</div>
  </Link>;
}

function NeedsYou({ lanes, projects }: { lanes: Lane[]; projects: Project[] }) {
  const [items, , reload] = useInbox();
  const shown = (items ?? []).slice(0, 4);
  return <section className="sec you" aria-labelledby="need-h">
    <div className="sec-h"><i className="g wait" aria-hidden="true" /><h2 id="need-h">Needs you</h2>{items?.length ? <span className="m">{shown.length} of {items.length}</span> : null}<div className="e"><Link className="lnk" to="/inbox">Open inbox →</Link></div></div>
    {shown.map((item) => <NeedRow key={item.id} item={item} lane={lanes.find((l) => l.id === item.lane)} project={projects.find((p) => item.lane.startsWith(`${p.id}/`))} answered={reload} />)}
    {items && !items.length ? <div className="sec-r"><Glyph g="done" /><span className="muted">Nothing is waiting on you. Questions and permissions from your agents land here and on your phone.</span></div> : null}
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
