import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { failure, toolContracts, type ToolName, Problem, problem } from '../shared/contracts.js';
import { boundedText } from '../host/linux.js';
export function createMcpServer(base: string, credential: string, request: typeof fetch = fetch) {
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
    { name: 'rootlane', version: '0.5.0' },
    {
      instructions:
        'Discover projects and publish owner-approved running loopback services on this host. Call locate with your cwd → request_environment → if pending, tell the user to approve at approvalUrl and poll locate → start_environment → poll get_environment. Never edit Rootlane configuration or bypass checks. Then use get_capabilities, then list_projects and get_project to identify approved target IDs. publish_preview and unpublish_preview return durable operations; poll get_preview for route, upstream and HTTPS verification. Publication owns only its recorded route and never starts or stops upstream applications. Manage reviewed development environments separately. Use list_projects for project IDs and known project links. This service does not provide GitHub/Render API access or rewrite public URLs or payment callbacks. It exposes tools, not MCP resource entries. Start and stop return durable operations; poll get_environment. Keep requestId unchanged when retrying an action. Existing applications are observe-only.',
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
          const parsed = contract.input.parse(input);
          const response = await request(new URL(`/api/tools/${name}`, url), {
            method: 'POST',
            headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/json' },
            body: JSON.stringify(parsed),
            signal: AbortSignal.timeout(10000),
            redirect: 'error',
          });
          const body = JSON.parse(await boundedText(response, 512 * 1024));
          if (!response.ok) {
            const error = failure.safeParse(body);
            throw new Problem(
              error.success ? error.data.code : 'BACKEND_ERROR',
              error.success ? error.data.message : 'Rootlane rejected the request',
              error.success ? error.data.approvalUrl : undefined,
            );
          }
          const output = contract.output.parse(body);
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
                  code: 'BACKEND_UNAVAILABLE',
                  message: 'Rootlane is unavailable or returned invalid data. Check the existing service; retry mutations with the same requestId.',
                };
          return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify(detail) }] };
        }
      },
    );
  }
  return server;
}
