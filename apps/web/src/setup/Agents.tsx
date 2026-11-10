import { useEffect } from "react";
import type { DetectedAgent, UsageSummary } from "@contextlanes/protocol";
import { postJson } from "../api";
import { AGENT_NAMES, AgentMark, Cmd, Empty, Glyph } from "../components/ui";
import { Action } from "./ui";
/** How each built-in agent signs in from the machine's own shell. */
const SIGN_IN: Record<string, string> = { "claude-code": "claude", codex: "codex login" };

const STATUS: Record<DetectedAgent["status"], string> = { Ready: "signed in", Install: "not installed", "Sign in": "needs sign-in", Checking: "checking", "Won't start": "installed", "Not supported": "acts without asking" };

/** One row per agent: Ready, not installed, needs sign-in (with the command to run on the machine), or why it cannot run. */
export function AgentRows({ agents, error, reload, limits }: { agents: DetectedAgent[] | null; error: Error | null; reload: () => void; limits?: UsageSummary["limits"] }) {
  // Agents without a status command are asked over ACP in the background; look again until they answer.
  const checking = agents?.some((a) => a.status === "Checking") ?? false;
  useEffect(() => { if (!checking) return; const t = setTimeout(reload, 3000); return () => clearTimeout(t); }, [checking, agents, reload]);
  const action = (agent: DetectedAgent) => agent.status === "Ready" ? <Glyph g="done">Ready</Glyph>
    : agent.status === "Checking" ? <Glyph g="think">Checking</Glyph>
    : agent.status === "Not supported" ? <Glyph g="idle">Not supported</Glyph>
    : agent.status === "Install" ? <Glyph g={agent.source === "registry" ? "fail" : "idle"}>{agent.source === "registry" ? "Missing" : "Not installed"}</Glyph>
    : agent.status === "Won't start" ? <Glyph g="fail">Won’t start</Glyph>
    : SIGN_IN[agent.id] ? <Cmd note="sign in">{SIGN_IN[agent.id]!}</Cmd> : <Glyph g="wait">Sign in with its own CLI</Glyph>;
  const why = (agent: DetectedAgent) => agent.status === "Ready" || agent.status === "Install" || agent.status === "Checking" ? agent.support === "limited" ? agent.note : null : agent.detail ?? agent.note;
  const limitsOf = (agent: DetectedAgent) => (limits ?? []).filter((limit) => limit.agent === agent.id && Date.parse(limit.resetsAt) > Date.now()).map((limit) => `${limit.window} ${Math.round(limit.usedPct)}%`).join(" · ");
  const row = (agent: DetectedAgent) => <div className="sec-r" key={agent.id}>
    <AgentMark agent={agent.id} /><span style={{ minWidth: 0, flex: 1 }}><b>{agent.name ?? AGENT_NAMES[agent.id] ?? agent.id}</b><span className="st"> · {agent.source === "registry" ? "from the ACP registry" : STATUS[agent.status]}{agent.support === "limited" ? " · limited" : ""}</span>
      {why(agent) ? <span className="muted" style={{ display: "block", fontSize: 12.5 }}>{why(agent)}</span> : null}
      {agent.status === "Ready" && limitsOf(agent) ? <span className="mono muted" style={{ display: "block", fontSize: 12 }}>{limitsOf(agent)}</span> : null}</span>
    <div className="e">{action(agent)}{agent.source === "registry" ? <Action small ghost run={() => postJson(`/api/setup/agents/${agent.id}`, {}, "DELETE")} done={reload}>Remove</Action> : null}</div>
  </div>;
  if (error) return <div className="agents"><Empty>Agents could not be checked. <button className="lnk" onClick={reload}>Check again</button></Empty></div>;
  if (!agents) return <div className="agents"><Empty>Checking which agents are installed…</Empty></div>;
  const installed = agents.filter((a) => a.installed && a.status !== "Not supported");
  const others = agents.filter((a) => !installed.includes(a));
  return <>
    <div className="agents">
      {installed.map(row)}
      {!installed.length ? <Empty icon="execute" family="run">No agent installed · install Claude Code or Codex on the machine</Empty> : null}
      {others.length ? <details><summary className="sec-r" style={{ cursor: "pointer", borderTop: installed.length ? undefined : 0, fontSize: 14 }}><span className="lnk">Show {others.length} more {others.length === 1 ? "agent" : "agents"}</span></summary>{others.map(row)}</details> : null}
    </div>
  </>;
}
