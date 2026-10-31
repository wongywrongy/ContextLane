import { z } from "zod";
import { AgentSpec } from "./commands.js";
import { NotificationConfig } from "./notifications.js";

const encoded = z.string().min(1).max(200_000).regex(/^[\w-]+$/);
export const Passkey = z.object({ id: encoded, publicKey: encoded, counter: z.number().int().nonnegative(), rpId: z.string().min(1), transports: z.array(z.string()).optional() });
export const RegistrationResponse = z.object({ id: encoded, rawId: encoded, type: z.literal("public-key"),
  response: z.object({ clientDataJSON: encoded, attestationObject: encoded, transports: z.array(z.string()).optional() }),
  clientExtensionResults: z.record(z.string(), z.unknown()), authenticatorAttachment: z.enum(["platform", "cross-platform"]).optional(),
});
export const AuthenticationResponse = z.object({ id: encoded, rawId: encoded, type: z.literal("public-key"),
  response: z.object({ clientDataJSON: encoded, authenticatorData: encoded, signature: encoded, userHandle: encoded.nullable().optional() }),
  clientExtensionResults: z.record(z.string(), z.unknown()), authenticatorAttachment: z.enum(["platform", "cross-platform"]).optional(),
});
export const RegisterOwnerRequest = z.object({ challengeId: z.uuid(), response: RegistrationResponse });
export const LoginOwnerRequest = z.object({ challengeId: z.uuid(), response: AuthenticationResponse });
export const SignInRequest = z.object({ token: z.string().regex(/^[\w-]{43}$/) });
export const SetupLink = z.object({ url: z.url(), expiresAt: z.iso.datetime(), messages: z.array(z.string()), tunnel: z.string().optional() });
export type SetupLink = z.infer<typeof SetupLink>;
/** What a local endpoint is used for. An endpoint with no roles takes every job. */
export const LocalRole = z.enum(["briefs", "helper", "insights", "ask", "tidy"]);
export type LocalRole = z.infer<typeof LocalRole>;
export const LOCAL_ROLES: Record<LocalRole, string> = { briefs: "Module briefs", helper: "Local helper (delegate)", insights: "Insights", ask: "Ask", tidy: "Grouping suggestions" };
export const LocalModel = z.object({ name: z.string().min(1).max(100), provider: z.enum(["ollama", "llama.cpp"]),
  /** A name for this endpoint, e.g. "neo 4090"; the same model may be served by several. */
  label: z.string().trim().max(40).optional(),
  roles: z.array(LocalRole).max(5).optional(),
  /** This machine, or another of yours on the tailnet (100.64.0.0/10 or a *.ts.net name), never the internet. */
  url: z.url().refine((url) => { const u = new URL(url); return ["http:", "https:"].includes(u.protocol) && (["127.0.0.1", "localhost"].includes(u.hostname) || u.hostname.endsWith(".ts.net") || /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d+\.\d+$/.test(u.hostname)); }, "Use an endpoint on this machine or on your tailnet."),
});
export type LocalModel = z.infer<typeof LocalModel>;
/** One job a local model ran for ContextLanes: which role asked, how long it took, and why it failed. */
export type LocalJob = { at: string; role: LocalRole | null; model: string; host: string; ms: number; ok: boolean; error: string | null; outputTokens: number | null };
/**
 * Models page: one served model per endpoint. working: a job is running now. ready: it answers (whether or
 * not the model is loaded, which `loaded` shows). down: it does not answer. The last job and today's count
 * say whether it has done anything.
 */
export type LocalModelStatus = { name: string; provider: "ollama" | "llama.cpp"; url: string; label: string | null; roles: LocalRole[]; local: boolean; state: "working" | "ready" | "down"; loaded: string[]; memory: number | null;
  gpu: { name: string; totalMb: number; usedMb: number } | null; waiting: number; running: boolean; detail: string | null;
  current: LocalRole | null; lastJob: LocalJob | null; lastFailure: LocalJob | null; today: { jobs: number; failed: number } };
/** Routing: which agent and model a new lane gets, by words in its task. The first rule that matches wins. */
export const RoutingRule = z.object({ words: z.array(z.string().trim().min(2).max(40)).min(1).max(20), agent: z.string().min(1).max(60), model: z.string().max(200).optional(), label: z.string().max(40).optional() });
export type RoutingRule = z.infer<typeof RoutingRule>;
export const routeTask = (rules: RoutingRule[], task: string): RoutingRule | null => {
  const text = task.toLowerCase();
  return rules.find((r) => r.words.some((w) => new RegExp(`\\b${w.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).test(text))) ?? null;
};

export const SetupSettings = z.object({
  routing: z.array(RoutingRule).max(30).optional(),
  agents: z.record(z.string().regex(/^[\w-]+$/), AgentSpec).optional(),
  notifications: NotificationConfig.optional(), localModels: z.array(LocalModel).max(20).optional(),
  lanes: z.object({ maxConcurrent: z.number().int().min(1).max(100), launchHosts: z.boolean() }).optional(),
});
export type SetupSettings = z.infer<typeof SetupSettings>;
/** An agent id: one ContextLanes has a profile for, or one added from the ACP registry. */
export const AgentId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,60}$/);
export type AgentId = z.infer<typeof AgentId>;
export const TicketRequest = z.object({ path: z.string().regex(/^\/api\/(stream|projects\/[\w-]+\/stream|lanes\/[\w-]+\/\d+\/terminal|setup\/agents\/[\w-]+\/terminal)$/) });
export const SetupStatus = z.object({ claimed: z.boolean(), authorized: z.boolean(), hasPasskey: z.boolean(), signedOut: z.boolean().default(false),
  tailnetLogin: z.string().nullable(), publicUrl: z.string().nullable(), controlFile: z.string().optional(), hasLane: z.boolean(),
});
export type SetupStatus = z.infer<typeof SetupStatus>;
/** Built-in agents (with their own install and sign-in) and agents added from the ACP registry. */
export const DetectedAgent = z.object({ id: z.string(), installed: z.boolean(),
  /** Checking: its command is there and ContextLanes is asking it over ACP whether you are signed in.
   *  Won't start: it is installed but crashed or did not answer; `detail` has its last words. */
  status: z.enum(["Ready", "Install", "Sign in", "Checking", "Won't start", "Not supported"]), source: z.enum(["built-in", "registry"]).default("built-in"),
  name: z.string().optional(), support: z.enum(["full", "limited", "unsupported"]).optional(), note: z.string().nullable().optional(),
  /** The agent's own words when it could not open a session (not signed in, missing provider). */
  detail: z.string().nullable().optional() });
export type DetectedAgent = z.infer<typeof DetectedAgent>;
export const FolderQuery = z.object({ path: z.string().min(1).max(4096).default("~") });
export const Repository = z.object({ name: z.string(), path: z.string(), branch: z.string().nullable(),
  /** Agents whose session history shows work in this repository. */
  usedBy: z.array(z.enum(["claude-code", "codex"])).default([]),
  lastUsed: z.iso.datetime().nullable().default(null),
  /** Why this repository cannot be used yet, in one sentence, or null. */
  note: z.string().nullable().default(null),
});
export type Repository = z.infer<typeof Repository>;
export const RepositoryScan = z.object({ repositories: z.array(Repository), scanned: z.number().int(), limited: z.boolean(),
  /** Large folders the walk did not enter (treated as data). The folder browser still opens them. */
  skipped: z.array(z.string()).default([]),
});
export type RepositoryScan = z.infer<typeof RepositoryScan>;
export const FolderListing = z.object({ path: z.string(), parent: z.string().nullable(), repo: z.boolean().default(false),
  folders: z.array(z.object({ name: z.string(), path: z.string(), repo: z.boolean().default(false) })),
});
export type FolderListing = z.infer<typeof FolderListing>;
export const ProjectBranches = z.object({ branches: z.array(z.string()), defaultBranch: z.string().nullable(), current: z.string().nullable().optional() });
/** Add repositories, GitHub tab: the owner's repositories through gh, cloned into the code folder. */
export const GithubRepo = z.object({ name: z.string(), description: z.string().nullable(), private: z.boolean(), updatedAt: z.string(), path: z.string(), cloned: z.boolean() });
export type GithubRepo = z.infer<typeof GithubRepo>;
export type GithubListing = { available: true; folder: string; repos: GithubRepo[] } | { available: false; reason: string };
export const CloneRequest = z.object({ repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/, "owner/name").refine((r) => !r.split("/").some((p) => p === "." || p === ".."), "owner/name") });
export type ProjectBranches = z.infer<typeof ProjectBranches>;

export const HelperKind = z.enum(["read", "edit", "check"]);
export type HelperKind = z.infer<typeof HelperKind>;
/** Models page, Local helper: each kind's use, how often the lead redid it, what it saved, and whether it is on. */
export type HelperStatus = { kind: HelperKind; model: string | null; uses: number; redoneRate: number | null; savedThisWeek: number; state: "on" | "near" | "off"; reason: string | null };
export const DelegateRequest = z.object({ kind: HelperKind, task: z.string().min(1).max(4000), files: z.array(z.string().min(1).max(500)).max(20).default([]) });
export const HelperToggle = z.object({ kind: HelperKind, on: z.boolean() });

/** Models → Add from ACP registry. */
export type RegistryAgent = { id: string; name: string; version: string; description: string; website: string | null; license: string | null; install: "npm" | "download" | "uv" | null; installed: boolean };
export const RegistryInstall = z.object({ id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,60}$/) });

/** A lane that starts on a schedule (a systemd user timer). It never merges; its result waits in the Inbox. */
export const Schedule = z.object({ id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,40}$/), project: z.string().min(1), task: z.string().min(1).max(4000), agent: z.string().min(1).max(60),
  model: z.string().max(200).optional(), mode: z.enum(["ask", "edits", "plan"]).default("ask"), base: z.string().regex(/^(?!-)(?!.*\.\.)[\w./-]+$/).default("main"),
  /** systemd OnCalendar, e.g. "Mon..Fri 07:30" or "*-*-* 02:00". */
  when: z.string().min(3).max(100).regex(/^[\w*.,:\-/ ~]+$/, "a systemd calendar expression") });
export type Schedule = z.infer<typeof Schedule>;
export type ScheduleView = Schedule & { next: string | null; lastLane: string | null };

/** A project skill every new lane gets, in the folder its agent reads skills from (SKILL.md with name and description). */
export const ProjectSkill = z.object({ name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,40}$/, "lowercase letters, digits and dashes"), description: z.string().trim().min(1).max(300), body: z.string().trim().min(1).max(20_000) });
export type ProjectSkill = z.infer<typeof ProjectSkill>;
