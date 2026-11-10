import { afterEach, describe, expect, it, vi } from 'vitest';

// The real provider module imports `cloudflare:workers`, which only exists in workerd.
vi.mock('@cloudflare/workers-oauth-provider', () => ({
  OAuthProvider: class {},
  AuthorizationError: class extends Error {},
  CimdFetchError: class extends Error {},
  authorizationErrorRedirect: vi.fn(),
}));

const { isRedirectUriAllowed, isEmailAllowed } = await import('../src/googleHandler');
const { mcpApiHandler } = await import('../src/mcpHandler');
const { missingSecrets } = await import('../src/env');
const { API_BASE } = await import('../src/rundownClient');

const BASE = 'https://mcp.example.com';

function makeEnv(extra: Record<string, unknown> = {}) {
  return {
    RUNDOWN_STUDIO_TOKEN: 'test-token',
    GOOGLE_CLIENT_ID: 'cid',
    GOOGLE_CLIENT_SECRET: 'csecret',
    ALLOWED_EMAILS: 'Owner@Example.com, other@example.com',
    OAUTH_KV: {},
    ...extra,
  } as any;
}

const ctxFor = (email: string) => ({ props: { userId: 'user-1', email } }) as any;
const rpc = (body: unknown) =>
  new Request(`${BASE}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify(body),
  });

afterEach(() => vi.unstubAllGlobals());

describe('allowlist, redirect URIs, secrets', () => {
  it('matches emails case-insensitively', () => {
    expect(isEmailAllowed('OWNER@example.com', 'owner@example.com')).toBe(true);
    expect(isEmailAllowed('mallory@example.com', 'owner@example.com')).toBe(false);
    expect(isEmailAllowed('owner@example.com', '')).toBe(false);
    expect(isEmailAllowed(undefined, 'owner@example.com')).toBe(false);
  });

  it('allows the claude.ai redirect patterns', () => {
    expect(isRedirectUriAllowed('https://claude.ai/api/mcp/auth_callback', BASE)).toBe(true);
    expect(isRedirectUriAllowed('http://localhost:6274/oauth/callback', BASE)).toBe(true);
    expect(isRedirectUriAllowed('https://evil.example/callback', BASE)).toBe(false);
    expect(isRedirectUriAllowed('https://claude.ai.evil.example/cb', BASE)).toBe(false);
  });

  it('allows the ChatGPT connector redirect URIs only', () => {
    expect(isRedirectUriAllowed('https://chatgpt.com/connector/oauth/abc123', BASE)).toBe(true);
    expect(isRedirectUriAllowed('https://chatgpt.com/connector_platform_oauth_redirect', BASE)).toBe(true);
    expect(isRedirectUriAllowed('https://chatgpt.com/evil', BASE)).toBe(false);
    expect(isRedirectUriAllowed('https://chatgpt.com/connector_platform_oauth_redirect/extra', BASE)).toBe(false);
    expect(isRedirectUriAllowed('https://chatgpt.com.evil.example/connector/oauth/x', BASE)).toBe(false);
  });

  it('names missing secrets and the KV binding, never values', () => {
    expect(missingSecrets(makeEnv())).toEqual([]);
    expect(missingSecrets(makeEnv({ RUNDOWN_STUDIO_TOKEN: '', OAUTH_KV: undefined }))).toEqual([
      'RUNDOWN_STUDIO_TOKEN',
      'OAUTH_KV (KV binding)',
    ]);
  });
});

describe('/mcp', () => {
  it('refuses a grant whose email was removed from the allowlist', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const res = await mcpApiHandler.fetch(rpc({}), makeEnv(), ctxFor('ex@example.com'));
    expect(res.status).toBe(403);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('initializes and lists the eight v1 tools', async () => {
    const init = await mcpApiHandler.fetch(
      rpc({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } },
      }),
      makeEnv(),
      ctxFor('owner@example.com')
    );
    expect(init.status).toBe(200);
    expect(((await init.json()) as any).result.serverInfo.name).toBe('rundown-studio-mcp');

    const list = await mcpApiHandler.fetch(
      rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
      makeEnv(),
      ctxFor('owner@example.com')
    );
    const names = ((await list.json()) as any).result.tools.map((t: { name: string }) => t.name);
    expect(names).toEqual([
      'list_rundowns',
      'get_rundown',
      'list_cells',
      'create_cue',
      'update_cue',
      'delete_cue',
      'reorder_cues',
      'update_cell_text',
    ]);
  });

  it('calls a tool with the server token and returns plain text', async () => {
    const fetchSpy = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ ok: true, data: { items: [{ id: 'r1', title: 'Show' }], has_more: false } }),
          { headers: { 'Content-Type': 'application/json' } }
        )
    );
    vi.stubGlobal('fetch', fetchSpy);
    const res = await mcpApiHandler.fetch(
      rpc({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list_rundowns', arguments: { limit: 2 } } }),
      makeEnv(),
      ctxFor('owner@example.com')
    );
    const { result } = (await res.json()) as any;
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.content[0].text).data.items[0].title).toBe('Show');
    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${API_BASE}/rundowns?limit=2`);
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer test-token');
  });
});
