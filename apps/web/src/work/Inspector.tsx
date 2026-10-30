import { useState } from "react";
import type { Lane, LaneEvent } from "@contextlanes/protocol";
import { postJson } from "../api";
import { Section } from "../components/ui";

export function Inspector({ lane, events }: { lane: Lane; events: LaneEvent[] }) {
  const session = events.findLast((e) => e.type === "agent.session");
  const usage = events.findLast((e) => e.type === "usage");
  const plan = events.findLast((e) => e.type === "agent.plan");
  const [notice, setNotice] = useState("");
  const control = async (kind: "mode" | "model", value: string) => {
    try { await postJson(`/api/lanes/${lane.id}/${kind}`, { [kind]: value }); setNotice("Change requested. The agent will confirm it here."); }
    catch (err) { setNotice(err instanceof Error ? err.message : "Could not change the agent setting."); }
  };
  return <>
    <Section title="Plan" meta={lane.goal ?? "this lane"}>
      {plan?.type === "agent.plan" ? <ol className="plan-list inspector-plan">{plan.payload.entries.map((entry, i) => <li key={i} className={entry.status}><span>{entry.status.replaceAll("_", " ")}</span>{entry.text}</li>)}</ol> : <p className="sec-b muted">The agent's plan appears here when it reports one.</p>}
    </Section>
    <Section title="Context" meta={lane.agent}>
      <div className="sec-b inspector-context">
        {session?.type === "agent.session" ? <>
          {session.payload.models.length ? <label>Model<select aria-label="Model" value={session.payload.currentModel ?? ""} onChange={(e) => void control("model", e.target.value)}>{session.payload.models.map((m) => <option value={m.id} key={m.id}>{m.label}</option>)}</select></label> : <p>Model: {lane.model ?? "Agent default"}</p>}
          {session.payload.modes.length ? <label>Mode<select aria-label="Mode" value={session.payload.currentMode ?? ""} onChange={(e) => void control("mode", e.target.value)}>{session.payload.modes.map((m) => <option value={m.id} key={m.id}>{m.label}</option>)}</select></label> : null}
        </> : <p className="muted">Agent settings appear after its session connects.</p>}
        {usage?.type === "usage" ? <><p className="mono">{usage.payload.contextUsed.toLocaleString()} / {usage.payload.contextSize.toLocaleString()} tokens</p><meter min={0} max={Math.max(1, usage.payload.contextSize)} value={usage.payload.contextUsed} aria-label="Reported context use" />{usage.payload.costUsd !== undefined ? <p>Reported cost: {new Intl.NumberFormat(undefined, { style: "currency", currency: "USD" }).format(usage.payload.costUsd)}</p> : null}</> : <p className="muted">Context use appears when the agent reports it.</p>}
        {notice ? <p role="status">{notice}</p> : null}
      </div>
    </Section>
    <Section title="Checkout"><div className="sec-b"><p className="mono inspector-path">{lane.branch}</p><p className="mono inspector-path">{lane.worktree}</p></div></Section>
    <Section title="Environment"><p className="sec-b muted">This lane's app services and private preview links arrive with recipes in phase 2.</p></Section>
  </>;
}
