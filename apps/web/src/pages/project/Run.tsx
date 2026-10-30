import { useEffect, useState } from "react";
import type { EnvironmentView, Lane, LaneEnvironment, LogLine, RecipeView, ServiceStatus } from "@contextlanes/protocol";
import { errorMessage, getJson, postJson } from "../../api";
import { useProjectWork } from "../../components/Shell";
import { Dialog, Empty, Glyph, LaneBadge, PageHeader, Section } from "../../components/ui";
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

/** Run: each lane's copy of the app, from the approved recipe. */
export function RunPage() {
  const { lanes, environments, reloadEnvironments } = useProjectWork();
  const [viewing, setViewing] = useState<RecipeView | null>(null);
  const exposure = environments?.previews === "caddy" ? "Private subdomains" : "Tailnet only";
  const live = environments?.lanes.filter((l) => running(l.environment)).length ?? 0;
  useEffect(() => {
    if (!live) return;
    const timer = setInterval(reloadEnvironments, 5000);
    return () => clearInterval(timer);
  }, [live, reloadEnvironments]);
  const open = environments?.lanes ?? [];
  const recipe = environments?.recipe ?? null;
  return <main className="pg stack">
    <PageHeader title="Run" meta="each lane's copy of the app, from the approved recipe" end={<Glyph g="done">{exposure}</Glyph>} />
    <Section title="Environments" meta={environments ? `${live} running · ${open.length - live} not started` : ""}>
      {open.map((entry) => { const lane = lanes.find((l) => l.id === entry.lane); return lane ? <EnvironmentRow key={lane.id} lane={lane} entry={entry} changed={reloadEnvironments} review={setViewing} /> : null; })}
      {environments && !open.length ? <Empty>No open lanes. Start a lane from Work, then run its copy of the app here.</Empty> : null}
    </Section>
    <Section title="Recipe and housekeeping" meta="applies to every lane in this project">
      <div className="hk">
        <div>
          <h4>Recipe{recipe ? <span className="e">{recipe.error ? <Glyph g="fail">Invalid</Glyph> : recipe.approved ? <Glyph g="done">Approved</Glyph> : <Glyph g="wait">Needs approval</Glyph>}</span> : null}</h4>
          {recipe ? <><span className="mono" style={{ fontSize: 13.5 }}>{recipe.file}</span>
            <span className="mono muted" style={{ fontSize: 12 }}>sha {recipe.hash.slice(0, 7)}{recipe.recipe ? ` · ${recipe.recipe.services.map((s) => s.name).join(", ") || "no services"} · ports per lane` : ""}</span>
            <div><button className="btn ghost sm" onClick={() => setViewing(recipe)}>View recipe</button></div></>
            : <span className="muted" style={{ fontSize: 13.5 }}>Add <span className="mono">.contextlanes.json</span> to the repository to say how this project runs. Nothing starts without your approval.</span>}
        </div>
        <div>
          <h4>Exposure</h4>
          <Glyph g="done">{environments?.previews === "caddy" ? `Previews at *.${environments.domain} through Caddy` : "Previews reachable on your tailnet only"}</Glyph>
          <Glyph g="done">Nothing listening on 0.0.0.0; a service that tries is stopped</Glyph>
        </div>
      </div>
    </Section>
    {viewing ? <RecipeDialog view={viewing} onClose={() => setViewing(null)} changed={reloadEnvironments} /> : null}
  </main>;
}

function RecipeDialog({ view, onClose, changed }: { view: RecipeView; onClose: () => void; changed: () => void }) {
  const { lanes } = useProjectWork();
  const [error, setError] = useState("");
  const project = lanes[0]?.project;
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
  const [logs, setLogs] = useState<string | null>(null);
  const act = async (action: "start" | "stop" | "restart") => {
    setBusy(action); setError("");
    try { await postJson(`/api/lanes/${lane.id}/env/${action}`, {}); }
    catch (err) { setError(errorMessage(err)); }
    finally { setBusy(""); changed(); }
  };
  const isRunning = running(env);
  const blocked = recipe && (!recipe.approved || recipe.error);
  return <div className="envl">
    <div className="envl-h">
      <LaneBadge id={lane.id} colour={lane.colour} /><b>{lane.task}</b>
      <span className="m">{lane.branch} · {isRunning && env?.startedAt ? `up ${duration(env.startedAt)}` : "not started"}</span>
      <div className="e">
        {isRunning ? <><button className="btn ghost sm" disabled={!!busy} onClick={() => void act("restart")}>{busy === "restart" ? "Restarting…" : "Restart"}</button><button className="btn ghost sm" disabled={!!busy} onClick={() => void act("stop")}>{busy === "stop" ? "Stopping…" : "Stop"}</button></>
          : blocked ? <button className="btn sm" onClick={() => review(recipe)}>Review recipe</button>
            : recipe ? <button className="btn sm" disabled={!!busy} onClick={() => void act("start")}>{busy === "start" ? "Starting…" : "Start environment"}</button> : null}
      </div>
    </div>
    {error ? <p role="alert" style={{ margin: 0, fontSize: 13.5 }}>{error}</p> : null}
    {env?.error ? <div className="out" style={{ margin: 0 }}>{env.error}</div> : null}
    {env?.setup && isRunning ? <div className="envfacts">
      <div><Glyph g="done">Ignored files</Glyph><small>{env.setup.ignored.length ? `${env.setup.ignored.join(", ")} copied` : "none to copy"}</small></div>
      <div><Glyph g="done">Dependencies</Glyph><small>{env.setup.cache === "none" ? "nothing to bring across" : `${env.setup.cache} from cache · ${env.setup.seconds} s`}</small></div>
      {env.setup.disk !== null ? <div><Glyph g="done">Disk</Glyph><small>{size(env.setup.disk)} in this lane</small></div> : null}
    </div> : null}
    {isRunning ? env!.services.map((service) => <Service key={service.name} service={service} open={logs === service.name} toggle={() => setLogs(logs === service.name ? null : service.name)} />) : null}
    {isRunning && logs ? <Logs lane={lane.id} service={logs} /> : null}
    {!isRunning && !recipe ? <span className="muted" style={{ fontSize: 14 }}>This project has no recipe yet.</span> : null}
    {!isRunning && recipe?.recipe ? <span style={{ fontSize: 14, color: "var(--text-2)" }}>{plan(recipe)}</span> : null}
  </div>;
}

function plan(view: RecipeView): string {
  const recipe = view.recipe!;
  const steps = ["copy ignored files", ...(recipe.cache.length ? ["link dependencies"] : []), ...(recipe.setup.length ? [`run ${recipe.setup.length === 1 ? recipe.setup[0]!.name : `${recipe.setup.length} setup steps`}`] : [])];
  return `Setup runs when you start it: ${steps.join(", ")}, then ${recipe.services.map((s) => s.name).join(" and ") || "nothing else"}${recipe.services.length ? " on free ports" : ""}.`;
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

function Logs({ lane, service }: { lane: string; service: string }) {
  const [lines, setLines] = useState<LogLine[]>([]);
  const [error, setError] = useState("");
  const [mode, setMode] = useState<"follow" | "errors">("follow");
  useEffect(() => {
    let live = true;
    const load = () => getJson<LogLine[]>(`/api/lanes/${lane}/logs?service=${encodeURIComponent(service)}&lines=200`).then((l) => { if (live) { setLines(l); setError(""); } }, (e) => { if (live) setError(errorMessage(e)); });
    void load();
    const timer = setInterval(() => void load(), 2000);
    return () => { live = false; clearInterval(timer); };
  }, [lane, service]);
  const shown = mode === "errors" ? lines.filter((l) => /error|exception|fail|fatal/i.test(l.text)) : lines;
  return <div className="logs">
    <div className="logs-h">Logs · {service}<span className="m">journald · live</span>
      <div className="seg3" role="group" aria-label="Log filter"><button className={mode === "follow" ? "on" : ""} aria-pressed={mode === "follow"} onClick={() => setMode("follow")}>Follow</button><button className={mode === "errors" ? "on" : ""} aria-pressed={mode === "errors"} onClick={() => setMode("errors")}>Errors</button></div></div>
    <div className="term" role="log" aria-live="off">{error ? error : shown.length ? shown.slice(-100).map((l, i) => <div key={i}><span className="c">{clock(l.at, true)}</span>  {l.text}</div>) : mode === "errors" ? "No error lines." : "No log lines yet."}</div>
  </div>;
}
