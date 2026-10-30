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
export const LocalModel = z.object({ name: z.string().min(1).max(100), provider: z.enum(["ollama", "llama.cpp"]),
  url: z.url().refine((url) => { const u = new URL(url); return u.protocol === "http:" && u.hostname === "127.0.0.1"; }, "Use an HTTP endpoint on 127.0.0.1."),
});
export const SetupSettings = z.object({
  agents: z.record(z.string().regex(/^[\w-]+$/), AgentSpec).optional(),
  notifications: NotificationConfig.optional(), localModels: z.array(LocalModel).max(20).optional(),
  lanes: z.object({ maxConcurrent: z.number().int().min(1).max(100), launchHosts: z.boolean() }).optional(),
});
export type SetupSettings = z.infer<typeof SetupSettings>;
export const AgentId = z.enum(["claude-code", "codex", "opencode"]);
export type AgentId = z.infer<typeof AgentId>;
export const SetupStatus = z.object({ claimed: z.boolean(), authorized: z.boolean(), hasPasskey: z.boolean(),
  tailnetLogin: z.string().nullable(), publicUrl: z.string().nullable(), controlFile: z.string().optional(), hasLane: z.boolean(),
});
export type SetupStatus = z.infer<typeof SetupStatus>;
export const DetectedAgent = z.object({ id: AgentId, installed: z.boolean(), status: z.enum(["Ready", "Install", "Sign in"]) });
export type DetectedAgent = z.infer<typeof DetectedAgent>;
export const FolderQuery = z.object({ path: z.string().min(1).max(4096).default("~") });
export const Repository = z.object({ name: z.string(), path: z.string(), branch: z.string().nullable() });
export type Repository = z.infer<typeof Repository>;
export const RepositoryScan = z.object({ repositories: z.array(Repository), scanned: z.number().int(), limited: z.boolean() });
export type RepositoryScan = z.infer<typeof RepositoryScan>;
export const FolderListing = z.object({ path: z.string(), parent: z.string().nullable(), folders: z.array(z.object({ name: z.string(), path: z.string() })) });
export type FolderListing = z.infer<typeof FolderListing>;
export const ProjectBranches = z.object({ branches: z.array(z.string()), defaultBranch: z.string().nullable() });
export type ProjectBranches = z.infer<typeof ProjectBranches>;
