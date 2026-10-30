import { lazy, Suspense, useState } from "react";
import type { AgentId, DetectedAgent, UsageSummary } from "@contextlanes/protocol";
import { postJson } from "../api";
import { AGENT_NAMES, AgentMark, Empty, Glyph } from "../components/ui";
import { Action } from "./ui";
const LoginTerminal = lazy(() => import("../components/Terminal").then((module) => ({ default: module.Terminal })));

const STATUS: Record<DetectedAgent["status"], string> = { Ready: "signed in", Install: "not installed", "Sign in": "needs sign-in" };

/** One row per agent: Ready, Install, or Sign in (opens the agent's own login in a terminal here). */
export function AgentRows({ agents, error, reload, limits }: { agents: DetectedAgent[] | null; error: Error | null; reload: () => void; limits?: UsageSummary["limits"] }) {
  const [login, setLogin] = useState<AgentId | null>(null);
  const row = (agent: DetectedAgent) => <div className={`sec-r${limits ? " agent-usage" : ""}`} key={agent.id}>
    <AgentMark agent={agent.id} /><b>{AGENT_NAMES[agent.id] ?? agent.id}</b><span className="st">· {agent.source === "registry" ? agent.installed ? "from the ACP registry; signs in through its own CLI" : "from the ACP registry; its command is missing" : STATUS[agent.status]}</span>
    {limits ? <span className="agent-limits mono muted" style={{ fontSize: 12 }}>{limits.filter((limit) => limit.agent === agent.id && Date.parse(limit.resetsAt) > Date.now()).map((limit) => `${limit.window} ${Math.round(limit.usedPct)}%`).join(" · ") || "limits not reported"}</span> : null}
    <div className="e">{agent.source === "registry" ? <>{agent.installed ? <Glyph g="done">Ready</Glyph> : null}<Action small ghost run={() => postJson(`/api/setup/agents/${agent.id}`, {}, "DELETE")} done={reload}>Remove</Action></>
      : agent.status === "Ready" ? <Glyph g="done">Ready</Glyph>
      : agent.status === "Install" ? <Action small ghost run={() => postJson("/api/setup/agents/install", { id: agent.id })} done={reload}>Install</Action>
      : <button className="btn sm" onClick={() => setLogin(agent.id as AgentId)}>Sign in</button>}</div>
  </div>;
  if (error) return <div className="agents"><Empty>Agents could not be checked. <button className="lnk" onClick={reload}>Check again</button></Empty></div>;
  if (!agents) return <div className="agents"><Empty>Checking which agents are installed…</Empty></div>;
  const installed = agents.filter((a) => a.installed);
  const others = agents.filter((a) => !a.installed);
  return <>
    <div className="agents">
      {installed.map(row)}
      {!installed.length ? <Empty>No agent is installed on this machine yet. Install one below.</Empty> : null}
      {others.length ? <details><summary className="sec-r" style={{ cursor: "pointer", borderTop: installed.length ? undefined : 0, fontSize: 14 }}><span className="lnk">Show {others.length} more {others.length === 1 ? "agent" : "agents"} you can install</span></summary>{others.map(row)}</details> : null}
    </div>
    {login ? <div className="agents" style={{ marginTop: 12 }}>
      <div className="sec-r"><AgentMark agent={login} /><b>Sign in to {AGENT_NAMES[login]}</b><div className="e"><button className="btn ghost sm" onClick={() => { setLogin(null); reload(); }}>Done</button></div></div>
      <div className="sec-r muted" style={{ fontSize: 13.5 }}>Follow the agent’s own login steps below. It runs on this machine, in your account.</div>
      <Suspense fallback={<Empty>Opening the login…</Empty>}><LoginTerminal login={login} onExit={() => { setLogin(null); reload(); }} /></Suspense>
    </div> : null}
  </>;
}
