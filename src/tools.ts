// src/tools.ts
//
// Runs a generated tool: maps its arguments onto the API path, query and body,
// calls Rundown Studio, and returns plain-text results.
//
// v1 is plain text only, so cell `content_html` is removed from every result and
// replaced by `has_rich_content: true` where the cell holds formatting, mentions
// or media. update_cell_text refuses to overwrite such a cell unless asked to.
//
// Every call is checked against the tool's full input schema (which pins IDs to
// a safe pattern) before anything reaches the API. delete_cue refuses a group
// that still holds cues, since the API would delete them along with it.
//
// The API lets delete and reorder ignore a cue's Prevent Edits lock, so this
// server reads the rundown first and refuses to delete a locked cue (or a group
// holding one) or to move a locked cue from its parent and index among siblings.

import { Validator, type Schema } from '@cfworker/json-schema';
import { rsFetch, type ClientOptions, type RsResult } from './rundownClient';
import { TOOLS } from './tools.generated';
import type { ToolDef } from './toolTypes';

export { TOOLS };

export interface ToolOutcome {
  isError: boolean;
  text: string;
}

/** Arguments that steer the tool and are never sent to the API. */
const LOCAL_ARGS = new Set(['replace_rich_content']);

/** True when cell HTML holds more than paragraphs, line breaks and text. */
export function isRichHtml(html: string | undefined | null): boolean {
  if (!html) return false;
  const bare = html.replace(/<\/?p>|<br\s*\/?>/gi, '');
  return /<[a-z!/]/i.test(bare);
}

/** Drops content_html everywhere, flagging rich cells. */
export function toPlainText(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(toPlainText);
  if (!value || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === 'content_html') {
      if (isRichHtml(item as string)) out.has_rich_content = true;
      continue;
    }
    out[key] = toPlainText(item);
  }
  return out;
}

function validate(def: ToolDef, args: Record<string, unknown>): string | undefined {
  const properties = def.inputSchema.properties as Record<string, unknown>;
  const unknown = Object.keys(args).filter((key) => !(key in properties));
  if (unknown.length) return `Unknown argument(s): ${unknown.join(', ')}`;
  const required = (def.inputSchema.required ?? []) as string[];
  const missing = required.filter((key) => args[key] === undefined || args[key] === null);
  if (missing.length) return `Missing required argument(s): ${missing.join(', ')}`;
  return undefined;
}

const validators = new Map<string, Validator>();

/** Checks types, lengths, enums, nested shapes and ID patterns against the advertised schema. */
function validateSchema(def: ToolDef, args: Record<string, unknown>): string | undefined {
  let validator = validators.get(def.name);
  if (!validator) {
    validator = new Validator(def.inputSchema as Schema, '2020-12');
    validators.set(def.name, validator);
  }
  const result = validator.validate(args);
  if (result.valid) return undefined;
  // Errors arrive as a chain from the root down; report only the innermost ones.
  const locations = result.errors.map((e) => e.instanceLocation);
  const innermost = result.errors.filter((e) => !locations.some((loc) => loc.startsWith(`${e.instanceLocation}/`)));
  const messages = [...new Set(innermost.map((e) => `${e.instanceLocation} ${e.error.replace(/\.$/, '')}`))];
  return `Invalid argument(s): ${messages.join('; ')}`;
}

function outcome(result: RsResult): ToolOutcome {
  if (!result.ok) return { isError: true, text: `Rundown Studio error ${result.status}: ${result.error}` };
  let body = result.body;
  if (body && typeof body === 'object' && 'ok' in body) {
    const { ok: _ok, ...rest } = body as Record<string, unknown>;
    body = rest;
  }
  return { isError: false, text: JSON.stringify(toPlainText(body) ?? { deleted: true }) };
}

function request(def: ToolDef, args: Record<string, unknown>) {
  const pathValues: Record<string, string> = {};
  for (const [arg, placeholder] of Object.entries(def.pathParams)) pathValues[placeholder] = String(args[arg]);
  const query: Record<string, string | number | boolean | undefined> = {};
  for (const key of def.queryParams) query[key] = args[key] as string | number | boolean | undefined;
  let body: Record<string, unknown> | undefined;
  if (def.bodyParams.length) {
    body = {};
    for (const key of def.bodyParams) if (args[key] !== undefined && !LOCAL_ARGS.has(key)) body[key] = args[key];
  }
  return { method: def.method, path: def.path, pathValues, query, body };
}

/** Refuses a plain-text write over rich content unless replace_rich_content is set. */
async function cellGuard(opts: ClientOptions, args: Record<string, unknown>): Promise<ToolOutcome | undefined> {
  if (args.replace_rich_content === true) return undefined;
  const read = await rsFetch(opts, {
    method: 'GET',
    path: '/rundowns/{id}/cells',
    pathValues: { id: String(args.rundown_id) },
    query: { cue_id: String(args.cue_id), column_id: String(args.column_id), limit: 1 },
  });
  if (!read.ok) return outcome(read);
  const items = (read.body as { data?: { items?: Array<{ content_html?: string }> } })?.data?.items ?? [];
  if (isRichHtml(items[0]?.content_html)) {
    return {
      isError: true,
      text:
        'Not written: this cell holds formatting, mentions or media that a plain-text write would ' +
        'erase. Ask the user to confirm, then retry with replace_rich_content: true.',
    };
  }
  return undefined;
}

type OrderNode = { id?: string; children?: Array<{ id?: string }> };
type CueInfo = { title?: string; prevent_edits?: boolean };

/** Reads the cue order and every cue, for the Prevent Edits and group checks. */
async function readRundown(
  opts: ClientOptions,
  args: Record<string, unknown>,
  refusal: string
): Promise<{ order: OrderNode[]; cues: Map<string, CueInfo> } | ToolOutcome> {
  const read = await rsFetch(opts, {
    method: 'GET',
    path: '/rundowns/{id}',
    pathValues: { id: String(args.rundown_id) },
    query: { include: 'cues' },
  });
  if (!read.ok) return outcome(read);
  const body = read.body as { data?: { cue_order?: OrderNode[] }; included?: { cues?: unknown } };
  // Fail closed: without the cues there is no way to tell which are locked.
  if (!Array.isArray(body?.included?.cues)) {
    return { isError: true, text: `${refusal}: could not read the cues to check for Prevent Edits locks.` };
  }
  const cues = new Map<string, CueInfo>();
  for (const cue of body.included.cues as Array<CueInfo & { id?: string }>) if (cue?.id) cues.set(cue.id, cue);
  return { order: body.data?.cue_order ?? [], cues };
}

const lockedLabel = (id: string, cues: Map<string, CueInfo>) => `${id} "${cues.get(id)?.title ?? ''}"`;

/**
 * Refuses to delete a cue locked with Prevent Edits (the API allows it) or a group that still
 * holds cues (the API would delete them with it).
 */
async function deleteGuard(opts: ClientOptions, args: Record<string, unknown>): Promise<ToolOutcome | undefined> {
  const rundown = await readRundown(opts, args, 'Not deleted');
  if ('isError' in rundown) return rundown;
  const { order, cues } = rundown;
  if (cues.get(String(args.cue_id))?.prevent_edits === true) {
    return {
      isError: true,
      text:
        "Not deleted: this cue is locked with Prevent Edits. Only a person can unlock it, in the cue's " +
        'settings in Rundown Studio.',
    };
  }
  const children = (order.find((node) => node.id === args.cue_id)?.children ?? []).map((child) => String(child.id));
  const locked = children.filter((id) => cues.get(id)?.prevent_edits === true);
  if (locked.length > 0) {
    return {
      isError: true,
      text:
        `Not deleted: this group holds ${children.length} cue(s), including cue(s) locked with Prevent ` +
        `Edits (${locked.map((id) => lockedLabel(id, cues)).join(', ')}), and deleting it would delete ` +
        'them too. Only a person can unlock a cue, in its settings in Rundown Studio.',
    };
  }
  if (children.length > 0) {
    return {
      isError: true,
      text:
        `Not deleted: this cue is a group holding ${children.length} cue(s), and deleting it would delete ` +
        'them too. Delete or move its cues out first (reorder_cues), or delete the group from the ' +
        'Rundown Studio dashboard.',
    };
  }
  return undefined;
}

type Position = { parent: string | null; index: number };

/** Maps each cue to its parent group (null at the top level) and its index among its siblings. */
function positions(tree: Array<Record<string, unknown>>, idKey: 'id' | 'cue_id'): Map<string, Position> {
  const out = new Map<string, Position>();
  tree.forEach((node, index) => {
    const id = String(node[idKey]);
    out.set(id, { parent: null, index });
    const children = (node.children ?? []) as Array<Record<string, unknown>>;
    children.forEach((child, childIndex) => out.set(String(child[idKey]), { parent: id, index: childIndex }));
  });
  return out;
}

/**
 * Refuses an order that moves a cue locked with Prevent Edits (the API allows it). A locked cue
 * must keep its parent and its index among its siblings; other cues may move around it.
 */
async function reorderGuard(opts: ClientOptions, args: Record<string, unknown>): Promise<ToolOutcome | undefined> {
  const rundown = await readRundown(opts, args, 'Not reordered');
  if ('isError' in rundown) return rundown;
  const { order, cues } = rundown;
  const before = positions(order as Array<Record<string, unknown>>, 'id');
  const after = positions(args.cue_order as Array<Record<string, unknown>>, 'cue_id');
  const moved = [...before].filter(([id, was]) => {
    if (cues.get(id)?.prevent_edits !== true) return false;
    const now = after.get(id);
    return !now || now.parent !== was.parent || now.index !== was.index;
  });
  if (moved.length > 0) {
    return {
      isError: true,
      text:
        'Not reordered: this would move cue(s) locked with Prevent Edits: ' +
        `${moved.map(([id]) => lockedLabel(id, cues)).join(', ')}. A locked cue must keep its group and ` +
        'its place among its siblings; other cues may move as long as that holds. Only a person can ' +
        'unlock a cue, in its settings in Rundown Studio.',
    };
  }
  return undefined;
}

export async function callTool(
  name: string,
  rawArgs: Record<string, unknown> | undefined,
  opts: ClientOptions
): Promise<ToolOutcome> {
  const def = TOOLS.find((tool) => tool.name === name);
  if (!def) return { isError: true, text: `Unknown tool: ${name}` };
  const args = rawArgs ?? {};
  const invalid = validate(def, args) ?? validateSchema(def, args);
  if (invalid) return { isError: true, text: invalid };

  if (def.name === 'update_cell_text') {
    const refused = await cellGuard(opts, args);
    if (refused) return refused;
  }
  if (def.name === 'delete_cue') {
    const refused = await deleteGuard(opts, args);
    if (refused) return refused;
  }
  if (def.name === 'reorder_cues') {
    const refused = await reorderGuard(opts, args);
    if (refused) return refused;
  }
  return outcome(await rsFetch(opts, request(def, args)));
}
