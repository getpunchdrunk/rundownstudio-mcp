// src/env.ts
import type { OAuthHelpers } from '@cloudflare/workers-oauth-provider';

export interface Env {
  // Bindings (wrangler.toml)
  OAUTH_KV: KVNamespace;

  // Secrets (`wrangler secret put`; never in wrangler.toml)
  RUNDOWN_STUDIO_TOKEN: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  ALLOWED_EMAILS: string;

  // Optional var: extra OAuth redirect URIs for MCP clients not in the defaults.
  EXTRA_REDIRECT_URIS?: string;

  // Injected by @cloudflare/workers-oauth-provider
  OAUTH_PROVIDER: OAuthHelpers;
}

/** Props stored on each MCP grant by completeAuthorization(). */
export interface GrantProps {
  userId: string;
  email: string;
}

export const REQUIRED_SECRETS = [
  'RUNDOWN_STUDIO_TOKEN',
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'ALLOWED_EMAILS',
] as const;

/** Names of missing secrets, plus OAUTH_KV until the KV namespace exists. */
export function missingSecrets(env: Env): string[] {
  const missing: string[] = REQUIRED_SECRETS.filter((name) => !env[name]);
  if (!env.OAUTH_KV) missing.push('OAUTH_KV (KV binding)');
  return missing;
}

/** The Worker's own origin, e.g. https://<name>.<subdomain>.workers.dev. */
export const originOf = (request: Request) => new URL(request.url).origin;
