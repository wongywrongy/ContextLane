import { z } from 'zod';
export const id = z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/);
export const page = z.strictObject({ cursor: z.number().int().min(0).max(10000).default(0), limit: z.number().int().min(1).max(50).default(25) });
export const mutation = z.strictObject({ environmentId: id, requestId: z.uuid() });
export const environmentInput = z.strictObject({ environmentId: id });
export const logsInput = z.strictObject({ environmentId: id, serviceId: id, cursor: z.string().max(512).regex(/^[a-zA-Z0-9=;_:-]*$/).optional(), limit: z.number().int().min(1).max(100).default(50) });
export const failure = z.strictObject({ code: z.string().max(80), message: z.string().max(1024) });
export const operation = z.strictObject({ id: z.uuid(), environmentId: id, action: z.enum(['start', 'stop']), status: z.enum(['accepted', 'running', 'succeeded', 'partial', 'failed']), error: failure.nullable(), createdAt: z.string(), finishedAt: z.string().nullable() });
export const link = z.strictObject({ label: z.string().max(200), url: z.url().max(2048).refine(v => { const url = new URL(v); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password; }) });
export const agent = z.discriminatedUnion('source', [z.strictObject({ name: z.string(), source: z.literal('owner registration') }), z.strictObject({ id: z.string().regex(/^[a-f0-9]{24}$/), name: z.enum(['Codex', 'Claude Code']), source: z.literal('detected process') })]);
export const project = z.strictObject({ id: z.string(), name: z.string(), path: z.string(), gitCommonDir: z.string().nullable(), branch: z.string().nullable(), detached: z.boolean(), manifests: z.array(z.string()), links: z.array(link), agents: z.array(agent), environmentIds: z.array(id), runtime: z.strictObject({ status: z.enum(['listeners observed', 'no associated listener', 'unknown']), ports: z.array(z.number().int()), ownership: z.literal('observe-only') }) });
export const catalogOutput = z.strictObject({ projects: z.array(project), nextCursor: z.number().nullable(), warnings: z.array(z.string()), observedAt: z.string() });
export const environmentOutput = z.strictObject({ id, profileRevision: z.string(), effects: z.string(), dataRequirements: z.string(), startAllowed: z.boolean(), ownership: z.literal('rootlane'), desiredState: z.enum(['running', 'stopped']), application: z.enum(['ready', 'stopped', 'unhealthy', 'unknown']), preview: z.enum(['available', 'unavailable', 'unknown']), links: z.array(link), services: z.array(z.strictObject({ id, unit: z.string(), state: z.string() })), observedAt: z.string(), latestOperation: operation.nullable(), observationError: failure.nullable() });
export const acceptedOutput = z.strictObject({ operation, ownership: z.literal('rootlane'), links: z.array(link).default([]) });
export const logsOutput = z.strictObject({ lines: z.array(z.string().max(2048)).max(100), nextCursor: z.string().nullable(), truncated: z.boolean() });
export const toolContracts = {
  list_projects: { input: page, output: catalogOutput, description: 'List real project directories, Git worktrees and known project links in approved observation roots. Existing services are observe-only.', read: true },
  get_environment: { input: environmentInput, output: environmentOutput, description: 'Observe a Rootlane environment, readiness, preview links and its latest durable operation.', read: true },
  start_environment: { input: mutation, output: acceptedOutput, description: 'Start a reviewed environment by ID. Returns a durable operation immediately; poll get_environment for readiness. Reuse requestId on retries. Effects are defined by its owner-approved profile.', read: false },
  stop_environment: { input: mutation, output: acceptedOutput, description: 'Stop only recorded Rootlane units and matching preview routes. Terminates running work. Reuse requestId on retries.', read: false },
  get_logs: { input: logsInput, output: logsOutput, description: 'Read a bounded journal page for a recorded Rootlane service, including after failure.', read: true }
} as const;
export type ToolName = keyof typeof toolContracts;
export type Operation = z.infer<typeof operation>;
export type Environment = z.infer<typeof environmentOutput>;
export type Project = z.infer<typeof project>;
export class Problem extends Error {
  constructor(public code: string, message: string) { super(message.slice(0, 1024)); }
}
export function problem(error: unknown): z.infer<typeof failure> {
  return error instanceof Problem ? { code: error.code, message: error.message } : { code: 'INTERNAL_ERROR', message: 'Operation failed; consult the private Rootlane service journal.' };
}
