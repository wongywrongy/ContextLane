import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { EnvironmentView, Lane, LaneEnvironment, LogLine, ProjectEnvironments, RecipeView, ServiceStatus, Project, OutsideService, RunFacts } from "@contextlanes/protocol";
import { useParams } from "react-router";
import { errorMessage, getJson, postJson, useJson } from "../../api";
import { NewLaneDialog } from "../../components/NewLane";
import { useProjectWork } from "../../components/Shell";
import { Link } from "react-router";
import { Dialog, Empty, Fact, Glyph, Help, LaneBadge, PageHeader, Section } from "../../components/ui";
import { SERVICE_GLYPH } from "../../work/model";

const clock = (iso: string, seconds = false) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", ...(seconds ? { second: "2-digit" } : {}), hourCycle: "h23" });
const running = (env: EnvironmentView | null) => !!env?.services.some((s) => s.state !== "stopped");

function duration(iso: string): string {
  const minutes = Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 60_000));
  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}
function size(bytes: number): string {
  return bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : bytes >= 1e6 ? `${Math.round(bytes / 1e6)} MB` : `${Math.ceil(bytes / 1e3)} KB`;
}

/** A lane's app in one word: up, starting, down (with which service), or not running. */
function appState(env: EnvironmentView | null): { g: string; word: string; failing: string | null } {
  const services = env?.services ?? [];
  if (!services.length || services.every((s) => s.state === "stopped")) return { g: "idle", word: "Not running", failing: null };
  const failed = services.find((s) => s.state === "failed");
  if (failed) return { g: "fail", word: `${failed.name} is down`, failing: failed.name };
  if (services.some((s) => s.state === "starting")) return { g: "think", word: "Starting", failing: null };
  return { g: "done", word: env?.startedAt ? `Up ${duration(env.startedAt)}` : "Up", failing: null };
}

/**
 * Run: whether each lane's copy of the app is up and where to open it, first. The recipe shows at the top
 * only when it needs you (missing, changed or invalid); everything else that is not about using the app sits
 * in Housekeeping at the bottom.
 */
export function RunPage() {
  const { project } = useParams();
  const { lanes, environments, reloadEnvironments } = useProjectWork();
  const [projects] = useJson<Project[]>("/api/projects");
  const [adopting, setAdopting] = useState<OutsideService | null>(null);
  const [viewing, setViewing] = useState<RecipeView | null>(null);
  const [writing, setWriting] = useState(false);
  const exposure = environments?.previews === "caddy" ? "Private subdomains" : "Tailnet only";
  useEffect(() => {
    const timer = setInterval(reloadEnvironments, 5000);
    return () => clearInterval(timer);
  }, [reloadEnvironments]);
  const open = environments?.lanes ?? [];
  const recipe = environments?.recipe ?? null;
  const states = open.map((e) => appState(e.environment));
  const up = states.filter((s) => s.g === "done").length;
  const down = states.filter((s) => s.g === "fail").length;
  const outside = environments?.facts?.outside ?? [];
  return <main className="pg stack">
    <PageHeader title="Run" meta="each lane's copy of your app" end={<Glyph g="done">{exposure}</Glyph>} />
    {environments ? <RecipeNeed recipe={recipe} review={setViewing} write={() => setWriting(true)} /> : null}
    <Section title="Apps" meta={environments ? [`${up} up`, down ? `${down} down` : "", `${open.length - up - down} not running`].filter(Boolean).join(" · ") : ""}>
      {open.map((entry) => { const lane = lanes.find((l) => l.id === entry.lane); return lane ? <EnvironmentRow key={lane.id} lane={lane} entry={entry} changed={reloadEnvironments} review={setViewing} /> : null; })}
      {environments && !open.length ? <Empty icon="environment" family="run" action={<Link className="btn ghost sm" to={`/p/${project}/work?new=1`}>New lane</Link>}>No open lanes</Empty> : null}
    </Section>
    {outside.length ? <Section title="Started outside ContextLanes" help="Servers from this project that you started yourself, found by their listening ports. ContextLanes only watches them; adopt one to run it as a lane's preview instead.">
      {outside.map((service) => <div className="sec-r" style={{ flexWrap: "wrap" }} key={`${service.pid}/${service.port}/${service.address}`}>
        <Glyph g="idle">{service.name}</Glyph><code>:{service.port}</code><span className="mono muted" style={{ fontSize: 12, overflowWrap: "anywhere", minWidth: 0 }}>pid {service.pid} · {service.cwd} · {service.bind}</span>
        {service.adoptedLane ? <span className="e" style={{ marginLeft: "auto" }}><Fact g="wait" detail="stop this copy once the lane's runs">Moving to {service.adoptedLane}</Fact></span> : <button className="btn ghost sm" style={{ marginLeft: "auto" }} onClick={() => setAdopting(service)}>Adopt into a lane</button>}
      </div>)}
    </Section> : null}
    <Section title="Housekeeping" meta="every lane in this project">
      {recipe ? <div className="sec-r" style={{ flexWrap: "wrap" }}><span className="kl" style={{ minWidth: 90 }}>Recipe</span>
        {recipe.error ? <Glyph g="fail">Invalid</Glyph> : recipe.approved ? <Glyph g="done">Approved</Glyph> : <Glyph g="wait">Needs approval</Glyph>}
        <span className="mono muted" style={{ fontSize: 12, minWidth: 0, overflowWrap: "anywhere" }}>{recipe.file} · sha {recipe.hash.slice(0, 7)}{recipe.recipe ? ` · ${recipe.recipe.services.map((x) => x.name).join(", ") || "no services"}` : ""}</span>
        <button className="btn ghost sm" style={{ marginLeft: "auto" }} onClick={() => setViewing(recipe)}>View</button></div> : null}
      {environments ? <CleanUp entries={environments.cleanup} changed={reloadEnvironments} /> : null}
      <div className="sec-r" style={{ flexWrap: "wrap" }}><span className="kl" style={{ minWidth: 90 }}>Exposure</span>
        <Fact g="done" detail={environments?.previews === "caddy" ? `*.${environments.domain}` : undefined}>{exposure}</Fact>
        <Help>Previews are reachable only on your tailnet{environments?.previews === "caddy" ? `, at *.${environments.domain} through Caddy` : ""}. A lane service found listening beyond localhost is stopped within seconds.</Help>
        {environments?.facts?.lanes.filter((lane) => lane.certificateDays !== null && lane.certificateDays < 14).map((lane) => <Fact key={lane.lane} g="wait" detail={lane.lane}>{`Certificate ${lane.certificateDays} days`}</Fact>)}
      </div>
    </Section>
    {viewing ? <RecipeDialog view={viewing} onClose={() => setViewing(null)} changed={reloadEnvironments} /> : null}
    {adopting && projects ? <NewLaneDialog projects={projects} project={project} adoption={adopting} onClose={() => setAdopting(null)} /> : null}
    {writing && projects ? <NewLaneDialog projects={projects} project={project} task={WRITE_RECIPE} onClose={() => setWriting(false)} /> : null}
  </main>;
}

const WRITE_RECIPE = "Write a .contextlanes.json recipe for this project so ContextLanes can run each lane's copy of the app: the setup steps, each service with its start command, the port it reads from $PORT and a health path, and the checks to run before review. Read the README and package scripts first; keep services bound to 127.0.0.1. Commit it and ask for review.";

/** The recipe, at the top only when it needs you: missing, changed since you approved it, or invalid. */
function RecipeNeed({ recipe, review, write }: { recipe: RecipeView | null; review: (v: RecipeView) => void; write: () => void }) {
  if (recipe && recipe.approved && !recipe.error) return null;
  const help = <Help>A recipe (<span className="mono">.contextlanes.json</span> in the repository) says how to run this app for a lane: setup steps, services and their ports, and the checks run before review. Nothing in it runs until you approve it. Lanes edit, test and get reviewed without one.</Help>;
  if (!recipe) return <Section title="Recipe" end={help}>
    <Empty icon="environment" family="run" action={<button className="btn sm" onClick={write}>Have a lane write one</button>}>No recipe · lanes can't run the app yet</Empty></Section>;
  return <section className="sec you" aria-label="Recipe"><div className="sec-r" style={{ flexWrap: "wrap" }}>
    {recipe.error ? <Glyph g="fail">Recipe is invalid</Glyph> : <Glyph g="wait">Recipe changed · needs your approval</Glyph>}{help}
    <span className="mono muted" style={{ fontSize: 12 }}>{recipe.file} · sha {recipe.hash.slice(0, 7)}</span>
    <button className="btn sm" style={{ marginLeft: "auto" }} onClick={() => review(recipe)}>{recipe.error ? "See the error" : "Review and approve"}</button>
  </div>{recipe.error ? <div className="sec-b"><div className="out" style={{ margin: 0 }}>{recipe.error}</div></div> : null}</section>;
}

function CleanUp({ entries, changed }: { entries: ProjectEnvironments["cleanup"]; changed: () => void }) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  if (!entries.length) return null;
  const safe = entries.filter((e) => e.unpushed === 0);
  const unpushed = entries.reduce((sum, e) => sum + (e.unpushed ?? 0), 0);
  const unknown = entries.filter((e) => e.unpushed === null).length;
  const disk = entries.reduce((sum, e) => sum + (e.disk ?? 0), 0);
  const clean = async () => {
    setBusy(true); setMessage("");
    const refused: string[] = [];
    for (const { lane } of safe) await postJson(`/api/lanes/${lane}/cleanup`, {}).catch((err) => refused.push(errorMessage(err)));
    setMessage(refused.join(" "));
    setBusy(false);
    changed();
  };
  return <div className="sec-r" style={{ flexWrap: "wrap" }}><span className="kl" style={{ minWidth: 90 }}>Clean up</span>
    <Fact g="wait" detail={disk ? size(disk) : undefined}>{`${entries.length} merged ${entries.length === 1 ? "lane" : "lanes"}`}</Fact>
    <Help>For merged lanes: stops their services and agent, drops their databases and removes their checkouts, including ignored files such as .env. Branches are kept, and a lane with unpushed commits is left alone.</Help>
    {unpushed || unknown ? <Glyph g="wait">{unpushed ? `${unpushed} unpushed ${unpushed === 1 ? "commit" : "commits"} kept` : ""}{unpushed && unknown ? "; " : ""}{unknown ? `${unknown} not checked` : ""}</Glyph> : null}
    {safe.length ? <button className="btn ghost sm" style={{ marginLeft: "auto" }} disabled={busy} onClick={() => void clean()}>{busy ? "Cleaning up…" : `Clean up ${safe.length} ${safe.length === 1 ? "lane" : "lanes"}`}</button> : null}
    {message ? <p role="alert" style={{ margin: 0, fontSize: 13.5, flexBasis: "100%" }}>{message}</p> : null}
  </div>;
}

function RecipeDialog({ view, onClose, changed }: { view: RecipeView; onClose: () => void; changed: () => void }) {
  const { project } = useParams();
  const [error, setError] = useState("");
  const approve = async () => {
    try { await postJson(`/api/projects/${project}/recipe/approve`, { hash: view.hash }); changed(); onClose(); }
    catch (err) { setError(errorMessage(err)); }
  };
  return <Dialog title="Recipe" meta={`sha ${view.hash.slice(0, 7)}`} wide onClose={onClose}
    footer={<>{error ? <span role="alert" style={{ fontSize: 13.5 }}>{error}</span> : null}{!view.approved && !view.error && project ? <button className="btn" onClick={() => void approve()}>Approve this recipe</button> : null}<button className="btn ghost" onClick={onClose}>Close</button></>}>
    {view.error ? <p role="alert">{view.error}</p> : null}
    <p className="muted" style={{ margin: "0 0 10px", fontSize: 13.5 }}>{view.approved ? "Approved. A change to this file needs approval again." : "These commands run on this machine as you. Approve only what you have read."}</p>
    <div className="out recipe-text">{view.text}</div>
  </Dialog>;
}

function EnvironmentRow({ lane, entry, changed, review }: { lane: Lane; entry: LaneEnvironment; changed: () => void; review: (view: RecipeView) => void }) {
  const env = entry.environment;
  const recipe = entry.recipe;
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [chosen, setLogs] = useState<string | null>(null);
  const [setup, setSetup] = useState(false);
  const act = async (action: "start" | "stop" | "restart") => {
    setBusy(action); setError("");
    try { await postJson(`/api/lanes/${lane.id}/env/${action}`, {}); }
    catch (err) { setError(errorMessage(err)); }
    finally { setBusy(""); changed(); }
  };
  const isRunning = running(env);
  const state = appState(env);
  // A service that is down shows its logs without a click; that is the first thing you need.
  const logs = chosen ?? state.failing;
  const blocked = recipe && (!recipe.approved || recipe.error);
  const web = env?.services.find((x) => x.name === "web" && x.url) ?? env?.services.find((x) => x.url) ?? null;
  return <div className="envl">
    <div className="envl-h">
      <LaneBadge id={lane.id} colour={lane.colour} /><b>{lane.task}</b>
      <Glyph g={state.g}>{state.word}</Glyph>
      <div className="e">
        {isRunning && web?.url && state.g !== "fail" ? <a className="btn sm" href={web.url} target="_blank" rel="noreferrer">Open app ↗</a> : null}
        {isRunning ? <>{lane.state !== "merged" ? <button className="btn ghost sm" disabled={!!busy} onClick={() => void act("restart")}>{busy === "restart" ? "Restarting…" : "Restart"}</button> : <span className="muted" style={{ fontSize: 13 }}>Merged · still running</span>}<button className="btn ghost sm" disabled={!!busy} onClick={() => void act("stop")}>{busy === "stop" ? "Stopping…" : "Stop"}</button></>
          : blocked ? <button className="btn ghost sm" onClick={() => review(recipe)}>Approve the recipe first</button>
            : recipe ? <button className="btn sm" disabled={!!busy} onClick={() => void act("start")}>{busy === "start" ? "Starting…" : "Start the app"}</button> : null}
      </div>
    </div>
    {error ? <p role="alert" style={{ margin: 0, fontSize: 13.5 }}>{error}</p> : null}
    {env?.error ? <div className="out" style={{ margin: 0 }}>{env.error}</div> : null}
    {isRunning ? env!.services.map((service) => <Service key={service.name} service={service} open={logs === service.name} toggle={() => setLogs(logs === service.name ? "" : service.name)} />) : null}
    {isRunning && logs ? <Logs lane={lane.id} service={logs} /> : null}
    {isRunning && env?.setup ? <button className="lnk" style={{ justifySelf: "start", fontSize: 13 }} aria-expanded={setup} onClick={() => setSetup(!setup)}>{setup ? "Hide how it was set up" : "How it was set up"}</button> : null}
    {isRunning && env?.setup && setup ? <div className="envfacts">
      <div><Glyph g="done">Ignored files</Glyph><small>{env.setup.ignored.length ? `${env.setup.ignored.join(", ")} copied` : "none to copy"}</small></div>
      <div><Glyph g="done">Dependencies</Glyph><small>{env.setup.cache === "none" ? "nothing to bring across" : `${env.setup.cache} from cache · ${env.setup.seconds} s`}</small></div>
      {env.setup.database ? <div><Glyph g="done">Database</Glyph><small>{env.setup.database.kind === "postgres" ? `${env.setup.database.name} from ${env.setup.database.template}` : `${env.setup.database.name} copied`}</small></div> : null}
    </div> : null}
    {!isRunning && recipe?.recipe && !blocked ? <Plan view={recipe} /> : null}
  </div>;
}

/** What Start does, drawn as its steps in order rather than told in a sentence. */
function Plan({ view }: { view: RecipeView }) {
  const recipe = view.recipe!;
  const steps = ["Copy .env files", ...(recipe.cache.length ? ["Link dependencies"] : []), ...recipe.setup.map((s) => s.name), ...recipe.services.map((s) => `${s.name} on a free port`)];
  return <ol className="flow" aria-label="What Start does">{steps.map((step) => <li key={step}>{step}</li>)}</ol>;
}

function Service({ service, open, toggle }: { service: ServiceStatus; open: boolean; toggle: () => void }) {
  const note = service.detail ?? (service.state === "stopped" ? "stopped" : service.state === "starting" ? "starting" : service.lastFailure ? `failed once ${clock(service.lastFailure)}, recovered` : `GET ${service.healthPath}${service.ms !== null ? ` ${service.ms}ms` : ""}`);
  return <div className="svc">
    <i className={`g ${SERVICE_GLYPH[service.state]}`} role="img" aria-label={service.state} title={service.state} />
    <b>{service.name}</b>
    <span className="port">:{service.port}</span>
    <span className="ticks" role="img" aria-label={`${service.probes.filter(Boolean).length} of the last ${service.probes.length} health checks passed`}>{service.probes.map((ok, i) => <i key={i} className={ok ? "" : "bad"} />)}</span>
    <span className={`note${service.detail ? " bad" : ""}`}>{note}</span>
    {service.url ? <a className="lnk" href={service.url} target="_blank" rel="noreferrer">{new URL(service.url).host} ↗</a> : <span />}
    <button className={`btn sm${open ? "" : " ghost"}`} aria-pressed={open} onClick={toggle}>Logs</button>
  </div>;
}

const BAD = /\b(error|exception|fail(ed|ure)?|fatal|panic|traceback|unhandled|refused|denied)\b|\s5\d\d\s/i;

/** One service's log: follows the end while you are there, marks error lines, and filters to them in one tap. */
function Logs({ lane, service }: { lane: string; service: string }) {
  const [lines, setLines] = useState<LogLine[]>([]);
  const [error, setError] = useState("");
  const [mode, setMode] = useState<"follow" | "errors">("follow");
  const [copied, setCopied] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const atEnd = useRef(true);
  useEffect(() => {
    let live = true;
    const load = () => getJson<LogLine[]>(`/api/lanes/${lane}/logs?service=${encodeURIComponent(service)}&lines=300`).then((l) => { if (live) { setLines(l); setError(""); } }, (e) => { if (live) setError(errorMessage(e)); });
    void load();
    const timer = setInterval(() => void load(), 2000);
    return () => { live = false; clearInterval(timer); };
  }, [lane, service]);
  const bad = lines.filter((l) => BAD.test(l.text));
  const shown = mode === "errors" ? bad : lines;
  // New lines keep you at the end only if you were there; scrolling up to read stops the follow.
  useLayoutEffect(() => { const el = box.current; if (el && atEnd.current) el.scrollTop = el.scrollHeight; }, [shown.length, mode]);
  const copy = () => void navigator.clipboard?.writeText(shown.map((l) => `${clock(l.at, true)}  ${l.text}`).join("\n")).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); });
  return <div className="logs">
    <div className="logs-h">Logs · {service}<span className="m">live · last {lines.length} lines</span>
      <button className="lnk" style={{ fontSize: 12.5, marginLeft: "auto" }} onClick={copy}>{copied ? "Copied" : "Copy"}</button>
      <div className="seg3" role="group" aria-label="Log filter" style={{ marginLeft: 0 }}><button className={mode === "follow" ? "on" : ""} aria-pressed={mode === "follow"} onClick={() => setMode("follow")}>All</button><button className={mode === "errors" ? "on" : ""} aria-pressed={mode === "errors"} onClick={() => setMode("errors")}>Errors{bad.length ? ` ${bad.length}` : ""}</button></div></div>
    <div className="term" ref={box} role="log" aria-live="off" onScroll={(e) => { const el = e.currentTarget; atEnd.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40; }}>
      {error ? error : shown.length ? shown.map((l, i) => <div key={i} className={BAD.test(l.text) ? "err" : undefined}><span className="c">{clock(l.at, true)}</span>  {l.text}</div>) : mode === "errors" ? "No error lines." : "No log lines yet."}</div>
  </div>;
}
