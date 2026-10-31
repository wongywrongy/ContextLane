import { AGENTS } from "@contextlanes/protocol";

/**
 * How to launch each agent as an ACP server over stdio. Each agent keeps its own login;
 * ContextLanes never proxies model traffic. Commands come from the ACP registry and can be
 * overridden in config.toml under [agents.<name>].
 */
export type AgentSpec = { command: string; args: string[]; env?: Record<string, string> };

export const DEFAULT_AGENTS: Record<string, AgentSpec> = Object.fromEntries(AGENTS.map((a) => [a.id, { command: a.command, args: a.args }]));

export function resolveAgent(name: string, overrides: Record<string, AgentSpec> = {}): AgentSpec {
  const spec = overrides[name] ?? DEFAULT_AGENTS[name];
  if (!spec) throw new Error(`unknown agent "${name}"; add it under [agents.${name}] in config.toml`);
  return spec;
}
