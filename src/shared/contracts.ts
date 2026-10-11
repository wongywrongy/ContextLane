import { z } from 'zod';
export const id = z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/);
export const page = z.strictObject({
  snapshot: z.string().datetime().optional().describe('Snapshot timestamp returned by list_projects; reuse for subsequent pages.'),
  cursor: z.number().int().min(0).max(10000).default(0).describe('Offset from list_projects.nextCursor; omit for the first page.'),
  limit: z.number().int().min(1).max(50).default(25).describe('Maximum projects per page, up to 50.'),
});
const environmentId = id.describe('Managed environment/profile ID from locate.environments[].id, locate.instances[].id or request_environment.resolvedPreview.instanceId; not a project or checkout ID.');
const requestId = z.uuid().describe('New UUID for a new action. Reuse this UUID and identical payload when retrying the same action; durable retries return the original operation.');
const previewId = z.uuid().describe('Independent publication ID from publish_preview.previewId or get_project.previews[].previewId. Managed route IDs in locate.previews are not independent publications.');
export const mutation = z.strictObject({ environmentId, requestId });
export const environmentInput = z.strictObject({ environmentId });
export const logsInput = z.strictObject({
  environmentId,
  serviceId: id.describe('Recorded managed service ID from get_project.logServices[].serviceId or get_environment.services[].id.'),
  cursor: z
    .string()
    .max(512)
    .regex(/^[a-zA-Z0-9=;_:-]*$/)
    .optional().describe('Opaque cursor from get_logs.nextCursor; omit for the first page.'),
  limit: z.number().int().min(1).max(100).default(50).describe('Maximum journal lines, up to 100.'),
});
export const failure = z.strictObject({ code: z.string().max(80), message: z.string().max(1024), approvalUrl: z.url().optional() });
export const operation = z.strictObject({
  id: z.uuid(),
  environmentId: id,
  action: z.enum(['start', 'stop']),
  status: z.enum(['accepted', 'running', 'succeeded', 'partial', 'failed']),
  error: failure.nullable(),
  createdAt: z.string(),
  finishedAt: z.string().nullable(),
});
export const link = z.strictObject({
  label: z.string().max(200),
  url: z
    .url()
    .max(2048)
    .refine((v) => {
      const url = new URL(v);
      return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password;
    }),
});
export const agent = z.discriminatedUnion('source', [
  z.strictObject({ name: z.string(), source: z.literal('owner registration') }),
  z.strictObject({
    id: z.string().regex(/^[a-f0-9]{24}$/),
    name: z.enum(['Codex', 'Claude Code']),
    source: z.literal('detected process'),
    ports: z.array(z.number().int()).optional(),
    pid: z.number().int().positive().optional(),
    cwd: z.string().optional(),
    worktreePath: z.string().optional(),
    startedAt: z.string().datetime().optional(),
    checkoutId: id.optional(),
  }),
]);
export const httpObservation = z.strictObject({ status: z.number().int().min(100).max(599), checkedAt: z.string().datetime() });
export const processObservation = z.strictObject({
  name: z.string().max(120),
  pid: z.number().int().positive(),
  startedAt: z.string().datetime().optional(),
});
export const gitState = z.strictObject({
  dirty: z.number().int().min(0).nullable(),
  ahead: z.number().int().min(0).nullable(),
  behind: z.number().int().min(0).nullable(),
  lastCommit: z
    .strictObject({ sha7: z.string().regex(/^[a-f0-9]{7}$/), subject: z.string().max(120), committedAt: z.string().datetime({ offset: true }) })
    .nullable(),
});
export const recipeStatus = z.strictObject({
  found: z.boolean(),
  valid: z.boolean(),
  errors: z.array(failure),
  approval: z.enum(['none', 'pending', 'approved', 'stale']),
  approvalId: z.uuid().optional(),
  approvalUrl: z.url().optional(),
});
export const resolvedPreview = z.strictObject({
  instanceId: id,
  projectPath: z.string(),
  checkoutPath: z.string(),
  recipeHash: z.string().regex(/^[a-f0-9]{64}$/),
  toolchainRevision: z.string().regex(/^[a-f0-9]{64}$/),
  services: z.array(
    z.strictObject({
      id,
      command: z.array(z.string()),
      cwd: z.string(),
      envNames: z.array(z.string()),
      port: z.number().int(),
      readiness: z.strictObject({ path: z.string(), status: z.number().int(), bodyIncludes: z.string(), timeoutMs: z.number().int() }),
    }),
  ),
  previews: z.array(z.strictObject({ serviceId: id, label: z.string(), port: z.number().int(), url: z.url() })),
  setup: z.array(z.string()),
});
export const approvalReview = z.strictObject({
  id: z.uuid(),
  projectPath: z.string(),
  recipeHash: z.string(),
  toolchainRevision: z.string(),
  status: z.enum(['pending', 'approved', 'rejected']),
  requestedAt: z.string().datetime(),
  decidedAt: z.string().nullable(),
  decidedBy: z.string().nullable(),
  preview: resolvedPreview,
  stale: z.boolean(),
});
export const approvalsOutput = z.strictObject({ approvals: z.array(approvalReview).max(20) });
export type ApprovalReview = z.infer<typeof approvalReview>;
export const requestEnvironmentInput = z.strictObject({
  path: z
    .string()
    .max(4096)
    .refine((p) => p.startsWith('/') && !/[\0\r\n]/.test(p)).describe('Absolute working directory or checkout path on the Rootlane host; locate resolves the project and checkout.'),
  requestId,
});
export const requestEnvironmentOutput = z.strictObject({ status: z.enum(['approved', 'pending']), approvalUrl: z.url(), resolvedPreview });
export const project = z.strictObject({
  recipe: recipeStatus.optional(),
  routeSummaries: z
    .array(
      z.strictObject({
        url: z.url(),
        upstreamPort: z.number().int(),
        target: z.string(),
        route: z.enum(['matching', 'absent', 'conflict', 'unknown']),
      }),
    )
    .optional(),
  controls: z
    .array(
      z.strictObject({
        id,
        desiredState: z.enum(['running', 'stopped']),
        hasResources: z.boolean(),
        startAllowed: z.boolean(),
        latestOperation: operation.nullable(),
      }),
    )
    .optional(),
  id: z.string(),
  name: z.string(),
  path: z.string(),
  gitCommonDir: z.string().nullable(),
  branch: z.string().nullable(),
  detachedSha: z.string().optional(),
  git: gitState.optional(),
  devCommand: z.enum(['vite', 'next dev', 'nuxt dev', 'astro dev', 'webpack serve']).optional(),
  worktrees: z
    .array(
      z.strictObject({
        name: z.string(),
        path: z.string(),
        branch: z.string().nullable(),
        detachedSha: z.string().optional(),
        git: gitState.optional(),
        ports: z.array(z.number().int()),
      }),
    )
    .optional(),
  detached: z.boolean(),
  manifests: z.array(z.string()),
  observedPreviews: z.array(link).optional(),
  links: z.array(link),
  agents: z.array(agent),
  environmentIds: z.array(id),
  previewIds: z.array(z.uuid()).optional(),
  logServices: z.array(z.strictObject({ environmentId: id, serviceId: id })).default([]),
  runtime: z.strictObject({
    services: z.array(z.strictObject({ id, name: z.string(), port: z.number().int() })).default([]),
    status: z.enum(['listeners observed', 'no associated listener', 'unknown']),
    ports: z.array(z.number().int()),
    listeners: z
      .array(
        z.strictObject({
          port: z.number().int(),
          owner: z.literal('agent').optional(),
          startedBy: z.strictObject({ name: z.string(), pid: z.number().int().positive() }).optional(),
          worktreePath: z.string().optional(),
          checkoutId: id.optional(),
          loopback: z.boolean().optional(),
          process: processObservation.optional(),
          http: httpObservation.optional(),
        }),
      )
      .optional(),
    ownership: z.literal('observe-only'),
  }),
});
export const catalogOutput = z.strictObject({
  projects: z.array(project),
  nextCursor: z.number().nullable(),
  warnings: z.array(z.string()),
  observedAt: z.string(),
});
export const environmentOutput = z.strictObject({
  ports: z.record(z.string(), z.number().int()).optional(),
  previews: z.array(z.strictObject({ serviceId: id, label: z.string().optional(), port: z.number().int(), url: z.url() })).optional(),
  id,
  profileRevision: z.string(),
  effects: z.string(),
  dataRequirements: z.string(),
  startAllowed: z.boolean(),
  ownership: z.literal('rootlane'),
  desiredState: z.enum(['running', 'stopped']),
  application: z.enum(['ready', 'stopped', 'unhealthy', 'unknown']),
  preview: z.enum(['available', 'unavailable', 'unknown']),
  links: z.array(link),
  services: z.array(z.strictObject({ id, port: z.number().int().optional(), unit: z.string(), state: z.string() })),
  observedAt: z.string(),
  latestOperation: operation.nullable(),
  recentOperations: z.array(operation).max(10).optional(),
  previewRoutes: z
    .array(
      z.strictObject({
        upstream: z.enum(['ready', 'unready', 'unknown']).optional(),
        url: z.url(),
        target: z.string(),
        route: z.enum(['matching', 'absent', 'conflict', 'unknown']),
        verifiedAt: z.string().optional(),
        https: z.enum(['verified', 'unverified', 'failed']),
      }),
    )
    .optional(),
  observationError: failure.nullable(),
});
export const acceptedOutput = z.strictObject({ operation, ownership: z.literal('rootlane'), links: z.array(link).default([]) });
export const logsOutput = z.strictObject({
  lines: z.array(z.string().max(2048)).max(100),
  nextCursor: z.string().nullable(),
  truncated: z.boolean(),
});
export const emptyInput = z.strictObject({});
export const projectInput = z.strictObject({ projectId: id.describe('Project ID from locate.project.id or list_projects.projects[].id; not a checkout or environment ID.') });
export const publishInput = z.strictObject({ targetId: id.describe('Owner-approved publication target ID from locate.approvedTargetIds, get_project.approvedTargetIds or get_capabilities.approvalScope.previewTargetIds. Identifies the configured checkout and endpoint.'), requestId });
export const previewInput = z.strictObject({ previewId });
export const unpublishInput = previewInput.extend({ requestId });
export const previewOperation = operation
  .omit({ environmentId: true, action: true })
  .extend({ previewId: z.uuid(), action: z.enum(['publish', 'unpublish']) });
export const previewOutput = z.strictObject({
  id: z.uuid(),
  targetId: id,
  projectPath: z.string(),
  checkoutPath: z.string(),
  serviceId: id,
  serviceName: z.string(),
  port: z.number().int(),
  httpsPort: z.number().int(),
  target: z.string().optional(),
  ownership: z.literal('rootlane route only'),
  approved: z.boolean(),
  removed: z.boolean(),
  url: z.url(),
  route: z.enum(['matching', 'absent', 'conflict', 'unknown']),
  actualConfiguration: z.unknown(),
  upstream: z.enum(['ready', 'unready', 'unknown']),
  https: z.enum(['verified', 'unverified', 'failed']),
  errors: z.array(failure),
  observedAt: z.string(),
  verifiedAt: z.string().optional(),
  latestOperation: previewOperation.nullable(),
});
export const publicationOutput = z.strictObject({
  operation: previewOperation,
  previewId: z.uuid(),
  url: z.url(),
  verification: z.enum(['verified', 'unverified', 'failed']),
});
export const projectOutput = z.strictObject({
  project,
  checkoutIds: z.array(id),
  services: z.array(
    z.strictObject({
      checkoutId: id,
      serviceId: id.nullable(),
      name: z.string(),
      port: z.number().int(),
      source: z.enum(['owner reviewed', 'listener observation']),
      readiness: z.literal('unverified'),
    }),
  ),
  approvedTargetIds: z.array(id),
  previews: z.array(z.strictObject({ previewId: z.uuid(), checkoutId: id, serviceId: id })),
  logServices: z.array(z.strictObject({ environmentId: id, serviceId: id })),
  http: z.array(z.strictObject({ checkoutId: id, port: z.number().int(), http: httpObservation })).optional(),
});
export const capabilitiesOutput = z.strictObject({
  operations: z.array(z.string()),
  approvalScope: z.strictObject({
    lifecycleProfileIds: z.array(id),
    previewTargetIds: z.array(id),
    publication: z.literal('owner-approved targets only; discovery grants no approval'),
  }),
  observed: z.strictObject({
    listeners: z.enum(['available', 'unavailable']),
    routes: z.enum(['available', 'unavailable']),
    tailscale: z.enum(['connected', 'unavailable']),
    hostname: z.string().nullable(),
    guardedWrites: z.enum(['supported', 'unverified']),
    routeWritePermission: z.literal('unverified'),
    lifecyclePermission: z.literal('unverified'),
  }),
  blockers: z.array(failure),
  reconciling: z.boolean(),
  lastError: failure.nullable(),
  configError: failure.nullable(),
});
export type PreviewStatus = z.infer<typeof previewOutput>;
export type PreviewOperation = z.infer<typeof previewOperation>;
export type ProjectDetails = z.infer<typeof projectOutput>;
export const locateInput = z.strictObject({
  path: z
    .string()
    .max(4096)
    .refine((p) => p.startsWith('/') && !/[\0\r\n]/.test(p)).describe('Absolute working directory or checkout path on the Rootlane host; locate resolves the project and checkout.'),
});
export const operationsInput = z.strictObject({
  environmentId: environmentId.optional(),
  previewId: previewId.optional(),
  limit: z.number().int().min(1).max(20).default(10).describe('Maximum recent durable operations, up to 20; omit scope IDs to list all.'),
});
export const operationsOutput = z.strictObject({ operations: z.array(z.union([operation, previewOperation])).max(20) });
export const locateOutput = z.strictObject({
  recipe: recipeStatus.optional(),
  instances: z
    .array(
      z.strictObject({
        id,
        status: z.string(),
        checkoutPath: z.string(),
        ports: z.record(z.string(), z.number().int()),
        previews: z.array(z.strictObject({ serviceId: id, port: z.number().int(), url: z.url() })),
      }),
    )
    .optional(),
  project: z.strictObject({ id, name: z.string(), path: z.string() }),
  checkout: z.strictObject({ id, path: z.string(), branch: z.string().nullable(), detachedSha: z.string().optional() }),
  ports: z.array(z.strictObject({ port: z.number().int(), name: z.string() })),
  environments: z.array(z.strictObject({ id, status: z.string() })),
  approvedTargetIds: z.array(id),
  previews: z.array(z.strictObject({ id: z.uuid(), url: z.url() })),
});
export const toolContracts = {
  request_environment: {
    input: requestEnvironmentInput,
    output: requestEnvironmentOutput,
    description:
      'Validate a checkout recipe and request owner approval. Never approves, launches commands, or edits configuration. Reuse requestId on retry.',
    read: false,
  },
  locate: {
    input: locateInput,
    output: locateOutput,
    description:
      'Call locate with your working directory first. Resolve an absolute cwd to its observed project, checkout, services, reviewed environments and previews.',
    read: true,
  },
  list_operations: {
    input: operationsInput,
    output: operationsOutput,
    description: 'Read recent durable operation IDs, statuses and errors, newest first. Scope by environmentId or independent previewId. Poll get_environment or get_preview for current readiness.',
    read: true,
  },
  get_capabilities: {
    input: emptyInput,
    output: capabilitiesOutput,
    description:
      'Report approval scope, observed host capabilities, unverified permissions and actionable blockers. Discovery never approves publication.',
    read: true,
  },
  get_project: {
    input: projectInput,
    output: projectOutput,
    description: 'Identify a project, its checkouts, services, links, agent sources and approved publication target IDs.',
    read: true,
  },
  publish_preview: {
    input: publishInput,
    output: publicationOutput,
    description:
      'Publish an owner-approved, already running loopback service. Owns only the route; never launches applications. Returns a durable operation and previewId; poll get_preview. A returned URL may be unverified. Reuse requestId on retry.',
    read: false,
  },
  get_preview: {
    input: previewInput,
    output: previewOutput,
    description: 'Inspect recorded preview ownership, actual routing, upstream readiness and HTTPS verification separately.',
    read: true,
  },
  unpublish_preview: {
    input: unpublishInput,
    output: publicationOutput,
    description: 'Remove only a recorded matching preview route. Leaves the upstream application running. Returns a durable operation; poll get_preview for removal. Reuse requestId on retry.',
    read: false,
  },
  list_projects: {
    input: page,
    output: catalogOutput,
    description:
      'List real project directories, Git worktrees and known project links in approved observation roots. Existing services are observe-only.',
    read: true,
  },
  get_environment: {
    input: environmentInput,
    output: environmentOutput,
    description: 'Observe a Rootlane environment, readiness, preview links and its latest durable operation.',
    read: true,
  },
  start_environment: {
    input: mutation,
    output: acceptedOutput,
    description:
      'Start a reviewed environment by ID. Returns a durable operation immediately; poll get_environment for readiness. Reuse requestId on retries. Effects are defined by its owner-approved profile.',
    read: false,
  },
  stop_environment: {
    input: mutation,
    output: acceptedOutput,
    description: 'Stop only recorded Rootlane units and matching preview routes. Terminates running work. Returns a durable operation; poll get_environment. Reuse requestId on retries.',
    read: false,
  },
  get_logs: {
    input: logsInput,
    output: logsOutput,
    description: 'Read a bounded journal page for a recorded Rootlane service, including after failure.',
    read: true,
  },
} as const;
export type ToolName = keyof typeof toolContracts;
export type Operation = z.infer<typeof operation>;
export type Environment = z.infer<typeof environmentOutput>;
export type Project = z.infer<typeof project>;
export class Problem extends Error {
  constructor(
    public code: string,
    message: string,
    public approvalUrl?: string,
  ) {
    super(message.slice(0, 1024));
  }
}
export function problem(error: unknown): z.infer<typeof failure> {
  return error instanceof Problem
    ? { code: error.code, message: error.message, ...(error.approvalUrl ? { approvalUrl: error.approvalUrl } : {}) }
    : { code: 'INTERNAL_ERROR', message: 'Operation failed; consult the private Rootlane service journal.' };
}
