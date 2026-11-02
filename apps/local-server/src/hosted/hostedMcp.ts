import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { Hono } from 'hono';
import { z } from 'zod';

import { isStudioMcpMutation, studioMcpTools } from '../../../../packages/shared/src/studioMcp';
import { withInternalRequestHeader } from './hostedSecurity';
import { signLibraryPath } from './hostedAuth';

// Remote MCP for agents (ADR 0012): stateless Streamable HTTP over the same tools and the same
// /api/mcp/call dispatch as the local stdio bridge. Agents authenticate with an agent token.

const HOST_PATH_KEYS = new Set([
  'filePath',
  'thumbnailPath',
  'localPath',
  'libraryRoot',
  'libraryDir',
]);
const DOWNLOAD_URL_TTL_SECONDS = 24 * 60 * 60;
// Hosted instances have no local import roots.
const REMOTE_TOOLS = Object.entries(studioMcpTools).filter(
  ([name]) => name !== 'studio_import_reference_file',
);

export interface HostedMcpRoutesOptions {
  request: (path: string, init?: RequestInit) => Response | Promise<Response>;
  publicOrigin: string;
  sessionSecret: string;
}

/** Turns relative Library URLs into signed absolute links and drops instance-local paths. */
export function shapeRemoteMcpResult(
  value: unknown,
  options: { publicOrigin: string; sessionSecret: string; now?: number },
): unknown {
  const expiresAt = Math.floor((options.now ?? Date.now()) / 1000) + DOWNLOAD_URL_TTL_SECONDS;
  const sign = (libraryUrl: string) => {
    const [pathname] = libraryUrl.split('?');
    const signature = signLibraryPath(options.sessionSecret, pathname!, expiresAt);
    const separator = libraryUrl.includes('?') ? '&' : '?';
    return `${options.publicOrigin.replace(/\/$/, '')}${libraryUrl}${separator}exp=${expiresAt}&sig=${signature}`;
  };
  const visit = (node: unknown): unknown => {
    if (typeof node === 'string') return node.startsWith('/library/') ? sign(node) : node;
    if (Array.isArray(node)) return node.map(visit);
    if (!node || typeof node !== 'object') return node;
    return Object.fromEntries(
      Object.entries(node)
        .filter(([key]) => !HOST_PATH_KEYS.has(key))
        .map(([key, child]) => [key, visit(child)]),
    );
  };
  return visit(value);
}

function createServer(options: HostedMcpRoutesOptions) {
  const server = new Server(
    { name: 'cozy-studio', version: '1.0.0' },
    {
      capabilities: { tools: {} },
      instructions:
        'Hosted Cozy Studio. Generate with studio_generate, poll studio_job or studio_batch until the job completes, then read studio_catalog; image URLs are signed download links valid for 24 hours.',
    },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: REMOTE_TOOLS.map(([name, tool]) => ({
      name,
      description: tool.description,
      inputSchema: z.toJSONSchema(tool.schema, { io: 'input' }) as { type: 'object' },
      annotations: {
        readOnlyHint: !isStudioMcpMutation(name),
        destructiveHint: name === 'studio_cancel',
        idempotentHint: true,
        openWorldHint: name === 'studio_generate',
      },
    })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
    if (params.name === 'studio_import_reference_file') {
      return {
        content: [
          {
            type: 'text',
            text: 'Hosted Cozy Studio cannot read local files. Use studio_import_reference with base64 bytes.',
          },
        ],
        isError: true,
      };
    }
    const response = await options.request(
      '/api/mcp/call',
      withInternalRequestHeader({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: params.name, arguments: params.arguments ?? {} }),
      }),
    );
    const raw = await response.text();
    let text = raw;
    try {
      text = JSON.stringify(shapeRemoteMcpResult(JSON.parse(raw), options));
    } catch {
      // Not JSON: pass the text through unchanged.
    }
    return { content: [{ type: 'text', text }], isError: !response.ok };
  });
  return server;
}

export function createHostedMcpRoutes(options: HostedMcpRoutesOptions) {
  const routes = new Hono();
  routes.all('/', async (c) => {
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    const server = createServer(options);
    await server.connect(transport);
    try {
      return await transport.handleRequest(c.req.raw);
    } finally {
      void server.close();
    }
  });
  return routes;
}
