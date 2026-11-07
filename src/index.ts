// src/index.ts
//
// Cloudflare Worker serving a Rundown Studio MCP server.
//
//   claude.ai ──OAuth 2.1──► Worker (/authorize, /callback, /token, /register, /mcp)
//                              │  Google sign-in, ALLOWED_EMAILS
//                              ▼
//                            MCP tools ──► Rundown Studio v1 API (RUNDOWN_STUDIO_TOKEN)
//
// See README.md for setup, secrets and the allowlist.

import { OAuthProvider } from '@cloudflare/workers-oauth-provider';
import { missingSecrets, originOf, type Env } from './env';
import { googleHandler } from './googleHandler';
import { MCP_PATH, mcpApiHandler } from './mcpHandler';

// Keyed by origin, so the issuer always matches the URL the client used and no
// hostname needs to live in config.
const providers = new Map<string, OAuthProvider<Env>>();

function getProvider(origin: string): OAuthProvider<Env> {
  let provider = providers.get(origin);
  if (!provider) {
    provider = new OAuthProvider<Env>({
      apiRoute: MCP_PATH,
      apiHandler: mcpApiHandler,
      defaultHandler: googleHandler,
      authorizeEndpoint: '/authorize',
      tokenEndpoint: '/token',
      clientRegistrationEndpoint: '/register',
      clientIdMetadataDocumentEnabled: true,
      allowPrivateUseRedirectUris: true,
      resourceMetadata: {
        resource: `${origin}${MCP_PATH}`,
        authorization_servers: [origin],
        bearer_methods_supported: ['header'],
        resource_name: 'Rundown Studio MCP',
      },
    });
    providers.set(origin, provider);
  }
  return provider;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const missing = missingSecrets(env);
    if (missing.length > 0) {
      // First deploy happens before the secrets are set. Names only, never values.
      return new Response(`Not configured: missing ${missing.join(', ')}`, { status: 503 });
    }
    return getProvider(originOf(request)).fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
