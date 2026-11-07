// src/mcpHandler.ts
//
// The protected /mcp route: runs only for requests carrying a valid
// Worker-issued access token. Kept out of index.ts because workerd treats
// every named export of the main module as an entrypoint.
//
// Stateless Streamable HTTP: a fresh MCP server per request, JSON responses.

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { CfWorkerJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/cfworker';
import type { Env, GrantProps } from './env';
import { isEmailAllowed } from './googleHandler';
import { callTool, TOOLS } from './tools';

export const MCP_PATH = '/mcp';

const INSTRUCTIONS =
  'Reads and edits Rundown Studio rundowns. Start with list_rundowns, then get_rundown with ' +
  'include=cues,columns,cells. Cells are plain text; edit them with update_cell_text using the ' +
  'cue_id and column_id from get_rundown. The team shares a per-minute request limit, so prefer ' +
  'one get_rundown over many small reads.';

export function createServer(env: Env): Server {
  const server = new Server(
    { name: 'rundown-studio-mcp', version: '1.0.0' },
    {
      capabilities: { tools: {} },
      instructions: INSTRUCTIONS,
      jsonSchemaValidator: new CfWorkerJsonSchemaValidator(),
    }
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS.map(({ name, title, description, inputSchema, annotations }) => ({
      name,
      title,
      description,
      inputSchema,
      annotations,
    })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const result = await callTool(req.params.name, req.params.arguments, {
      token: env.RUNDOWN_STUDIO_TOKEN,
    });
    return { content: [{ type: 'text', text: result.text }], isError: result.isError };
  });
  return server;
}

/** Runs only for requests carrying a valid Worker-issued access token. */
export const mcpApiHandler = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const props = (ctx as unknown as { props: GrantProps }).props;

    // Re-checked on every request, so removing an email from ALLOWED_EMAILS
    // cuts off its existing grants immediately.
    if (!isEmailAllowed(props.email, env.ALLOWED_EMAILS)) {
      return new Response('Forbidden', { status: 403 });
    }

    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await createServer(env).connect(transport);
    return transport.handleRequest(request);
  },
};
