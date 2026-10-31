import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link, Navigate, useLocation } from "react-router";
import type { DetectedAgent, OutsideAgent, Project, ProjectEnvironments, ProjectMap, SetupStatus } from "@contextlanes/protocol";
import { postJson, saveSession, useJson, RequestError, errorMessage } from "../api";
import { Empty, Glyph, Section, Tile, type Family, type IconName } from "../components/ui";
import { AddRepoDialog } from "../components/AddRepo";
import { useLaneForm } from "../components/NewLane";
import { AgentRows } from "../setup/Agents";
import { Action } from "../setup/ui";
import { PasskeyButton } from "./Settings";

/** Setup from the Setup board: the machine's part on the left, the browser's steps on the right. */
export function SetupPage() {
  const [status, error, reload] = useJson<SetupStatus>("/api/setup/status");
  const route = useLocation();
  const token = new URLSearchParams(route.hash.slice(1)).get("signin");
  const pending = useRef<{ token: string; request: Promise<unknown> } | null>(null);
  const [signedIn, setSignedIn] = useState(!token);
  const [signInError, setSignInError] = useState("");
  useEffect(() => {
    if (!token) return;
    history.replaceState(history.state, "", location.pathname + location.search);
    setSignedIn(false); setSignInError("");
    if (pending.current?.token !== token) pending.current = { token, request: postJson<{ token: string }>("/api/setup/sign-in", { token }).then((r) => saveSession(r.token)) };
    let active = true;
    void pending.current.request.then(() => { if (active) { setSignedIn(true); reload(); } }, (e) => { if (active) { setSignInError(errorMessage(e)); setSignedIn(true); } });
    return () => { active = false; };
  }, [token, reload]);
  return <main className="setup">
    <div className="hero"><Link className="wm" to="/">Context<span className="ln">Lanes</span></Link><span className="w2">setup</span>
      <p>Install once on a machine that stays on. Finish here, from any browser.</p></div>
    <div className="cols">
      <div className="col">
        <section className="sec"><div className="sec-h"><span className="stepn">1</span><h3>On the always-on machine</h3></div>
          <div className="term"><span className="c"># in the machine’s SSH session</span>{"\n"}$ contextlanes setup{"\n\n"}<span className="ok">✓</span> keeps lanes running after you log out{"\n"}<span className="ok">✓</span> turns on Tailscale for a private HTTPS address{"\n"}<span className="ok">✓</span> prints a sign-in link and a QR code{"\n\n"}Open the link here. It works once, for 10 minutes.{status?.publicUrl ? <>{"\n\n"}Reachable at <span className="y">{status.publicUrl}</span></> : null}</div>
        </section>
        <section className="sec"><div className="sec-h"><h3>Why an always-on machine</h3></div>
          {([["run", "environment", "Lanes keep working when your laptop sleeps."], ["you", "permission", "Your phone can answer agents from anywhere on your network."], ["look", "read", "Each lane gets its own checkout and shell, so agents never collide."], ["mind", "think", "GPUs for local models usually live there anyway."]] as [Family, IconName, string][])
            .map(([family, icon, text]) => <div className="sec-r why" key={text}><Tile family={family} icon={icon} small />{text}</div>)}
        </section>
      </div>
      {!signedIn ? <Section title="Signing you in"><Empty>Opening your private setup session…</Empty></Section>
        : !status ? <Section title="Connection"><Empty>{error ? <Glyph g="fail">ContextLanes is not answering · check it runs, then reload</Glyph> : "Connecting…"}</Empty></Section>
        : <BrowserSteps status={status} reload={reload} signInError={signInError} signedOut={status.signedOut || route.state?.signedOut === true} />}
    </div>
  </main>;
}

type StepState = "done" | "now" | "next";
function Step({ n, state, title, optional, desc, children, change }: { n: number; state: StepState; title: string; optional?: boolean; desc: ReactNode; children?: ReactNode; change?: () => void }) {
  return <div className={`sst ${state}`}>
    <span className="num">{state === "done" ? "✓" : n}</span>
    <div style={{ minWidth: 0 }}>
      <h3>{title}{optional ? <span className="opt"> · optional</span> : null}</h3>
      <p className="d">{desc}</p>
      {children ? <div className="body">{children}</div> : null}
    </div>
    <span className={`state ${state}`}>{state === "done" ? <>{change ? <button className="lnk" style={{ fontWeight: 500, color: "var(--muted)", marginRight: 10 }} onClick={change}>Change</button> : null}<i className="g done" />Done</> : state === "now" ? <><i className="g think" />Now</> : <><i className="g idle" />{optional ? "Any time" : "Next"}</>}</span>
  </div>;
}

function BrowserSteps({ status, reload, signInError, signedOut }: { status: SetupStatus; reload: () => void; signInError: string; signedOut: boolean }) {
  const [agents, agentError, reloadAgents] = useJson<DetectedAgent[]>(status.authorized ? "/api/setup/agents" : null);
  const [projects, , reloadProjects] = useJson<Project[]>(status.authorized ? "/api/projects" : null);
  const [opened, setOpened] = useState<number | null>(null);
  const [adding, setAdding] = useState(false);
  const signed = status.authorized;
  const ready = !!agents?.some((a) => a.status === "Ready");
  const hasProject = !!projects?.length;
  // Step 4 waits for every project's map, then for the owner to read it and continue (remembered in this browser).
  const [mapped, setMapped] = useState<Record<string, boolean>>({});
  const remembered = (key: string) => { try { return localStorage.getItem(key) === "1"; } catch { return false; } };
  const remember = (key: string) => { try { localStorage.setItem(key, "1"); } catch { /* this browser only */ } };
  const [seen, setSeen] = useState(() => remembered("cl-projects-surveyed"));
  const [skipped, setSkipped] = useState(() => remembered("cl-skip-first-lane"));
  const surveyed = hasProject && projects!.every((p) => mapped[p.id]);
  const done = [signed, ready, hasProject, status.hasLane || seen, status.hasLane || skipped];
  const current = opened ?? done.findIndex((d) => !d);
  const state = (i: number): StepState => i === current ? "now" : done[i] ? "done" : "next";
  const finished = signed && (status.hasLane || skipped);
  return <section className="sec" aria-label="From any browser">
    <div className="sec-h"><span className="stepn">2</span><h3>From any browser</h3><div className="e"><span className="mono muted" style={{ fontSize: 12 }}>{done.filter(Boolean).length} of {done.length} done</span><span className="prog" aria-hidden="true">{done.map((d, i) => <i key={i} className={d ? "done" : i === current ? "now" : ""} />)}</span></div></div>
    <Step n={1} state={state(0)} title="Sign in" desc={signed ? status.tailnetLogin ? `Signed in as ${status.tailnetLogin}.` : "Signed in on this browser." : "Open the link contextlanes setup prints."}>
      {!signed ? <>
        {signedOut ? <Glyph g="wait">Signed out by an update · sign in once more</Glyph> : null}
        {signInError ? <p role="alert" style={{ margin: 0 }}>{signInError} Run <code>contextlanes setup</code> again for a new link.</p> : null}
        {status.hasPasskey ? <div><Action run={async () => {
          if (!window.PublicKeyCredential?.parseRequestOptionsFromJSON) throw new RequestError("Use a current browser at the HTTPS address where you added the passkey.");
          const result = await postJson<{ options: PublicKeyCredentialRequestOptionsJSON; challengeId: string }>("/api/setup/login/options", {});
          const credential = await navigator.credentials.get({ publicKey: PublicKeyCredential.parseRequestOptionsFromJSON(result.options) }) as PublicKeyCredential | null;
          if (!credential) throw new RequestError("Sign-in was cancelled; try again when you are ready.");
          saveSession((await postJson<{ token: string }>("/api/setup/login", { challengeId: result.challengeId, response: credential.toJSON() })).token);
        }} done={reload}>Sign in with a passkey</Action></div> : null}
      </> : status.hasLane ? <PasskeyButton /> : null}
    </Step>
    <Step n={2} state={state(1)} title="Connect an agent" change={done[1] && current !== 1 ? () => setOpened(1) : undefined}
      desc={ready ? `${agents!.filter((a) => a.status === "Ready").length} ready · they keep their own logins` : "Install and sign in to one coding agent."}>
      {state(1) === "now" ? <><AgentRows agents={agents} error={agentError} reload={reloadAgents} />{opened === 1 ? <div><button className="btn" disabled={!ready} onClick={() => setOpened(null)}>Continue</button></div> : null}</> : null}
    </Step>
    <Step n={3} state={state(2)} title="Add projects" change={done[2] && current !== 2 ? () => setOpened(2) : undefined}
      desc={hasProject ? `Added ${projects!.map((p) => p.name).join(", ")}.` : "Pick the repositories your agents work in."}>
      {state(2) === "now" ? <div style={{ display: "flex", gap: 8 }}><button className="btn" onClick={() => setAdding(true)}>{hasProject ? "Add more" : "Add repositories"}</button>{hasProject ? <button className="btn ghost" onClick={() => setOpened(null)}>Continue</button> : null}</div> : null}
    </Step>
    <Step n={4} state={state(3)} title="Map your projects" change={done[3] && current !== 3 ? () => setOpened(3) : undefined}
      desc={done[3] && current !== 3 ? "Mapped · see Architecture and Run." : "Its code and how it runs · read on this machine only."}>
      {state(3) === "now" && projects?.length ? <><div className="agents">{projects.map((p) => <ProjectSurvey key={p.id} project={p} done={() => setMapped((m) => m[p.id] ? m : { ...m, [p.id]: true })} />)}</div>
        <div><button className="btn" disabled={!surveyed} onClick={() => { remember("cl-projects-surveyed"); setSeen(true); setOpened(null); }}>{surveyed ? "Continue" : "Mapping…"}</button></div></> : null}
    </Step>
    <Step n={5} state={state(4)} title="Start your first lane" desc={status.hasLane ? "Your first lane is running." : skipped ? "Skipped · start one from Work." : "One task · its own branch, checkout and shell."}>
      {state(4) === "now" && projects?.length ? <><FirstLane projects={projects} /><div><button className="btn ghost" onClick={() => { remember("cl-skip-first-lane"); setSkipped(true); setOpened(null); }}>Skip for now</button></div></> : null}
    </Step>
    <Step n={6} state="next" optional title="Get pinged on your phone" desc="Answer permissions and questions in one tap.">
      {finished ? <div className="choice">
        <Link to="/settings#notifications"><b>Phone push</b><span>install as an app</span></Link>
        <Link to="/settings#notifications"><b>Telegram</b><span>reply to answer</span></Link>
        <Link to="/settings#notifications"><b>ntfy</b><span>self-hosted</span></Link>
      </div> : null}
    </Step>
    <Step n={7} state="next" optional title="Local models" desc={<>Ollama or llama.cpp, for small jobs.{signed ? <> <Link to="/models">Open Models</Link></> : null}</>} />
    {finished ? <div className="sec-f"><span>You’re set up.</span><div style={{ marginLeft: "auto" }}><Link className="btn sm" to="/">Open projects</Link></div></div> : null}
    {adding ? <AddRepoDialog onClose={() => setAdding(false)} onAdded={() => { reloadProjects(); setOpened(null); }} /> : null}
  </section>;
}

/** One project in step 4: its code map, how it runs, and anything already running for it outside ContextLanes. */
function ProjectSurvey({ project, done }: { project: Project; done: () => void }) {
  const [map, mapError] = useJson<ProjectMap>(`/api/projects/${project.id}/map`);
  const [env] = useJson<ProjectEnvironments>(`/api/projects/${project.id}/environments`);
  const [outside] = useJson<{ agents: OutsideAgent[] }>(`/api/projects/${project.id}/outside-agents`);
  const finished = !!map || !!mapError;
  useEffect(() => { if (finished) done(); }, [finished, done]);
  const m = map?.map;
  const recipe = env?.recipe ?? null;
  const services = env?.facts.outside?.filter((s) => !s.adoptedLane) ?? [];
  const sessions = outside?.agents ?? [];
  return <div className="sec-r wrap" style={{ alignItems: "flex-start" }}>
    <span className="grow survey">
      <b>{project.name} <span className="mono muted" style={{ fontSize: 12, fontWeight: 400 }}>{project.id}</span></b>
      {!finished ? <Glyph g="think">Reading the code…</Glyph>
        : m ? <Glyph g="done">{m.modules.length} modules in {m.layers.map((l) => l.name).join(", ") || "one layer"} · {m.files} files</Glyph>
        : <Glyph g="fail">Not mapped: {map?.error ?? mapError?.message}</Glyph>}
      {env ? recipe ? recipe.error ? <Glyph g="fail">.contextlanes.json is invalid: {recipe.error}</Glyph>
          : recipe.approved ? <Glyph g="done">Recipe approved · {recipe.recipe?.services.map((x) => x.name).join(", ") || "no services"}</Glyph>
          : <Glyph g="wait">Recipe to approve · <Link to={`/p/${project.id}/run`}>Run</Link></Glyph>
        : <Glyph g="idle">No recipe · previews off</Glyph> : null}
      {services.length ? <Glyph g="wait">{services.length} running outside a lane ({services.map((x) => `:${x.port}`).join(", ")}) · <Link to={`/p/${project.id}/run`}>Adopt</Link></Glyph> : null}
      {sessions.length ? <Glyph g="wait">{sessions.length} outside agent {sessions.length === 1 ? "session" : "sessions"} · <Link to={`/p/${project.id}/work`}>Take over</Link></Glyph> : null}
    </span>
    {m ? <Link className="btn ghost sm" to={`/p/${project.id}/architecture`}>Architecture</Link> : null}
  </div>;
}

function FirstLane({ projects }: { projects: Project[] }) {
  const form = useLaneForm(projects);
  return <div className="agents">{form.fields}<div className="sec-f"><button className="btn" disabled={!form.canStart} onClick={() => void form.start()}>{form.busy ? "Starting…" : "Start lane"}</button></div></div>;
}

export function ClaimGuard({ children }: { children: ReactNode }) {
  const [status, error] = useJson<SetupStatus>("/api/setup/status");
  if (status && !status.authorized) return <Navigate to="/setup" replace state={{ signedOut: status.signedOut }} />;
  if (!status) return <main className="pg"><Section title="Connection"><Empty>{error ? <Glyph g="fail">ContextLanes is not answering · check it runs, then reload</Glyph> : "Connecting…"}</Empty></Section></main>;
  return children;
}
