import type { Lane, ProjectBranches } from "@contextlanes/protocol";
import { api, ClientError } from "./client.js";
import { addProject } from "./setup.js";

/** The agent's argv remains argv; --here is the wrapper's only option. */
export async function startCliLane(agent: "claude" | "codex", argv: string[]): Promise<Lane> {
  const remoteControl = agent === "claude" && argv.includes("--remote-control");
  const args = argv.filter((a) => a !== "--here" && !(remoteControl && a === "--remote-control"));
  const project = await addProject();
  const base = (await api<ProjectBranches>(`/api/projects/${project.id}/branches`)).defaultBranch ?? undefined;
  const lane = await api<Lane>("/api/lanes", { method: "POST", body: { project: project.id, agent: agent === "claude" ? "claude-code" : "codex", kind: "cli", direct: argv.includes("--here"), remoteControl, cliArgs: args, base, task: `${agent} ${args.join(" ")}`.trim() } });
  if (lane.state === "failed") throw new ClientError(`Lane ${lane.id} could not start. Open it in ContextLanes for the recorded error.`);
  return lane;
}
