import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { ClientOptions } from '../src/rundownClient';
import { callTool, isRichHtml, toPlainText, TOOLS } from '../src/tools';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function api(responses: Response[]) {
  const calls: Array<{ method: string; url: string; body: unknown }> = [];
  const opts: ClientOptions = {
    token: 't',
    sleep: async () => {},
    fetch: (async (url: string, init: RequestInit) => {
      calls.push({ method: String(init.method), url, body: init.body ? JSON.parse(String(init.body)) : undefined });
      return responses.shift() ?? json({}, 500);
    }) as unknown as typeof fetch,
  };
  return { opts, calls };
}

const cellsResponse = (content_html: string) =>
  json({ ok: true, data: { items: [{ cue_id: 'c', column_id: 'k', content: 'x', content_html }], count: 1, total: 1 } });

const cellArgs = { rundown_id: 'r', cue_id: 'c', column_id: 'k', content: 'New text' };

type Node = { id: string; children?: Array<{ id: string }> };
type CueStub = { id: string; title?: string; prevent_edits?: boolean };

const rundownWith = (cue_order: Node[], cues: CueStub[] = []) =>
  json({ ok: true, data: { id: 'r', cue_order }, included: { cues } });

describe('rich content detection', () => {
  it('treats paragraphs and line breaks as plain', () => {
    expect(isRichHtml('')).toBe(false);
    expect(isRichHtml('<p>Host walks on</p><p>Line two<br></p>')).toBe(false);
    expect(isRichHtml('<p>a &lt;b&gt; c</p>')).toBe(false);
  });

  it('flags formatting, mentions and media', () => {
    expect(isRichHtml('<p>track <strong>7</strong></p>')).toBe(true);
    expect(isRichHtml('<p><rs-mention data-mention-id="m"></rs-mention></p>')).toBe(true);
    expect(isRichHtml('<p><img src="https://example.com/a.png"></p>')).toBe(true);
  });

  it('removes content_html from results and flags rich cells', () => {
    expect(
      toPlainText({ items: [{ content: 'a', content_html: '<p>a</p>' }, { content: 'b', content_html: '<p><em>b</em></p>' }] })
    ).toEqual({ items: [{ content: 'a' }, { content: 'b', has_rich_content: true }] });
  });
});

describe('update_cell_text', () => {
  it('reads the cell, then writes plain text only', async () => {
    const { opts, calls } = api([cellsResponse('<p>old</p>'), json({ ok: true, data: { content: 'New text', content_html: '<p>New text</p>' } })]);
    const result = await callTool('update_cell_text', cellArgs, opts);
    expect(result.isError).toBe(false);
    expect(calls.map((c) => c.method)).toEqual(['GET', 'PATCH']);
    expect(calls[0].url).toContain('/rundowns/r/cells?cue_id=c&column_id=k&limit=1');
    expect(calls[1].body).toEqual({ cue_id: 'c', column_id: 'k', content: 'New text' });
    expect(result.text).not.toContain('content_html');
  });

  it('refuses to overwrite rich content by default', async () => {
    const { opts, calls } = api([cellsResponse('<p>track <strong>7</strong></p>')]);
    const result = await callTool('update_cell_text', cellArgs, opts);
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/replace_rich_content/);
    expect(calls).toHaveLength(1);
  });

  it('overwrites rich content when replace_rich_content is true, without the pre-read', async () => {
    const { opts, calls } = api([json({ ok: true, data: {} })]);
    const result = await callTool('update_cell_text', { ...cellArgs, replace_rich_content: true }, opts);
    expect(result.isError).toBe(false);
    expect(calls.map((c) => c.method)).toEqual(['PATCH']);
    expect(calls[0].body).toEqual({ cue_id: 'c', column_id: 'k', content: 'New text' });
  });

  it('rejects rich-text arguments', async () => {
    const { opts, calls } = api([]);
    const result = await callTool('update_cell_text', { ...cellArgs, content_html: '<p>x</p>' }, opts);
    expect(result).toMatchObject({ isError: true, text: 'Unknown argument(s): content_html' });
    expect(calls).toHaveLength(0);
  });
});

describe('cue tools', () => {
  it('create_cue posts the body to the rundown', async () => {
    const { opts, calls } = api([json({ ok: true, data: { id: 'new' } }, 201)]);
    await callTool('create_cue', { rundown_id: 'r', type: 'cue', title: 'Walk-in', position: 'end' }, opts);
    expect(calls[0]).toMatchObject({ method: 'POST', body: { type: 'cue', title: 'Walk-in', position: 'end' } });
    expect(calls[0].url).toMatch(/\/rundowns\/r\/cues$/);
  });

  it('delete_cue sends no body and reports the deletion', async () => {
    const { opts, calls } = api([rundownWith([{ id: 'c' }]), new Response(null, { status: 204 })]);
    const result = await callTool('delete_cue', { rundown_id: 'r', cue_id: 'c' }, opts);
    expect(calls[1]).toMatchObject({ method: 'DELETE', body: undefined });
    expect(result.text).toBe('{"deleted":true}');
  });

  it('reports missing required arguments without calling the API', async () => {
    const { opts, calls } = api([]);
    const result = await callTool('reorder_cues', { rundown_id: 'r' }, opts);
    expect(result).toMatchObject({ isError: true, text: 'Missing required argument(s): cue_order' });
    expect(calls).toHaveLength(0);
  });
});

describe('delete_cue group guard', () => {
  it('refuses a group that still holds cues, without deleting', async () => {
    const { opts, calls } = api([rundownWith([{ id: 'a' }, { id: 'g', children: [{ id: 'x' }, { id: 'y' }] }])]);
    const result = await callTool('delete_cue', { rundown_id: 'r', cue_id: 'g' }, opts);
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/group holding 2 cue\(s\).*dashboard/);
    expect(calls.map((c) => c.method)).toEqual(['GET']);
    expect(calls[0].url).toMatch(/\/rundowns\/r\?include=cues$/);
  });

  it.each([
    ['an empty group', [{ id: 'g', children: [] }], 'g'],
    ['a group with no children key', [{ id: 'g' }], 'g'],
    ['a cue inside a group', [{ id: 'g', children: [{ id: 'x' }] }], 'x'],
    ['a cue missing from cue_order', [{ id: 'a' }], 'gone'],
  ])('deletes %s', async (_label, cueOrder, cueId) => {
    const { opts, calls } = api([rundownWith(cueOrder), new Response(null, { status: 204 })]);
    const result = await callTool('delete_cue', { rundown_id: 'r', cue_id: cueId }, opts);
    expect(result.isError).toBe(false);
    expect(calls.map((c) => c.method)).toEqual(['GET', 'DELETE']);
    expect(calls[1].url).toMatch(new RegExp(`/rundowns/r/cues/${cueId}$`));
  });

  it('does not delete when the rundown cannot be read', async () => {
    const { opts, calls } = api([json({ code: 'rundowns.not_found', detail: 'No such rundown' }, 404)]);
    const result = await callTool('delete_cue', { rundown_id: 'r', cue_id: 'c' }, opts);
    expect(result).toMatchObject({ isError: true, text: 'Rundown Studio error 404: rundowns.not_found: No such rundown' });
    expect(calls.map((c) => c.method)).toEqual(['GET']);
  });
});

describe('delete_cue Prevent Edits guard', () => {
  it('refuses a locked cue, without deleting', async () => {
    const { opts, calls } = api([rundownWith([{ id: 'a' }, { id: 'l' }], [{ id: 'l', title: 'Locked', prevent_edits: true }])]);
    const result = await callTool('delete_cue', { rundown_id: 'r', cue_id: 'l' }, opts);
    expect(result).toEqual({
      isError: true,
      text:
        "Not deleted: this cue is locked with Prevent Edits. Only a person can unlock it, in the cue's " +
        'settings in Rundown Studio.',
    });
    expect(calls.map((c) => c.method)).toEqual(['GET']);
  });

  it('deletes an unlocked cue', async () => {
    const { opts, calls } = api([
      rundownWith([{ id: 'a' }, { id: 'l' }], [{ id: 'a', title: 'Free', prevent_edits: false }, { id: 'l', prevent_edits: true }]),
      new Response(null, { status: 204 }),
    ]);
    const result = await callTool('delete_cue', { rundown_id: 'r', cue_id: 'a' }, opts);
    expect(result).toEqual({ isError: false, text: '{"deleted":true}' });
    expect(calls.map((c) => c.method)).toEqual(['GET', 'DELETE']);
  });

  it('refuses a group holding a locked cue, naming it', async () => {
    const { opts, calls } = api([
      rundownWith([{ id: 'g', children: [{ id: 'x' }, { id: 'l' }] }], [{ id: 'l', title: 'Walk-in', prevent_edits: true }]),
    ]);
    const result = await callTool('delete_cue', { rundown_id: 'r', cue_id: 'g' }, opts);
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/^Not deleted: this group holds 2 cue\(s\), including .*Prevent Edits.*l "Walk-in"/);
    expect(calls.map((c) => c.method)).toEqual(['GET']);
  });

  it('refuses when the cues cannot be checked for locks', async () => {
    const { opts, calls } = api([json({ ok: true, data: { id: 'r', cue_order: [{ id: 'c' }] } })]);
    const result = await callTool('delete_cue', { rundown_id: 'r', cue_id: 'c' }, opts);
    expect(result).toEqual({ isError: true, text: 'Not deleted: could not read the cues to check for Prevent Edits locks.' });
    expect(calls.map((c) => c.method)).toEqual(['GET']);
  });
});

describe('reorder_cues Prevent Edits guard', () => {
  const current = [{ id: 'a' }, { id: 'l' }, { id: 'b' }, { id: 'g', children: [{ id: 'x' }] }];
  const cues = [{ id: 'l', title: 'Locked intro', prevent_edits: true }, { id: 'a', prevent_edits: false }];
  const order = (...ids: Array<string | [string, string[]]>) =>
    ids.map((id) => (Array.isArray(id) ? { cue_id: id[0], children: id[1].map((c) => ({ cue_id: c })) } : { cue_id: id }));

  it('refuses moving a locked cue to another index, naming it', async () => {
    const { opts, calls } = api([rundownWith(current, cues)]);
    const result = await callTool('reorder_cues', { rundown_id: 'r', cue_order: order('l', 'a', 'b', ['g', ['x']]) }, opts);
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/^Not reordered: this would move cue\(s\) locked with Prevent Edits: l "Locked intro"\./);
    expect(calls.map((c) => c.method)).toEqual(['GET']);
    expect(calls[0].url).toMatch(/\/rundowns\/r\?include=cues$/);
  });

  it('refuses moving a locked cue into a group', async () => {
    const { opts, calls } = api([rundownWith(current, cues)]);
    const result = await callTool('reorder_cues', { rundown_id: 'r', cue_order: order('a', 'b', ['g', ['l', 'x']]) }, opts);
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/l "Locked intro"/);
    expect(calls.map((c) => c.method)).toEqual(['GET']);
  });

  it('reorders unlocked cues around a locked cue that keeps its place', async () => {
    const { opts, calls } = api([rundownWith(current, cues), json({ ok: true, data: {} })]);
    const cue_order = order('b', 'l', 'a', ['g', ['x']]);
    const result = await callTool('reorder_cues', { rundown_id: 'r', cue_order }, opts);
    expect(result.isError).toBe(false);
    expect(calls.map((c) => c.method)).toEqual(['GET', 'POST']);
    expect(calls[1].url).toMatch(/\/rundowns\/r\/cues:reorder$/);
    expect(calls[1].body).toEqual({ cue_order });
  });

  it('does not reorder when the rundown cannot be read', async () => {
    const { opts, calls } = api([json({ code: 'rundowns.not_found', detail: 'No such rundown' }, 404)]);
    const result = await callTool('reorder_cues', { rundown_id: 'r', cue_order: order('a') }, opts);
    expect(result).toMatchObject({ isError: true, text: 'Rundown Studio error 404: rundowns.not_found: No such rundown' });
    expect(calls.map((c) => c.method)).toEqual(['GET']);
  });
});

describe('argument validation', () => {
  const rejects = async (name: string, args: Record<string, unknown>, location: RegExp) => {
    const { opts, calls } = api([]);
    const result = await callTool(name, args, opts);
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/^Invalid argument\(s\): /);
    expect(result.text).toMatch(location);
    expect(calls).toHaveLength(0);
  };

  it.each([['..'], ['.'], ['a/b'], ['/'], ['a%2Fb'], [''], ['x'.repeat(65)]])('rejects the ID %j', async (id) => {
    await rejects('delete_cue', { rundown_id: 'r', cue_id: id }, /#\/cue_id/);
    await rejects('get_rundown', { rundown_id: id }, /#\/rundown_id/);
  });

  it('accepts a 64-character ID with underscores and hyphens', async () => {
    const id = `${'a'.repeat(62)}_-`;
    const { opts, calls } = api([json({ ok: true, data: { id } })]);
    expect((await callTool('get_rundown', { rundown_id: id }, opts)).isError).toBe(false);
    expect(calls[0].url).toContain(`/rundowns/${id}`);
  });

  it('checks IDs in query arguments and nested structures', async () => {
    await rejects('list_cells', { rundown_id: 'r', column_id: '..' }, /#\/column_id/);
    await rejects('create_cue', { rundown_id: 'r', type: 'cue', position: { after_cue_id: '../x' } }, /#\/position/);
    await rejects('update_cue', { rundown_id: 'r', cue_id: 'c', position: { before_cue_id: 'a/b' } }, /#\/position/);
    await rejects('reorder_cues', { rundown_id: 'r', cue_order: [{ cue_id: '..' }] }, /#\/cue_order\/0\/cue_id/);
    await rejects(
      'reorder_cues',
      { rundown_id: 'r', cue_order: [{ cue_id: 'g', children: [{ cue_id: 'a/b' }] }] },
      /#\/cue_order\/0\/children\/0\/cue_id/
    );
  });

  it('rejects wrong types, lengths, ranges and enums', async () => {
    await rejects('list_rundowns', { limit: '5' }, /#\/limit/);
    await rejects('list_rundowns', { limit: 101 }, /#\/limit/);
    await rejects('get_rundown', { rundown_id: 7 }, /#\/rundown_id/);
    await rejects('create_cue', { rundown_id: 'r', type: 'folder' }, /#\/type/);
    await rejects('create_cue', { rundown_id: 'r', type: 'cue', title: 'x'.repeat(501) }, /#\/title/);
    await rejects('create_cue', { rundown_id: 'r', type: 'cue', position: 'middle' }, /#\/position/);
    await rejects('reorder_cues', { rundown_id: 'r', cue_order: 'x' }, /#\/cue_order/);
    await rejects('reorder_cues', { rundown_id: 'r', cue_order: [{ id: 'a' }] }, /#\/cue_order\/0/);
    await rejects('update_cell_text', { ...cellArgs, replace_rich_content: 'yes' }, /#\/replace_rich_content/);
  });
});

describe('generated tools', () => {
  const source = readFileSync('src/tools.generated.ts', 'utf8');

  it('contains only the v1 scope', () => {
    expect(TOOLS.map((t) => t.name).sort()).toEqual(
      ['create_cue', 'delete_cue', 'get_rundown', 'list_cells', 'list_rundowns', 'reorder_cues', 'update_cell_text', 'update_cue'].sort()
    );
    expect(TOOLS.some((t) => /action:|mentions|text-variables|events/.test(t.path))).toBe(false);
  });

  it('carries no examples, rich-text fields or sample IDs', () => {
    expect(source).not.toMatch(/"example/);
    expect(source).not.toMatch(/content_html|curl|Bearer/);
    // Rundown Studio IDs are 20 characters mixing upper case, lower case and digits.
    const ids = (source.match(/\b[A-Za-z0-9]{20}\b/g) ?? []).filter(
      (word) => /[0-9]/.test(word) && /[A-Z]/.test(word) && /[a-z]/.test(word)
    );
    expect(ids).toEqual([]);
  });

  it('uses only the hand-written titles and descriptions from the generator', async () => {
    const { TOOLS: configs } = await import('../scripts/generate-tools');
    for (const tool of TOOLS) {
      const config = configs.find((c) => c.name === tool.name)!;
      expect(tool.title).toBe(config.title);
      expect(tool.description).toBe(config.description);
    }
  });

  it('describes every argument, with no spec prose nested inside schemas', () => {
    const nested: string[] = [];
    const walk = (value: unknown, path: string) => {
      if (Array.isArray(value)) return value.forEach((v, i) => walk(v, `${path}[${i}]`));
      if (!value || typeof value !== 'object') return;
      for (const [key, child] of Object.entries(value)) {
        if (['description', 'summary', 'title', 'example', 'examples'].includes(key)) nested.push(`${path}.${key}`);
        walk(child, `${path}.${key}`);
      }
    };
    for (const tool of TOOLS) {
      for (const [name, schema] of Object.entries(tool.inputSchema.properties as Record<string, Record<string, unknown>>)) {
        expect(typeof schema.description, `${tool.name}.${name}`).toBe('string');
        const { description: _top, ...rest } = schema;
        walk(rest, `${tool.name}.${name}`);
      }
    }
    expect(nested).toEqual([]);
  });

  it('pins every ID argument to the safe ID pattern, at any depth', async () => {
    const { ID_PATTERN } = await import('../scripts/generate-tools');
    expect(ID_PATTERN).toBe('^[A-Za-z0-9_-]{1,64}$');
    const unpinned: string[] = [];
    const walk = (value: unknown, path: string) => {
      if (Array.isArray(value)) return value.forEach((v, i) => walk(v, `${path}[${i}]`));
      if (!value || typeof value !== 'object') return;
      for (const [key, child] of Object.entries(value)) {
        const isId = /^(rundown|cue|column|after_cue|before_cue)_id$/.test(key);
        if (isId && (child as { pattern?: string }).pattern !== ID_PATTERN) unpinned.push(`${path}.${key}`);
        walk(child, `${path}.${key}`);
      }
    };
    for (const tool of TOOLS) walk(tool.inputSchema.properties, tool.name);
    expect(unpinned).toEqual([]);
  });

  it('marks reads read-only and deletes destructive', () => {
    for (const tool of TOOLS) {
      expect(tool.annotations.readOnlyHint).toBe(tool.method === 'GET');
      expect(tool.annotations.destructiveHint).toBe(tool.method === 'DELETE');
    }
  });
});
