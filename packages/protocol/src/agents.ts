/**
 * The coding agents ContextLanes knows how to run, and what each needs: how to install and launch it, how
 * you sign in, which of its own modes mean "ask first", "edit the checkout" and "plan only", and anything it
 * must be told so that it asks before acting. Facts come from each adapter's source or official docs
 * (October 2026, the ACP registry's pinned versions); anything an agent reports over ACP at run time wins.
 *
 * Support levels:
 * - full: permission prompts, modes and output were checked against the agent's source.
 * - limited: it runs and asks permission, with gaps the note names.
 * - unsupported: it runs tools without asking you, which lanes never allow (AGENTS.md: agents never approve).
 */
export type LaneMode = "ask" | "edits" | "plan";

export type AgentProfile = {
  id: string;
  name: string;
  /** Two letters for the agent mark. */
  mark: string;
  /** Its id in the ACP registry, when different. */
  registry?: string;
  /** How ContextLanes installs it: npm packages (adapter first), or the registry's checked download. */
  install: { npm: string[] } | { registry: true };
  /** The ACP server command once installed (in ~/.local/bin for npm installs). */
  command: string;
  args: string[];
  /** Its own CLI and the arguments that sign you in, run in a terminal on the Models page. */
  cli?: string;
  login?: string[];
  support: "full" | "limited" | "unsupported";
  note?: string;
  /** Its mode ids for each lane mode, best first. Missing: ContextLanes matches by name. */
  modes?: Partial<Record<LaneMode, string[]>>;
  /** Modes that let something other than you approve, beyond the words SafeMode already refuses. */
  unsafeModes?: string[];
  /** When its modes are a session config option rather than ACP modes. */
  modeOption?: string;
  /** A config option and value that together with the mode mean "plan only" (Codex's collaboration mode). */
  planOption?: { id: string; value: string };
  /** Config options forced to these values at the start of every session: switches that turn prompts off. */
  force?: Record<string, string | boolean>;
  /** Environment per lane mode, for agents whose permissions are set at start (OpenCode, goose). */
  env?: Partial<Record<LaneMode, Record<string, string>>>;
};

const ASK = JSON.stringify({ edit: "ask", bash: "ask", webfetch: "ask", external_directory: "ask" });
const EDITS = JSON.stringify({ edit: "allow", bash: "ask", webfetch: "ask", external_directory: "ask" });

export const AGENTS: AgentProfile[] = [
  { id: "claude-code", name: "Claude Code", mark: "CC", registry: "claude-acp", install: { npm: ["@agentclientprotocol/claude-agent-acp@0.99.1", "@anthropic-ai/claude-code@2.1.314"] },
    command: "claude-agent-acp", args: [], cli: "claude", login: ["auth", "login"], support: "full",
    modes: { ask: ["default"], edits: ["acceptEdits"], plan: ["plan"] } },
  { id: "codex", name: "Codex", mark: "CX", registry: "codex-acp", install: { npm: ["@agentclientprotocol/codex-acp@2.5.0", "@openai/codex@0.166.0"] },
    command: "codex-acp", args: [], cli: "codex", login: ["login", "--device-auth"], support: "full",
    modes: { ask: ["read-only"], edits: ["workspace-write"], plan: ["read-only"] }, unsafeModes: ["agent", "agent-full-access"],
    planOption: { id: "collaboration_mode", value: "plan" } },
  { id: "gemini", name: "Gemini CLI", mark: "GE", install: { npm: ["@google/gemini-cli@0.66.0"] }, command: "gemini", args: ["--acp"], cli: "gemini", login: [], support: "full",
    note: "Sign in by running gemini once in a terminal, or set GEMINI_API_KEY. Edit the checkout needs the folder trusted in Gemini; otherwise it asks.",
    modes: { ask: ["default"], edits: ["autoEdit"], plan: ["plan"] } },
  { id: "github-copilot", name: "GitHub Copilot", mark: "GH", registry: "github-copilot-cli", install: { npm: ["@github/copilot@1.0.105"] }, command: "copilot", args: ["--acp"], cli: "copilot", login: ["login"], support: "full",
    modes: { ask: ["agent"], plan: ["plan"] }, unsafeModes: ["autopilot"], force: { allow_all: "off" } },
  { id: "opencode", name: "OpenCode", mark: "OC", install: { npm: ["opencode-ai@1.19.5"] }, command: "opencode", args: ["acp"], cli: "opencode", login: ["auth", "login"], support: "full",
    note: "Its build agent allows everything by default; lanes start it with permissions that ask.",
    modeOption: "mode", modes: { ask: ["build"], edits: ["build"], plan: ["plan"] }, env: { ask: { OPENCODE_PERMISSION: ASK }, edits: { OPENCODE_PERMISSION: EDITS }, plan: { OPENCODE_PERMISSION: ASK } } },
  { id: "qwen-code", name: "Qwen Code", mark: "QW", install: { npm: ["@qwen-code/qwen-code@0.26.4"] }, command: "qwen", args: ["--acp"], cli: "qwen", login: [], support: "full",
    note: "Sign in by running qwen and /auth in a terminal, or set OPENAI_API_KEY.", modes: { ask: ["default"], edits: ["auto-edit"], plan: ["plan"] } },
  { id: "factory-droid", name: "Factory Droid", mark: "FD", install: { npm: ["droid@1.0.0"] }, command: "droid", args: ["exec", "--output-format", "acp-daemon"], cli: "droid", login: [], support: "full",
    note: "Sign in by running droid in a terminal, or set FACTORY_API_KEY.",
    modeOption: "autonomy_level", modes: { ask: ["normal"], edits: ["auto-low"], plan: ["spec"] }, unsafeModes: ["auto-medium", "auto-high"] },
  { id: "goose", name: "goose", mark: "GO", install: { registry: true }, command: "goose", args: ["acp"], cli: "goose", login: ["configure"], support: "full",
    note: "Its default approves everything; lanes start it in approve mode.",
    modes: { ask: ["approve"], edits: ["approve"], plan: ["chat"] }, unsafeModes: ["smart_approve"], env: { ask: { GOOSE_MODE: "approve" }, edits: { GOOSE_MODE: "approve" }, plan: { GOOSE_MODE: "chat" } } },
  { id: "mistral-vibe", name: "Mistral Vibe", mark: "MV", install: { registry: true }, command: "vibe-acp", args: [], cli: "vibe-acp", login: ["--setup"], support: "full",
    note: "No plan mode; Plan only asks before every change instead.", modes: { ask: ["ask"], edits: ["accept-edits"], plan: ["ask"] } },
  { id: "kimi", name: "Kimi CLI", mark: "KI", install: { registry: true }, command: "kimi", args: ["acp"], cli: "kimi", login: ["login"], support: "limited",
    note: "One mode only (asks before acting); no effort setting or usage reports.", modes: { ask: ["default"], edits: ["default"], plan: ["default"] } },
  { id: "cursor", name: "Cursor", mark: "CU", install: { registry: true }, command: "cursor-agent", args: ["acp"], cli: "cursor-agent", login: ["login"], support: "limited",
    note: "Cursor's own plan and question requests are not shown in ContextLanes yet.", modes: { ask: ["agent"], edits: ["agent"], plan: ["plan", "ask"] } },
  { id: "cline", name: "Cline", mark: "CL", install: { npm: ["cline@3.0.74"] }, command: "cline", args: ["--acp"], cli: "cline", login: ["auth"], support: "limited",
    note: "Ignores the tools ContextLanes gives agents (get_brief, checkpoint); Ask for review still works.", modes: { ask: ["act"], edits: ["act"], plan: ["plan"] }, force: { auto_approve: false } },
  { id: "auggie", name: "Auggie", mark: "AU", install: { npm: ["@augmentcode/auggie@0.36.0"] }, command: "auggie", args: ["--acp"], cli: "auggie", login: ["login"], support: "unsupported",
    note: "Runs tools without asking you unless you write its permission rules, so lanes cannot run it." },
  { id: "amp", name: "Amp", mark: "AM", registry: "amp-acp", install: { registry: true }, command: "amp-acp", args: [], cli: "amp", login: ["login"], support: "unsupported",
    note: "Never asks permission over ACP, so lanes cannot run it." },
];

/** The profile for an agent id or its registry id; null for agents ContextLanes has no notes on. */
export function agentProfile(id: string | null | undefined): AgentProfile | null {
  if (!id) return null;
  return AGENTS.find((a) => a.id === id || a.registry === id) ?? null;
}

/** Mode ids that usually mean each lane mode, for agents without a profile, matched against ids and names. */
export const GENERIC_MODES: Record<LaneMode, RegExp> = {
  ask: /^(default|ask|manual|approve|normal|read-?only|on-?request|act|agent|build|code)$/i,
  edits: /^(accept-?edits|auto-?edit|workspace-?write|edit|edits|auto-low)$/i,
  plan: /^(plan|spec|architect|read-?only|chat)$/i,
};

/** Config options (by id or name) that turn permission prompts off; set off at the start of every session. */
export const UNSAFE_OPTION = /allow.?all|auto.?approv|bypass|yolo|skip.?permission|dangerous/i;

/** What an agent says about itself over ACP without a prompt (contextlanes-lanehost --probe). */
export type AgentProbe = {
  /** ready: a session opened. signin: the agent asked for authentication. broken: it did not start or answer. */
  state: "ready" | "signin" | "broken";
  name: string | null;
  version: string | null;
  protocolVersion: number | null;
  /** How the agent says you sign in: its auth methods, with the terminal command when it offers one. */
  auth: { id: string; name: string; command?: string; args?: string[] }[];
  capabilities: { images: boolean; loadSession: boolean; additionalDirectories: boolean; mcpHttp: boolean };
  modes: { id: string; name: string; description: string | null }[];
  options: { id: string; name: string; category: string | null; values: string[] }[];
  /** The agent's own words when it could not open a session, trimmed. */
  error: string | null;
};
