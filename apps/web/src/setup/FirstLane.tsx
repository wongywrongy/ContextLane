import { useState } from "react";
import { useNavigate } from "react-router";
import type { DetectedAgent, Lane, Project, ProjectBranches } from "@contextlanes/protocol";
import { postJson, RequestError, useJson } from "../api";
import { Section } from "../components/ui";
import { Action } from "./ui";

export function FirstLane({ projects, agents }: { projects: Project[]; agents: DetectedAgent[] }) {
  const [chosenProject, setProject] = useState(""); const [chosenAgent, setAgent] = useState("");
  const [task, setTask] = useState(""); const [chosenBase, setBase] = useState<{ project: string; branch: string } | null>(null);
  const project = projects.find((p) => p.id === chosenProject) ?? projects[0];
  const ready = agents.filter((a) => a.status === "Ready");
  const agent = ready.find((a) => a.id === chosenAgent) ?? ready[0];
  const [branches, error] = useJson<ProjectBranches>(project ? `/api/projects/${project.id}/branches` : null);
  const base = chosenBase && chosenBase.project === project?.id && branches?.branches.includes(chosenBase.branch) ? chosenBase.branch : branches?.defaultBranch ?? "";
  const navigate = useNavigate();
  return <Section title="First lane" meta="A separate checkout, shell and agent session"><div className="setup-body">
    <label>Project<select aria-label="Project" value={project?.id ?? ""} onChange={(e) => setProject(e.target.value)}>{projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
    <label>Agent<select aria-label="Agent" value={agent?.id ?? ""} onChange={(e) => setAgent(e.target.value)}>{ready.map((a) => <option key={a.id} value={a.id}>{a.id === "claude-code" ? "Claude Code" : a.id === "codex" ? "Codex" : "OpenCode"}</option>)}</select></label>
    <label>Base branch<select aria-label="Base branch" value={base} disabled={!branches?.branches.length || !!error} onChange={(e) => setBase({ project: project!.id, branch: e.target.value })}>{branches?.branches.map((b) => <option key={b}>{b}</option>)}</select></label>
    {error ? <p role="alert">Branches could not be read. Return to Project and choose another repository.</p> : branches && !branches.branches.length ? <p role="alert">This repository has no commits. Make its first commit, then return to setup.</p> : null}
    <label>Task<textarea value={task} onChange={(e) => setTask(e.target.value)} placeholder="For example: add a /health endpoint and a test for it" rows={4} /></label>
    <Action disabled={!project || !agent || !base || !task.trim() || !!error} run={async () => {
      const lane = await postJson<Lane>("/api/lanes", { project: project!.id, agent: agent!.id, base, task });
      if (lane.state === "failed") throw new RequestError("Lane setup failed; open Work to inspect the events and try again.");
      navigate(`/p/${lane.project}/work?lane=${lane.id}`);
    }}>Start lane</Action>
  </div></Section>;
}
