import { z } from 'zod';
export const id = z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/);
export const page = z.strictObject({ snapshot: z.string().datetime().optional(), cursor: z.number().int().min(0).max(10000).default(0), limit: z.number().int().min(1).max(50).default(25) });
export const mutation = z.strictObject({ environmentId: id, requestId: z.uuid() });
export const environmentInput = z.strictObject({ environmentId: id });
export const logsInput = z.strictObject({ environmentId: id, serviceId: id, cursor: z.string().max(512).regex(/^[a-zA-Z0-9=;_:-]*$/).optional(), limit: z.number().int().min(1).max(100).default(50) });
export const failure = z.strictObject({ code: z.string().max(80), message: z.string().max(1024) });
export const operation = z.strictObject({ id: z.uuid(), environmentId: id, action: z.enum(['start', 'stop']), status: z.enum(['accepted', 'running', 'succeeded', 'partial', 'failed']), error: failure.nullable(), createdAt: z.string(), finishedAt: z.string().nullable() });
export const link = z.strictObject({ label: z.string().max(200), url: z.url().max(2048).refine(v => { const url = new URL(v); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password; }) });
export const agent = z.discriminatedUnion('source', [z.strictObject({ name: z.string(), source: z.literal('owner registration') }), z.strictObject({ id: z.string().regex(/^[a-f0-9]{24}$/), name: z.enum(['Codex', 'Claude Code']), source: z.literal('detected process'), pid: z.number().int().positive().optional(), cwd: z.string().optional(), worktreePath: z.string().optional(), startedAt: z.string().datetime().optional(), checkoutId: id.optional() })]);
export const project = z.strictObject({ id: z.string(), name: z.string(), path: z.string(), gitCommonDir: z.string().nullable(), branch: z.string().nullable(), detachedSha: z.string().optional(), worktrees: z.array(z.strictObject({ name: z.string(), path: z.string(), branch: z.string().nullable(), detachedSha: z.string().optional(), ports: z.array(z.number().int()) })).optional(), detached: z.boolean(), manifests: z.array(z.string()), observedPreviews: z.array(link).optional(), links: z.array(link), agents: z.array(agent), environmentIds: z.array(id), previewIds: z.array(z.uuid()).optional(), logServices: z.array(z.strictObject({ environmentId: id, serviceId: id })).default([]), runtime: z.strictObject({ services: z.array(z.strictObject({ id, name: z.string(), port: z.number().int() })).default([]), status: z.enum(['listeners observed', 'no associated listener', 'unknown']), ports: z.array(z.number().int()), listeners: z.array(z.strictObject({ port: z.number().int(), worktreePath: z.string().optional() })).optional(), ownership: z.literal('observe-only') }) });
export const catalogOutput = z.strictObject({ projects: z.array(project), nextCursor: z.number().nullable(), warnings: z.array(z.string()), observedAt: z.string() });
export const environmentOutput = z.strictObject({ id, profileRevision: z.string(), effects: z.string(), dataRequirements: z.string(), startAllowed: z.boolean(), ownership: z.literal('rootlane'), desiredState: z.enum(['running', 'stopped']), application: z.enum(['ready', 'stopped', 'unhealthy', 'unknown']), preview: z.enum(['available', 'unavailable', 'unknown']), links: z.array(link), services: z.array(z.strictObject({ id, port: z.number().int().optional(), unit: z.string(), state: z.string() })), observedAt: z.string(), latestOperation: operation.nullable(), recentOperations: z.array(operation).max(10).optional(), previewRoutes: z.array(z.strictObject({ url: z.url(), target: z.string(), route: z.enum(['matching', 'absent', 'conflict', 'unknown']), verifiedAt: z.string().optional(), https: z.enum(['verified', 'unverified', 'failed']) })).optional(), observationError: failure.nullable() });
export const acceptedOutput = z.strictObject({ operation, ownership: z.literal('rootlane'), links: z.array(link).default([]) });
export const logsOutput = z.strictObject({ lines: z.array(z.string().max(2048)).max(100), nextCursor: z.string().nullable(), truncated: z.boolean() });
export const emptyInput = z.strictObject({});
export const projectInput = z.strictObject({ projectId: id });
export const publishInput = z.strictObject({ targetId: id, requestId: z.uuid() });
export const previewInput = z.strictObject({ previewId: z.uuid() });
export const unpublishInput = previewInput.extend({ requestId: z.uuid() });
export const previewOperation = operation.omit({ environmentId: true, action: true }).extend({ previewId: z.uuid(), action: z.enum(['publish', 'unpublish']) });
export const previewOutput = z.strictObject({
  id: z.uuid(), targetId: id, projectPath: z.string(), checkoutPath: z.string(), serviceId: id, serviceName: z.string(), port: z.number().int(), httpsPort: z.number().int(),
  ownership: z.literal('rootlane route only'), approved: z.boolean(), removed: z.boolean(), url: z.url(),
  route: z.enum(['matching', 'absent', 'conflict', 'unknown']), actualConfiguration: z.unknown(), upstream: z.enum(['ready', 'unready', 'unknown']),
  https: z.enum(['verified', 'unverified', 'failed']), errors: z.array(failure), observedAt: z.string(), verifiedAt: z.string().optional(), latestOperation: previewOperation.nullable()
});
export const publicationOutput = z.strictObject({ operation: previewOperation, previewId: z.uuid(), url: z.url(), verification: z.enum(['verified', 'unverified', 'failed']) });
export const projectOutput = z.strictObject({ project, checkoutIds: z.array(id), services: z.array(z.strictObject({ checkoutId: id, serviceId: id.nullable(), name: z.string(), port: z.number().int(), source: z.enum(['owner reviewed', 'listener observation']), readiness: z.literal('unverified') })), approvedTargetIds: z.array(id), previews: z.array(z.strictObject({ previewId: z.uuid(), checkoutId: id, serviceId: id })), logServices: z.array(z.strictObject({ environmentId: id, serviceId: id })) });
export const capabilitiesOutput = z.strictObject({ operations: z.array(z.string()), approvalScope: z.strictObject({ lifecycleProfileIds: z.array(id), previewTargetIds: z.array(id), publication: z.literal('owner-approved targets only; discovery grants no approval') }), observed: z.strictObject({ listeners: z.enum(['available', 'unavailable']), routes: z.enum(['available', 'unavailable']), tailscale: z.enum(['connected', 'unavailable']), hostname: z.string().nullable(), guardedWrites: z.enum(['supported', 'unverified']), routeWritePermission: z.literal('unverified'), lifecyclePermission: z.literal('unverified') }), blockers: z.array(failure), reconciling: z.boolean(), lastError: failure.nullable(), configError: failure.nullable() });
export type PreviewStatus = z.infer<typeof previewOutput>;
export type PreviewOperation = z.infer<typeof previewOperation>;
export type ProjectDetails = z.infer<typeof projectOutput>;
export const toolContracts = {
  get_capabilities: { input: emptyInput, output: capabilitiesOutput, description: 'Report approval scope, observed host capabilities, unverified permissions and actionable blockers. Discovery never approves publication.', read: true },
  get_project: { input: projectInput, output: projectOutput, description: 'Identify a project, its checkouts, services, links, agent sources and approved publication target IDs.', read: true },
  publish_preview: { input: publishInput, output: publicationOutput, description: 'Publish an owner-approved, already running loopback service. Owns only the route; never launches applications. Reuse requestId on retry, then inspect get_preview.', read: false },
  get_preview: { input: previewInput, output: previewOutput, description: 'Inspect recorded preview ownership, actual routing, upstream readiness and HTTPS verification separately.', read: true },
  unpublish_preview: { input: unpublishInput, output: publicationOutput, description: 'Remove only a recorded matching preview route. Leaves the upstream application running. Reuse requestId on retry.', read: false },
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
