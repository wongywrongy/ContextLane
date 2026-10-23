import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { failure, toolContracts, type ToolName, Problem, problem } from '../shared/contracts.js';
import { boundedText } from '../host/linux.js';
export function createMcpServer(base: string, credential: string, request: typeof fetch = fetch, parentPid = process.ppid) {
  const url = new URL(base);
  if (
    url.protocol !== 'http:' ||
    url.hostname !== '127.0.0.1' ||
    url.pathname !== '/' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    credential.length < 32
  )
    throw new Error('MCP requires a loopback backend origin and a private agent credential');
  const server = new McpServer(
    { name: 'rootlane', version: '0.9.0' },
    {
      instructions:
        'Observe: locate with your absolute cwd, then get_project or get_environment as needed. Observation is read-only; do not request approval or start anything. Reuse existing observedPreviews links; these have no publication previewId and must not be republished or unpublished. Publish a running service: locate → get_capabilities and identify an owner-approved target → publish_preview → poll get_preview. Publication owns only its recorded route, never application processes. A returned URL may be unverified. Start a managed environment: locate → request_environment and owner approval at approvalUrl when required → start_environment → poll get_environment. Never approve yourself, edit owner configuration, or bypass checks. Use inspect_environment to inspect configuration proposals and preparation blockers without executing setup; ask the owner to save or approve them. Recover approved recorded resources with recover_environment; healthy applications remain running during preview repair. Start, stop, recover, publish and unpublish return durable operations; list_operations shows recent history. Keep the same requestId and payload when retrying the same action. Tools share the authenticated Rootlane backend; no MCP resources, remote application APIs or client session handoffs are provided.',
    },
  );
  for (const name of Object.keys(toolContracts) as ToolName[]) {
    const contract = toolContracts[name];
    const inputSchema: z.ZodObject = contract.input;
    const outputSchema: z.ZodObject = contract.output;
    server.registerTool(
      name,
      {
        description: contract.description,
        inputSchema,
        outputSchema,
        annotations: {
          readOnlyHint: contract.read,
          destructiveHint: name === 'stop_environment' || name === 'unpublish_preview',
          idempotentHint: true,
          openWorldHint: !contract.read || name === 'get_environment' || name === 'get_preview' || name === 'get_capabilities',
        },
      },
      async (input) => {
        try {
          const validation = contract.input.safeParse(input);
          if (!validation.success) throw new Problem('INVALID_INPUT', 'Check the tool input schema and identifier sources; use an absolute path or valid returned ID.');
          const parsed = validation.data;
          let response: Response;
          try {
            response = await request(new URL(`/api/tools/${name}`, url), {
              method: 'POST',
              headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/json', ...(Number.isInteger(parentPid) && parentPid > 0 && parentPid <= 2147483647 ? { 'x-rootlane-parent-pid': String(parentPid) } : {}) },
              body: JSON.stringify(parsed),
              signal: AbortSignal.timeout(10000),
              redirect: 'error',
            });
          } catch (error) {
            const timedOut = error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name);
            throw new Problem(
              timedOut ? 'BACKEND_TIMEOUT' : 'BACKEND_UNAVAILABLE',
              timedOut
                ? 'Rootlane did not respond within 10 seconds. Inspect status, then retry the same action with the same requestId.'
                : 'Cannot connect to Rootlane. Check the existing backend service and adapter configuration; retry mutations with the same requestId.',
            );
          }
          let body: unknown;
          try {
            body = JSON.parse(await boundedText(response, name === 'get_agent_sessions' ? 32 * 1024 * 1024 : 512 * 1024));
          } catch (error) {
            if (error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name)) throw new Problem('BACKEND_TIMEOUT', 'Rootlane response timed out. Inspect status, then retry mutations with the same requestId.');
            throw new Problem('BACKEND_INVALID_RESPONSE', 'Rootlane returned an unreadable or oversized response. Check backend health and matching adapter versions; retry mutations with the same requestId.');
          }
          if (!response.ok) {
            const error = failure.safeParse(body);
            throw new Problem(
              error.success ? error.data.code : 'BACKEND_INVALID_RESPONSE',
              error.success ? recovery(error.data.code, error.data.message) : 'Rootlane returned an invalid error response. Check backend health and matching adapter versions.',
              error.success ? error.data.approvalUrl : undefined,
            );
          }
          const result = contract.output.safeParse(body);
          if (!result.success) throw new Problem('BACKEND_INVALID_RESPONSE', 'Rootlane response does not match this tool schema. Check backend health and matching adapter versions; retry mutations with the same requestId.');
          const output = result.data;
          if ('operation' in output && output.operation.error) output.operation.error.message = recovery(output.operation.error.code, output.operation.error.message);
          return {
            ...('operation' in output && ['failed', 'partial'].includes(output.operation.status) ? { isError: true } : {}),
            structuredContent: output,
            content: [{ type: 'text' as const, text: JSON.stringify(output) }],
          };
        } catch (error) {
          const detail =
            error instanceof Problem
              ? problem(error)
              : {
                  code: 'INTERNAL_ERROR',
                  message: 'The Rootlane adapter could not complete the call. Check adapter health; retry mutations with the same requestId.',
                };
          return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify(detail) }] };
        }
      },
    );
  }
  return server;
}

function recovery(code: string, message: string) {
  const guidance: Record<string, string> = {
    APPROVAL_REQUIRED: 'Request a new environment review if the recipe changed, then ask the owner to review the returned approvalUrl; agents cannot approve.',
    TARGET_NOT_APPROVED: 'Use get_capabilities and get_project to find an approved target; ask the owner to review configuration.',
    LOCAL_TARGET_REQUIRED: 'Unattributable listeners, including Docker published ports, require owner inspection. Reuse existing get_project project.observedPreviews links; do not republish them or restart services to bypass attribution checks.',
    ROUTE_CONFLICT: 'Inspect get_preview if you have a recorded previewId. Ask the owner to resolve the conflicting route; never overwrite unrelated routes.',
    UPSTREAM_UNREADY: 'Check the application and approved endpoint. Inspect get_preview, unpublish the failed recorded preview, then publish with a new requestId; retries preserve the original operation.',
    HTTPS_UNVERIFIED: 'Inspect get_preview; do not describe the URL as verified until HTTPS verification succeeds.',
  };
  return guidance[code] ? `${message} ${guidance[code]}`.slice(0, 1024) : message;
}
