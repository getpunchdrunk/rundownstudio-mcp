// src/rundownClient.ts
//
// Calls the Rundown Studio v1 API with the server's team token.
//
// Retries: a 429 waits for its Retry-After (capped per wait and in total); 5xx and
// network errors back off exponentially. Every write carries one Idempotency-Key,
// reused across its retries, so a retried create can never run twice.
// Redirects are never followed, so the token is only ever sent to API_BASE.
// (Workers rejects redirect: "error", so this uses "manual" and refuses any 3xx.)
// Nothing here logs URLs, tokens or bodies.

export const API_BASE = 'https://api-v1.rundownstudio.app';

const MAX_ATTEMPTS = 5;
const MAX_SINGLE_WAIT_MS = 30_000;
/** Total time one call may spend waiting, so a tool call returns before the client times out. */
const WAIT_BUDGET_MS = 45_000;
const BASE_BACKOFF_MS = 500;

export interface ClientOptions {
  token: string;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

export interface RsRequest {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  /** Path template; {name} placeholders are filled from pathValues. */
  path: string;
  pathValues?: Record<string, string>;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  /** Defaults to a fresh UUID for every write. */
  idempotencyKey?: string;
}

export interface RsResult {
  ok: boolean;
  status: number;
  body: unknown;
  /** "code: detail" from the RFC 9457 problem body, for failures. */
  error?: string;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function buildUrl(req: RsRequest): string {
  const path = req.path.replace(/\{(\w+)\}/g, (_, name: string) => {
    const value = req.pathValues?.[name];
    if (value === undefined || value === '') throw new Error(`Missing path value ${name}`);
    return encodeURIComponent(value);
  });
  const url = new URL(API_BASE + path);
  for (const [key, value] of Object.entries(req.query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
  return url.toString();
}

async function readBody(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function problemText(body: unknown, status: number): string {
  if (body && typeof body === 'object') {
    const { code, detail, title } = body as { code?: string; detail?: string; title?: string };
    const parts = [code, detail ?? title].filter(Boolean);
    if (parts.length) return parts.join(': ');
  }
  return `HTTP ${status}`;
}

function retryAfterMs(res: Response): number | undefined {
  const raw = res.headers.get('retry-after');
  if (!raw) return undefined;
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : undefined;
}

export async function rsFetch(opts: ClientOptions, req: RsRequest): Promise<RsResult> {
  const doFetch = opts.fetch ?? fetch;
  const sleep = opts.sleep ?? defaultSleep;
  const random = opts.random ?? Math.random;

  const url = buildUrl(req);
  const headers: Record<string, string> = {
    Authorization: `Bearer ${opts.token}`,
    Accept: 'application/json',
  };
  if (req.method !== 'GET') headers['Idempotency-Key'] = req.idempotencyKey ?? crypto.randomUUID();
  if (req.body !== undefined) headers['Content-Type'] = 'application/json';
  const body = req.body === undefined ? undefined : JSON.stringify(req.body);

  let waited = 0;
  let last: RsResult = { ok: false, status: 0, body: null, error: 'No attempt made' };

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    let wait: number | undefined;
    try {
      const res = await doFetch(url, { method: req.method, headers, body, redirect: 'manual' });
      if (res.status >= 300 && res.status < 400) {
        await res.body?.cancel();
        return {
          ok: false,
          status: res.status,
          body: null,
          error: `Rundown Studio answered with a redirect (HTTP ${res.status}), which this server does not follow`,
        };
      }
      const resBody = await readBody(res);
      if (res.ok) return { ok: true, status: res.status, body: resBody };
      last = { ok: false, status: res.status, body: resBody, error: problemText(resBody, res.status) };
      if (res.status === 429) wait = retryAfterMs(res) ?? BASE_BACKOFF_MS * 2 ** attempt;
      else if (res.status >= 500) wait = BASE_BACKOFF_MS * 2 ** attempt * (0.5 + random() / 2);
      else return last;
    } catch {
      // Network failure. Safe to retry: GETs are reads and writes carry an Idempotency-Key.
      last = { ok: false, status: 0, body: null, error: 'Network error reaching Rundown Studio' };
      wait = BASE_BACKOFF_MS * 2 ** attempt * (0.5 + random() / 2);
    }

    wait = Math.min(wait, MAX_SINGLE_WAIT_MS);
    if (attempt === MAX_ATTEMPTS - 1 || waited + wait > WAIT_BUDGET_MS) break;
    await sleep(wait);
    waited += wait;
  }

  if (last.status === 429) {
    last.error = `${last.error} (team rate limit still exceeded after retrying; wait a minute and try again)`;
  }
  return last;
}
