// scripts/smoke.ts
//
// Live check against the real API, using RUNDOWN_STUDIO_TOKEN and TEST_RUNDOWN_ID
// from the environment, or else from .dev.vars. It reads, then adds one temporary
// cue at the end of the test rundown, writes plain text into one of its cells,
// reads it back, and deletes the cue. Existing cues and cells are never touched. About 10 requests.
//
// Prints counts and pass/fail only, never IDs, tokens or cell content.

import { existsSync, readFileSync } from 'node:fs';
import { rsFetch, type ClientOptions } from '../src/rundownClient';
import { callTool, TOOLS } from '../src/tools';

function loadDevVars(): Record<string, string> {
  const vars: Record<string, string> = {};
  if (!existsSync('.dev.vars')) return vars;
  for (const line of readFileSync('.dev.vars', 'utf8').split('\n')) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (match) vars[match[1]] = match[2].replace(/^"(.*)"$/, '$1');
  }
  return vars;
}

// The environment (e.g. `doppler run --`) wins over .dev.vars.
const vars = loadDevVars();
for (const name of ['RUNDOWN_STUDIO_TOKEN', 'TEST_RUNDOWN_ID']) {
  if (process.env[name]) vars[name] = process.env[name];
  if (!vars[name] || vars[name] === 'replace-me') throw new Error(`Set ${name} in .dev.vars or the environment`);
}
const rundownId = vars.TEST_RUNDOWN_ID;
const opts: ClientOptions = { token: vars.RUNDOWN_STUDIO_TOKEN };

let failures = 0;
function check(label: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures++;
}

async function tool(name: string, args: Record<string, unknown>) {
  const result = await callTool(name, args, opts);
  if (result.isError) console.log(`      ${name}: ${result.text.slice(0, 300)}`);
  return { ...result, json: result.isError ? undefined : JSON.parse(result.text) };
}

type Rundown = { included?: { cues?: unknown[]; columns?: Array<{ id: string }> } };

async function rundown(): Promise<Rundown | undefined> {
  return (await tool('get_rundown', { rundown_id: rundownId, include: 'cues,columns' })).json;
}

const list = await tool('list_rundowns', { limit: 5 });
check('list_rundowns', !list.isError, `${list.json?.data?.items?.length ?? 0} returned`);

const before = await rundown();
const cueCount = before?.included?.cues?.length ?? 0;
const columnId = before?.included?.columns?.[0]?.id;
check('get_rundown with cues and columns', !!before, `${cueCount} cues, ${before?.included?.columns?.length ?? 0} columns`);
if (!columnId) throw new Error('Test rundown needs at least one text column');

// Same Idempotency-Key twice: the API must replay the first create, not make a second cue.
const key = crypto.randomUUID();
const createBody = { type: 'cue', title: 'MCP smoke test (safe to delete)', position: 'end' };
const create = TOOLS.find((t) => t.name === 'create_cue')!;
const first = await rsFetch(opts, { method: 'POST', path: create.path, pathValues: { id: rundownId }, body: createBody, idempotencyKey: key });
const second = await rsFetch(opts, { method: 'POST', path: create.path, pathValues: { id: rundownId }, body: createBody, idempotencyKey: key });
const cueId = (first.body as { data?: { id?: string } })?.data?.id;
check('create_cue', first.ok && !!cueId, `HTTP ${first.status}`);
check('repeat with same Idempotency-Key returns the same cue', (second.body as { data?: { id?: string } })?.data?.id === cueId);

try {
  if (cueId) {
    const after = await rundown();
    check('exactly one cue added', (after?.included?.cues?.length ?? 0) === cueCount + 1);

    const text = `Smoke test ${new Date().toISOString()}`;
    const write = await tool('update_cell_text', { rundown_id: rundownId, cue_id: cueId, column_id: columnId, content: text });
    check('update_cell_text (plain text)', !write.isError);

    const read = await tool('list_cells', { rundown_id: rundownId, cue_id: cueId, column_id: columnId });
    check('cell reads back the written text', read.json?.data?.items?.[0]?.content === text);
  }
} finally {
  if (cueId) {
    const del = await tool('delete_cue', { rundown_id: rundownId, cue_id: cueId });
    check('delete_cue (cleanup)', !del.isError);
    const final = await rundown();
    check('cue count restored', (final?.included?.cues?.length ?? 0) === cueCount);
  }
}

console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
