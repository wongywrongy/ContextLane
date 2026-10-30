import { lazy, Suspense, useState } from "react";
import type { AgentId, DetectedAgent } from "@contextlanes/protocol";
import { postJson } from "../api";
import { Section, AgentMark, Empty } from "../components/ui";
import { Action } from "./ui";
const LoginTerminal = lazy(() => import("../components/Terminal").then((module) => ({ default: module.Terminal })));
const names = { "claude-code": "Claude Code", codex: "Codex", opencode: "OpenCode" };

export function AgentsSection({ agents, error, reload }: { agents: DetectedAgent[] | null; error: Error | null; reload: () => void }) {
  const [login, setLogin] = useState<AgentId | null>(null);
  const row = (agent: DetectedAgent) => <div className="sec-r agent-row" key={agent.id}>
    <AgentMark agent={agent.id} /><strong>{names[agent.id]}</strong>
    {agent.status === "Ready" ? <span className="setup-state"><i className="g merged" />Ready</span> : agent.status === "Install" ?
      <Action run={() => postJson("/api/setup/agents/install", { id: agent.id })} done={reload}>Install</Action> :
      <button className="btn" onClick={() => setLogin(agent.id)}>Sign in</button>}
  </div>;
  return <>
    <Section title="Agents" meta="Choose one to get started" end={<button className="btn ghost" onClick={reload}>Check again</button>}>
      {error ? <Empty>Agents could not be checked. Choose Check again.</Empty> : !agents ? <Empty>Checking agents…</Empty> : <>
        {agents.filter((a) => a.installed).map(row)}
        {!agents.some((a) => a.installed) && <Empty>Install an agent below to get started.</Empty>}
        {agents.some((a) => !a.installed) && <details className="other-agents"><summary>Other agents</summary>{agents.filter((a) => !a.installed).map(row)}</details>}
      </>}
    </Section>
    {login && <Section title={`Sign in to ${names[login]}`} end={<button className="btn ghost" onClick={() => { setLogin(null); reload(); }}>Close login</button>}>
      <div className="sec-b">Follow the agent’s login instructions in this terminal, then choose Check again.</div>
      <Suspense fallback={<Empty>Opening login terminal…</Empty>}><LoginTerminal login={login} onExit={reload} /></Suspense>
    </Section>}
  </>;
}
