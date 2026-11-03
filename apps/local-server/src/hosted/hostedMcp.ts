import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { Hono } from 'hono';
import { z } from 'zod';

import { studioMcpTools } from '../../../../packages/shared/src/studioMcp';
import { withInternalRequestHeader } from './hostedSecurity';
import { signLibraryPath } from './hostedAuth';

// Remote MCP for agents (ADR 0013): stateless Streamable HTTP over the same tools and the same
// /api/mcp/call dispatch as the local stdio bridge. Agents authenticate with an agent token.

const HOST_PATH_KEYS = new Set([
  'filePath',
  'thumbnailPath',
  'localPath',
  'libraryRoot',
  'libraryDir',
]);
const DOWNLOAD_URL_TTL_SECONDS = 24 * 60 * 60;
// Tools whose routes act on the host. A hosted instance answers them with these messages.
const HOSTED_UNAVAILABLE: Record<string, string> = {
  studio_import_reference_file:
    'Hosted Cozy Studio cannot read local files. Use studio_import_reference with base64 bytes.',
  studio_onboarding:
    'Hosted Cozy Studio has no first-run setup. The owner imports the ChatGPT sign-in with hosted:admin. Use studio_providers for provider readiness.',
  studio_updates:
    'Hosted Cozy Studio updates when its owner deploys a new version. There is nothing to check or apply.',
  studio_apply_update:
    'Hosted Cozy Studio updates when its owner deploys a new version. There is nothing to check or apply.',
};
const REMOTE_TOOLS = Object.entries(studioMcpTools).filter(
  ([name]) => !(name in HOSTED_UNAVAILABLE),
);
const DESTRUCTIVE_TOOLS = new Set(['studio_cancel', 'studio_remove_extension']);
const NETWORK_TOOLS = new Set([
  'studio_generate',
  'studio_retry_batch',
  'studio_available_extensions',
  'studio_install_extension',
]);

const INSTRUCTIONS = [
  "Hosted Cozy Studio: the owner's image studio on a server. Call studio_status first. Before multi-step work, read studio_guide: topic hosted (what differs from local Studio), then overview and the topic for the task.",
  'Organize while generating. Every studio_generate sets the workspace (workspaceId, or workspaceName to find or create one), tags and collection. Reuse the names from studio_workspaces with workspaceId. Send tags: [] or collection: null only when the user asks for that. When studio_status returns organizeNotice, offer to organize one workspace at a time.',
  "studio_generate and studio_retry_batch spend the owner's provider usage. A direct request for exactly these images is consent; otherwise preview with studio_plan_generation and confirm. After a timeout, repeat studio_generate with the same requestId and identical input. Poll studio_batch, then list the images with studio_catalog.",
  'Image rows carry thumbnailUrl and publicUrl: signed download links valid for 24 hours that need no token. Look at thumbnailUrl. Local file paths are not returned.',
  'Agent access in Studio Settings > Advanced & maintenance limits the tools: Read only, Organize or Full control. A 403 names the level a tool needs: tell the user. Use these tools, not raw HTTP. Never print the agent token.',
].join('\n\n');

export interface HostedMcpRoutesOptions {
  request: (path: string, init?: RequestInit) => Response | Promise<Response>;
  publicOrigin: string;
  sessionSecret: string;
  /** studio_guide topics: the cozy-studio-mcp skill files (hostedGuide.ts). */
  guide: Record<string, string>;
}

const failure = (text: string) => ({ content: [{ type: 'text' as const, text }], isError: true });

/** Turns relative `/library/` URLs into signed absolute links and drops instance-local paths. */
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
    { capabilities: { tools: {} }, instructions: INSTRUCTIONS },
  );
  const topics = Object.keys(options.guide);
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      ...REMOTE_TOOLS.map(([name, tool]) => ({
        name,
        description: tool.description,
        inputSchema: z.toJSONSchema(tool.schema, { io: 'input' }) as { type: 'object' },
        annotations: {
          readOnlyHint: tool.access === 'read',
          destructiveHint: DESTRUCTIVE_TOOLS.has(name),
          idempotentHint: true,
          openWorldHint: NETWORK_TOOLS.has(name),
        },
      })),
      {
        name: 'studio_guide',
        description:
          'Read the Cozy Studio agent guide. topic "hosted" lists what differs on Hosted Cozy Studio; "overview" (the default) is the main guide; "contract" is the full tool contract; the other topics are its references. Works when Agent access is Off.',
        inputSchema: z.toJSONSchema(z.strictObject({ topic: z.enum(topics).default('overview') }), {
          io: 'input',
        }) as { type: 'object' },
        annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
      },
    ],
  }));
  server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
    if (params.name === 'studio_guide') {
      const topic = params.arguments?.topic ?? 'overview';
      const text =
        typeof topic === 'string' && Object.hasOwn(options.guide, topic)
          ? options.guide[topic]
          : null;
      if (!text) return failure(`Unknown guide topic. Topics: ${topics.join(', ')}.`);
      return {
        content: [
          {
            type: 'text',
            text:
              topic === 'overview'
                ? `Hosted Cozy Studio at ${options.publicOrigin}. Read topic hosted for what differs from local Studio.\n\n${text}`
                : text,
          },
        ],
      };
    }
    const unavailable = HOSTED_UNAVAILABLE[params.name];
    if (unavailable) return failure(unavailable);
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
