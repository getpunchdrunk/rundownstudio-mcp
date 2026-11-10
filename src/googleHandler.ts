// src/googleHandler.ts
//
// The unprotected routes: /authorize (consent page, then redirect to Google)
// and /callback (Google sign-in result, allowlist check, grant).
//
// Google is used only to identify the person signing in; the ALLOWED_EMAILS
// allowlist is the approval gate. No Google tokens are stored. Rundown Studio
// calls use the server's RUNDOWN_STUDIO_TOKEN.
//
// Flow follows @cloudflare/workers-oauth-provider docs/upstream-sign-in.md.

import {
  AuthorizationError,
  CimdFetchError,
  authorizationErrorRedirect,
  type ConsentDescription,
} from '@cloudflare/workers-oauth-provider';
import { originOf, type Env } from './env';

const GOOGLE_AUTHORIZE_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const GOOGLE_USERINFO_ENDPOINT = 'https://openidconnect.googleapis.com/v1/userinfo';

/** Sign-in only: who you are, nothing else. */
export const GOOGLE_SIGN_IN_SCOPES = ['openid', 'email'];

/** Redirect URIs any deployment accepts: common MCP clients plus local tools. */
export const DEFAULT_REDIRECT_PATTERNS = [
  // Local clients (MCP Inspector, CLIs, desktop apps, VS Code).
  'http://localhost:*',
  'http://127.0.0.1:*',
  // Claude (web, desktop, mobile).
  'https://claude.ai/*',
  'https://claude.com/*',
  'claude://*',
  // ChatGPT connectors (current per-connector callback, then the legacy one).
  'https://chatgpt.com/connector/oauth/*',
  'https://chatgpt.com/connector_platform_oauth_redirect',
  // Cursor and VS Code.
  'cursor://*',
  'https://vscode.dev/redirect',
];

/**
 * Parses EXTRA_REDIRECT_URIS: comma-separated patterns where `*` matches anything.
 * http(s) patterns must name a literal host, so a wildcard can never open the allowlist
 * to any site. App schemes (myapp://*) may wildcard everything after the scheme.
 */
export function parseExtraRedirectPatterns(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((p) => {
      const http = /^https?:\/\/([^/*]+)(\/.*)?$/i.exec(p);
      if (http) return true;
      if (/^https?:/i.test(p)) return false;
      return /^[a-z][a-z0-9+.-]*:\/\/.+$/i.test(p);
    });
}

/** Redirect URIs an MCP client may use. */
export function allowedRedirectPatterns(baseUrl: string, extra?: string): string[] {
  return [...DEFAULT_REDIRECT_PATTERNS, `${baseUrl}/*`, ...parseExtraRedirectPatterns(extra)];
}

export function isRedirectUriAllowed(uri: string, baseUrl: string, extra?: string): boolean {
  // Reject userinfo tricks like http://localhost:1@evil.example.com/ that a prefix match would pass.
  try {
    const parsed = new URL(uri);
    if (parsed.username || parsed.password) return false;
  } catch {
    return false;
  }
  return allowedRedirectPatterns(baseUrl, extra).some((pattern) => {
    const regex = new RegExp(
      '^' +
        pattern
          .split('*')
          .map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
          .join('.*') +
        '$'
    );
    return regex.test(uri);
  });
}

const escape = (value: string) => value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function htmlResponse(body: string, status = 200, headers = new Headers()): Response {
  headers.set('Content-Type', 'text/html; charset=utf-8');
  return new Response(body, { status, headers });
}

function errorPage(message: string, status = 400): Response {
  return htmlResponse(
    `<!doctype html><meta charset="utf-8"><title>Sign-in error</title>` +
      `<body style="font-family:system-ui;max-width:32rem;margin:4rem auto;padding:0 1rem">` +
      `<h1>Sign-in error</h1><p>${escape(message)}</p></body>`,
    status
  );
}

function consentPage(details: ConsentDescription, handle: string): string {
  const name = escape(details.clientName);
  const origin = details.clientDomain
    ? `Published by <strong>${escape(details.clientDomain)}</strong>.`
    : 'This app registered itself; its name is not verified.';
  return `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Authorize ${name}</title>
<body style="font-family:system-ui;max-width:32rem;margin:4rem auto;padding:0 1rem;line-height:1.5">
<h1>Allow ${name} to use Rundown Studio MCP?</h1>
<p>${origin} Access will be sent to <strong>${escape(details.redirectHost)}</strong>.</p>
${details.redirectIsLoopback ? '<p><strong>This sends access to an app on your computer.</strong> Continue only if you just started signing in from it.</p>' : ''}
<p>Next you'll sign in with Google. Only allowlisted accounts are accepted.
Rundown Studio actions use this server's team API token.</p>
<form method="post">
  <input type="hidden" name="handle" value="${escape(handle)}">
  <p><button name="decision" value="approve">Allow</button> <button name="decision" value="deny">Deny</button></p>
</form>
</body>`;
}

async function sha256Base64Url(input: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input))
  );
  let s = '';
  for (const b of digest) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function handleAuthError(error: unknown): Response {
  if (error instanceof AuthorizationError && error.redirectTo) {
    return Response.redirect(error.redirectTo, 302);
  }
  if (error instanceof AuthorizationError) return errorPage(error.description ?? error.message);
  if (error instanceof CimdFetchError) return errorPage('This app could not be verified.');
  throw error;
}

async function getAuthorize(request: Request, env: Env): Promise<Response> {
  try {
    const oauth = env.OAUTH_PROVIDER;
    const authRequest = await oauth.parseAuthRequest(request);
    if (!isRedirectUriAllowed(authRequest.redirectUri, originOf(request), env.EXTRA_REDIRECT_URIS)) {
      return errorPage('This app is not allowed to connect to this server.', 403);
    }
    const details = await oauth.describeConsent(authRequest);
    const consent = await oauth.beginConsent(authRequest);
    return htmlResponse(consentPage(details, consent.handle), 200, consent.headers);
  } catch (error) {
    return handleAuthError(error);
  }
}

async function postAuthorize(request: Request, env: Env): Promise<Response> {
  try {
    const oauth = env.OAUTH_PROVIDER;
    const form = await request.formData();
    const handle = String(form.get('handle') ?? '');
    if (form.get('decision') !== 'approve') {
      const denied = await oauth.denyConsent(request, handle);
      return new Response(null, { status: 302, headers: denied.headers });
    }
    const approved = await oauth.approveConsent(request, handle);
    const verifier = crypto.randomUUID() + crypto.randomUUID();
    const { state, headers } = await oauth.beginUpstream(approved.request, {
      data: { verifier },
      headers: approved.headers,
    });

    const google = new URL(GOOGLE_AUTHORIZE_ENDPOINT);
    google.searchParams.set('client_id', env.GOOGLE_CLIENT_ID);
    google.searchParams.set('redirect_uri', `${originOf(request)}/callback`);
    google.searchParams.set('response_type', 'code');
    google.searchParams.set('scope', GOOGLE_SIGN_IN_SCOPES.join(' '));
    google.searchParams.set('state', state);
    google.searchParams.set('code_challenge', await sha256Base64Url(verifier));
    google.searchParams.set('code_challenge_method', 'S256');
    google.searchParams.set('prompt', 'select_account');

    headers.set('Location', google.toString());
    return new Response(null, { status: 302, headers });
  } catch (error) {
    return handleAuthError(error);
  }
}

async function getCallback(request: Request, env: Env): Promise<Response> {
  const oauth = env.OAUTH_PROVIDER;
  let original;
  let data: { verifier: string };
  let headers: Headers;
  try {
    ({
      request: original,
      data,
      headers,
    } = await oauth.finishUpstream<{ verifier: string }>(request));
  } catch (error) {
    return handleAuthError(error);
  }

  const params = new URL(request.url).searchParams;
  const code = params.get('code');
  if (params.get('error') || !code) {
    headers.set('Location', authorizationErrorRedirect(original, 'access_denied'));
    return new Response(null, { status: 302, headers });
  }

  const tokenRes = await fetch(GOOGLE_TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      code,
      code_verifier: data.verifier,
      grant_type: 'authorization_code',
      redirect_uri: `${originOf(request)}/callback`,
    }).toString(),
  });
  if (!tokenRes.ok) {
    console.error('Google code exchange failed', tokenRes.status);
    return errorPage('Google sign-in failed while exchanging the code. Try again.', 502);
  }
  const tokens = (await tokenRes.json()) as { access_token: string };

  const userRes = await fetch(GOOGLE_USERINFO_ENDPOINT, {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  });
  if (!userRes.ok) {
    console.error('Google userinfo failed', userRes.status);
    return errorPage('Could not read your Google account details. Try again.', 502);
  }
  const user = (await userRes.json()) as { sub: string; email?: string; email_verified?: boolean };

  if (
    !user.email ||
    user.email_verified !== true ||
    !isEmailAllowed(user.email, env.ALLOWED_EMAILS)
  ) {
    console.warn('Refused sign-in for non-allowlisted account');
    return errorPage('This Google account is not allowed to use this server.', 403);
  }
  const { redirectTo } = await oauth.completeAuthorization({
    request: original,
    userId: user.sub,
    metadata: { label: user.email },
    scope: original.scope,
    props: { userId: user.sub, email: user.email },
  });
  headers.set('Location', redirectTo);
  return new Response(null, { status: 302, headers });
}

/** Handles every route outside /mcp that the OAuth provider doesn't own. */
export const googleHandler = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);
    const method = request.method;

    if (pathname === '/authorize' && method === 'GET') return getAuthorize(request, env);
    if (pathname === '/authorize' && method === 'POST') return postAuthorize(request, env);
    if (pathname === '/callback' && method === 'GET') return getCallback(request, env);

    return new Response('Not found', { status: 404 });
  },
};

// --- Allowlist ---

export function parseAllowedEmails(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

export function isEmailAllowed(email: string | undefined, raw: string | undefined): boolean {
  if (!email) return false;
  return parseAllowedEmails(raw).includes(email.trim().toLowerCase());
}
