import { useState } from "react";
import { Link, useNavigate } from "react-router";
import { laneTitle, routeTask, type DetectedAgent, type Lane, type Project, type ProjectBranches, type ServiceProposal, type SetupSettings } from "@contextlanes/protocol";
import { errorMessage, postJson, useJson } from "../api";
import { AGENT_NAMES, Dialog } from "./ui";

/** Start a lane: project, agent, base branch, optional goal, task. Used by setup and the New lane dialog. */
export function useLaneForm(projects: Project[], preset?: string, adoption?: ServiceProposal, initialTask?: string) {
  const [agents] = useJson<DetectedAgent[]>("/api/setup/agents");
  const [chosenProject, setProject] = useState(preset ?? "");
  const [chosenAgent, setAgent] = useState("");
  const [task, setTask] = useState(adoption ? `Adopt service on port ${adoption.port}` : initialTask ?? "");
  const [goal, setGoal] = useState("");
  const [chosenBase, setBase] = useState<{ project: string; branch: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const project = projects.find((p) => p.id === chosenProject) ?? projects[0];
  const ready = (agents ?? []).filter((a) => a.status === "Ready");
  // Routing (Models): until the owner picks an agent, the first rule whose words are in the task picks it.
  const [settings] = useJson<SetupSettings>("/api/setup/settings");
  const rule = !chosenAgent ? routeTask(settings?.routing ?? [], task) : null;
  const routed = rule && ready.some((a) => a.id === rule.agent) ? rule : null;
  const agent = ready.find((a) => a.id === (chosenAgent || routed?.agent)) ?? ready[0];
  const [branches, branchError] = useJson<ProjectBranches>(project ? `/api/projects/${project.id}/branches` : null);
  const base = chosenBase && chosenBase.project === project?.id && branches?.branches.includes(chosenBase.branch) ? chosenBase.branch : branches?.defaultBranch ?? "";
  const [lanes] = useJson<Lane[]>(project ? `/api/projects/${project.id}/lanes` : null);
  const goals = [...new Set((lanes ?? []).flatMap((l) => l.goal ? [l.goal] : []))];
  const navigate = useNavigate();
  const blocked = !agents ? "Checking agents…"
    : !ready.length ? "No agent is ready. Install or sign in to one under Models."
    : branchError ? "Branches could not be read for this repository."
    : branches && !branches.branches.length ? "This repository has no commits. Make a first commit, then start a lane." : "";
  // A whole plan is fine as the task: lists, the branch and the header use a short title, editable here.
  const long = task.trim().length > 80 || task.trim().includes("\n");
  const [title, setTitle] = useState<string | null>(null);
  const shownTitle = title ?? laneTitle(task);
  const canStart = !!project && !!agent && !!base && !!task.trim() && (!long || !!shownTitle.trim()) && !blocked && !busy;
  const start = async () => {
    setBusy(true); setError("");
    try {
      const lane = await postJson<Lane>("/api/lanes", { project: project!.id, agent: agent!.id, ...(routed?.model && agent!.id === routed.agent ? { model: routed.model } : {}), base, task: task.trim(), ...(long ? { title: shownTitle.trim().slice(0, 120) } : {}), ...(goal.trim() ? { goal: goal.trim() } : {}), ...(adoption ? { adoption } : {}) });
      navigate(`/p/${lane.project}/work?lane=${encodeURIComponent(lane.id)}`);
      return lane;
    } catch (e) { setError(errorMessage(e)); return null; } finally { setBusy(false); }
  };
  const fields = <div className="form">
    <div className="two">
      <label className="field">Project<select className="in" aria-label="Project" value={project?.id ?? ""} disabled={!!adoption} onChange={(e) => setProject(e.target.value)}>{projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
      <label className="field">Agent<select className="in" aria-label="Agent" value={agent?.id ?? ""} disabled={!ready.length} onChange={(e) => setAgent(e.target.value)}>{ready.map((a) => <option key={a.id} value={a.id}>{AGENT_NAMES[a.id] ?? a.id}</option>)}</select>{routed && agent?.id === routed.agent ? <span className="hint">picked by your routing rule{routed.model ? ` · ${routed.model}` : ""}</span> : null}</label>
    </div>
    <div className="two">
      <label className="field">Start from branch<select className="in" aria-label="Start from branch" value={base} disabled={!branches?.branches.length} onChange={(e) => setBase({ project: project!.id, branch: e.target.value })}>{branches?.branches.map((b) => <option key={b}>{b}</option>)}</select></label>
      <label className="field">Goal <span className="hint">optional · groups lanes</span><input className="in" list="lane-goals" value={goal} onChange={(e) => setGoal(e.target.value)} placeholder="For example: Billing v1" /><datalist id="lane-goals">{goals.map((g) => <option key={g} value={g} />)}</datalist></label>
    </div>
    <label className="field">Task <span className="hint">one line, or a whole plan in markdown; the agent gets all of it</span><textarea className="in" rows={long ? 10 : 4} value={task} onChange={(e) => setTask(e.target.value)} placeholder="For example: add a /health endpoint with a test" /></label>
    {long ? <label className="field">Title <span className="hint">what lists, the branch name and the lane header show</span><input className="in" value={shownTitle} maxLength={120} onChange={(e) => setTitle(e.target.value)} /></label> : null}
    {adoption ? <div><p>The outside copy keeps running. This lane proposes its own recipe for you to approve.</p><pre className="out">{JSON.stringify({ command: adoption.command, port: adoption.port, folder: adoption.cwd }, null, 2)}</pre></div> : null}
    {blocked && agents ? <p role="alert" style={{ margin: 0 }}>{blocked}{!ready.length ? <> <Link to="/models">Open Models</Link></> : null}</p> : null}
    {error ? <p role="alert" style={{ margin: 0 }}>{error}</p> : null}
  </div>;
  return { routed, fields, start, canStart, busy };
}

/** `onStarted` runs instead of `onClose` after a start, which has already navigated to the new lane. */
export function NewLaneDialog({ projects, project, onClose, onStarted, adoption, task }: { projects: Project[]; project?: string; onClose: () => void; onStarted?: () => void; adoption?: ServiceProposal; task?: string }) {
  const form = useLaneForm(projects, project, adoption, task);
  return <Dialog title="New lane" meta="its own branch, checkout, shell and agent" onClose={onClose}
    footer={<div className="e"><button className="btn ghost" onClick={onClose}>Cancel</button><button className="btn" disabled={!form.canStart} onClick={() => void form.start().then((lane) => { if (lane) (onStarted ?? onClose)(); })}>{form.busy ? "Starting…" : "Start lane"}</button></div>}>
    {form.fields}
  </Dialog>;
}
