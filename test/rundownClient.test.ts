import { describe, expect, it, vi } from 'vitest';
import { API_BASE, rsFetch, type ClientOptions } from '../src/rundownClient';

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });

function client(responses: Array<Response | Error>) {
  const calls: Request[] = [];
  const sleeps: number[] = [];
  const fetchImpl = vi.fn(async (input: RequestInfo, init?: RequestInit) => {
    calls.push(new Request(input, init));
    const next = responses.shift();
    if (!next) throw new Error('no more responses');
    if (next instanceof Error) throw next;
    return next;
  });
  const opts: ClientOptions = {
    token: 'test-token',
    fetch: fetchImpl as unknown as typeof fetch,
    sleep: async (ms) => void sleeps.push(ms),
    random: () => 0.5,
  };
  return { opts, calls, sleeps };
}

describe('rsFetch', () => {
  it('sends the bearer token and query to the v1 API', async () => {
    const { opts, calls } = client([json(200, { ok: true, data: { items: [] } })]);
    const result = await rsFetch(opts, { method: 'GET', path: '/rundowns', query: { limit: 5 } });
    expect(result).toMatchObject({ ok: true, status: 200 });
    expect(calls[0].url).toBe(`${API_BASE}/rundowns?limit=5`);
    expect(calls[0].headers.get('authorization')).toBe('Bearer test-token');
    expect(calls[0].headers.get('idempotency-key')).toBeNull();
  });

  it('waits for Retry-After on 429, then succeeds', async () => {
    const { opts, calls, sleeps } = client([
      json(429, { code: 'rate_limit.exceeded' }, { 'Retry-After': '7' }),
      json(200, { ok: true }),
    ]);
    const result = await rsFetch(opts, { method: 'GET', path: '/rundowns' });
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(2);
    expect(sleeps).toEqual([7000]);
  });

  it('caps a single Retry-After wait at 30 seconds', async () => {
    const { opts, sleeps } = client([
      json(429, {}, { 'Retry-After': '600' }),
      json(200, { ok: true }),
    ]);
    await rsFetch(opts, { method: 'GET', path: '/rundowns' });
    expect(sleeps).toEqual([30000]);
  });

  it('gives up on 429 once the wait budget is spent and says so', async () => {
    const { opts, calls } = client(
      Array.from({ length: 10 }, () => json(429, { detail: 'slow down' }, { 'Retry-After': '30' }))
    );
    const result = await rsFetch(opts, { method: 'GET', path: '/rundowns' });
    expect(result.ok).toBe(false);
    expect(result.status).toBe(429);
    expect(calls.length).toBeLessThanOrEqual(3);
    expect(result.error).toMatch(/rate limit/i);
  });

  it('uses one Idempotency-Key per write and reuses it across retries', async () => {
    const { opts, calls } = client([
      json(503, {}),
      new Error('network down'),
      json(201, { ok: true, data: { id: 'new' } }),
    ]);
    const result = await rsFetch(opts, { method: 'POST', path: '/rundowns/r1/cues', body: { type: 'cue' } });
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(3);
    const keys = calls.map((c) => c.headers.get('idempotency-key'));
    expect(keys[0]).toMatch(/^[0-9a-f-]{36}$/);
    expect(new Set(keys).size).toBe(1);
    expect(await calls[0].json()).toEqual({ type: 'cue' });
  });

  it('retries 5xx with exponential backoff', async () => {
    const { opts, sleeps } = client([json(500, {}), json(502, {}), json(200, { ok: true })]);
    await rsFetch(opts, { method: 'GET', path: '/rundowns' });
    expect(sleeps).toEqual([500 * 0.75, 1000 * 0.75]);
  });

  it('does not retry 4xx other than 429, and returns the problem detail', async () => {
    const { opts, calls } = client([
      json(422, { code: 'cues.invalid_reorder', detail: 'ID set must match' }),
    ]);
    const result = await rsFetch(opts, { method: 'POST', path: '/rundowns/r1/cues:reorder', body: {} });
    expect(calls).toHaveLength(1);
    expect(result).toMatchObject({ ok: false, status: 422, error: 'cues.invalid_reorder: ID set must match' });
  });

  it('never follows redirects', async () => {
    const { opts, calls } = client([json(200, { ok: true })]);
    await rsFetch(opts, { method: 'POST', path: '/rundowns/r1/cues', body: { type: 'cue' } });
    expect(calls[0].redirect).toBe('manual');
  });

  it('refuses a redirect response without retrying or reading it', async () => {
    const { opts, calls, sleeps } = client([
      new Response('moved', { status: 302, headers: { Location: 'https://elsewhere.example/steal' } }),
    ]);
    const result = await rsFetch(opts, { method: 'GET', path: '/rundowns' });
    expect(result).toMatchObject({ ok: false, status: 302, body: null });
    expect(result.error).toMatch(/redirect \(HTTP 302\).*does not follow/);
    expect(calls).toHaveLength(1);
    expect(sleeps).toEqual([]);
  });

  it('encodes path segments', async () => {
    const { opts, calls } = client([json(200, { ok: true })]);
    await rsFetch(opts, { method: 'GET', path: '/rundowns/{id}', pathValues: { id: 'a/b?c' } });
    expect(calls[0].url).toBe(`${API_BASE}/rundowns/a%2Fb%3Fc`);
  });
});
