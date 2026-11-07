// scripts/generate-tools.ts
//
// Builds src/tools.generated.ts from the Rundown Studio v1 OpenAPI spec.
//
//   npm run generate            downloads the spec to ./openapi.yml (gitignored)
//   npm run generate -- --local reuses ./openapi.yml
//
// Only the operations in TOOLS become tools. The spec supplies structure only:
// paths, methods, field names, types and limits. All prose (titles and
// descriptions) is written here; every `description`, `example` and `x-*` key in
// the spec is dropped, and generation fails if a property has no description below.

import { readFile, writeFile } from 'node:fs/promises';
import { parse } from 'yaml';
import type { JsonSchema, ToolDef } from '../src/toolTypes';

const SPEC_URL = 'https://api-v1.rundownstudio.app/openapi.yml';
const SPEC_FILE = 'openapi.yml';
const OUT_FILE = 'src/tools.generated.ts';

interface ToolConfig {
  name: string;
  operationId: string;
  title: string;
  description: string;
  /** Property descriptions for this tool; falls back to PROPERTY_DESCRIPTIONS. */
  properties?: Record<string, string>;
  dropBody?: string[];
  requireBody?: string[];
  /** Extra arguments handled by the dispatcher, never sent to the API. */
  extra?: Record<string, JsonSchema>;
}

const PLAIN_TEXT_NOTE =
  'Cells are plain text in `content`; `has_rich_content: true` marks a cell that also holds ' +
  'formatting, mentions or media.';

/** Descriptions shared by several tools. */
const PROPERTY_DESCRIPTIONS: Record<string, string> = {
  rundown_id: 'Rundown ID, from list_rundowns.',
  cue_id: 'Cue ID, from get_rundown.',
  column_id: 'Column ID, from get_rundown.',
  title: 'Title, up to 500 characters.',
  subtitle: 'Subtitle, up to 500 characters.',
  duration_ms: 'Length in milliseconds, from 0 to 24 hours. Only applies to type `cue`.',
  background_color: 'Row background colour, up to 20 characters.',
  start_time:
    'Fixed start as a Unix timestamp in milliseconds, or null to remove a fixed start. Allowed ' +
    "range: the rundown's first day through 7 days later, in the rundown's time zone.",
  position:
    'Where the cue goes: "start", "end", {"after_cue_id": "..."} or {"before_cue_id": "..."}.',
};

export const TOOLS: ToolConfig[] = [
  {
    name: 'list_rundowns',
    operationId: 'list_rundowns',
    title: 'List rundowns',
    description:
      "List the rundowns this server's API token can access, oldest first. When `has_more` is " +
      'true, pass `next_cursor` back as `cursor` to get the next page.',
    properties: {
      cursor: 'The `next_cursor` from the previous page. Omit for the first page.',
      limit: 'Rundowns per page, 1 to 100 (default 25).',
    },
  },
  {
    name: 'get_rundown',
    operationId: 'get_rundown',
    title: 'Get rundown',
    description:
      "Get one rundown's details and cue order. Set `include` to also return its cues, columns " +
      `and cells, under \`included\`. ${PLAIN_TEXT_NOTE} A rundown with more than 1,000 cells ` +
      'returns 413; read its cells with list_cells instead.',
    properties: {
      include: 'Comma-separated, any of: cues, columns, cells. Asking for cells also returns cues and columns.',
    },
  },
  {
    name: 'list_cells',
    operationId: 'list_cells',
    title: 'List cells',
    description:
      'Read cells as a grid: every cue of type `cue` against every visible column, empty cells ' +
      'included. Pass `cue_id` for one row, `column_id` for one column, or both for one cell. ' +
      'Results stop at `limit`; if `count` is less than `total`, some were left out. There is no ' +
      'cursor or offset, so to read the rest call again with `column_id` for each column (from ' +
      'get_rundown): a column never has more cells than the rundown has cues, so up to 1,000 cues ' +
      'each column fits in one call at `limit` 1000. ' +
      PLAIN_TEXT_NOTE,
    properties: {
      cue_id: "Only this cue's row.",
      column_id: 'Only this column.',
      limit: 'Most cells to return, 1 to 1000 (default 50).',
    },
  },
  {
    name: 'create_cue',
    operationId: 'create_cue',
    title: 'Create cue',
    description:
      'Add a cue, heading or group to a rundown, at the end unless `position` says otherwise. ' +
      'Groups can only sit at the top level. A cue lands inside a group only when `position` is ' +
      'relative to a cue already in that group, such as {"after_cue_id": "<child id>"}; positioning ' +
      'it after the group itself puts it at the top level, right after the group. To fill an empty ' +
      'group, or to move cues into one, use reorder_cues.',
    properties: {
      type: '`cue` (a timed item), `heading` (a section label) or `group` (holds other cues).',
    },
  },
  {
    name: 'update_cue',
    operationId: 'update_cue',
    title: 'Update cue',
    description:
      'Change a cue. Send only the fields to change, at least one. `position` moves the cue. ' +
      'Setting `type` converts it: a group must be empty before it can become a cue or heading, ' +
      'and a cue turned into a heading or group keeps its cells hidden until it is turned back. ' +
      'A cue locked with Prevent Edits rejects changes (423 `cues.prevent_edits`); only a person ' +
      "can unlock it, in the cue's settings in Rundown Studio.",
    properties: {
      type: 'Convert the cue to `cue`, `heading` or `group`.',
      position: 'Move the cue: "start", "end", {"after_cue_id": "..."} or {"before_cue_id": "..."}.',
    },
  },
  {
    name: 'delete_cue',
    operationId: 'delete_cue',
    title: 'Delete cue',
    description:
      'Delete a cue, heading or empty group. A group that still holds cues is refused, because ' +
      'deleting it would delete them too: delete or move its cues out first (reorder_cues), or ' +
      'delete the group from the Rundown Studio dashboard. A cue locked with Prevent Edits is ' +
      'refused, and so is a group holding one; only a person can unlock a cue, in its settings in ' +
      'Rundown Studio. Deleted cues can be restored from the ' +
      'dashboard for 30 days; this API cannot restore them. Confirm with the user before deleting.',
  },
  {
    name: 'reorder_cues',
    operationId: 'reorder_cues',
    title: 'Reorder cues',
    description:
      'Set the whole cue order in one step. `cue_order` must list every cue in the rundown exactly ' +
      'once; this cannot add or remove cues. Cues inside a group go in its `children`, and groups ' +
      'cannot be nested. Read the current order and IDs with get_rundown first. Cues locked with ' +
      'Prevent Edits must keep their group and their index among their siblings; an order that ' +
      'changes either is refused, naming the locked cues. Other cues may move as long as that ' +
      'holds. This reads the rundown first, so it costs one extra request.',
    properties: {
      cue_order:
        'Top-level items in order, each {"cue_id": "..."}. A group may add ' +
        '"children": [{"cue_id": "..."}, ...] for the cues inside it.',
    },
  },
  {
    name: 'update_cell_text',
    operationId: 'patch_cell',
    title: 'Update cell text',
    description:
      'Set one cell, addressed by (cue_id, column_id), to plain text. Works on empty cells too. ' +
      'Separate lines with "\\n"; send "" to clear the cell.\n\n' +
      'Writing plain text replaces the whole cell, which would erase any formatting, mentions or ' +
      'media in it. So the tool first reads the cell and refuses if it holds rich content, unless ' +
      '`replace_rich_content` is true. Only set that after the user confirms losing the formatting.\n\n' +
      'Errors: 409 `cells.prevent_edits` (the cue is locked), 422 `cells.invalid_cue_type` ' +
      '(heading or group cues have no cells), 422 `cells.unsupported_column_type` (not a text column).',
    dropBody: ['content_html'],
    requireBody: ['content'],
    properties: {
      cue_id: 'Cue ID (type `cue`), from get_rundown.',
      content: 'Plain text for the cell. Separate lines with "\\n"; send "" to clear the cell.',
    },
    extra: {
      replace_rich_content: {
        type: 'boolean',
        description:
          'Set true to overwrite a cell that holds formatting, mentions or media. Defaults to false.',
      },
    },
  },
];

type Spec = {
  paths: Record<string, Record<string, Operation>>;
  components?: { schemas?: Record<string, JsonSchema> };
};
type Parameter = { name: string; in: string; required?: boolean; schema?: JsonSchema };
type Operation = {
  operationId?: string;
  parameters?: Parameter[];
  requestBody?: { content?: { 'application/json'?: { schema?: JsonSchema } } };
  'x-mcp'?: boolean;
};

const SAFE_INT = 9007199254740991;
/** Spec keys never copied: prose, samples and vendor extensions. */
const DROPPED_KEYS = new Set(['description', 'summary', 'title', 'example', 'examples']);

/**
 * Resolves $refs and keeps structure only. Inside a `properties` map the keys are
 * field names (a cue has a `title` field), so the drop rule does not apply there.
 */
function clean(schema: unknown, spec: Spec, isPropertyMap = false): unknown {
  if (Array.isArray(schema)) return schema.map((s) => clean(s, spec));
  if (!schema || typeof schema !== 'object') return schema;
  const obj = schema as JsonSchema;
  if (typeof obj.$ref === 'string') {
    const name = obj.$ref.replace('#/components/schemas/', '');
    const target = spec.components?.schemas?.[name];
    if (!target) throw new Error(`Unresolved $ref ${obj.$ref}`);
    const { $ref: _ref, ...rest } = obj;
    return clean({ ...target, ...rest }, spec);
  }
  const out: JsonSchema = {};
  for (const [key, value] of Object.entries(obj)) {
    if (isPropertyMap) {
      out[key] = clean(value, spec);
      continue;
    }
    if (DROPPED_KEYS.has(key) || key.startsWith('x-')) continue;
    if ((key === 'minimum' || key === 'maximum') && Math.abs(Number(value)) === SAFE_INT) continue;
    out[key] = clean(value, spec, key === 'properties');
  }
  return out;
}

/** IDs are checked against this before use, so a value like ".." can never alter the API path. */
export const ID_PATTERN = '^[A-Za-z0-9_-]{1,64}$';
const ID_FIELDS = new Set(['rundown_id', 'cue_id', 'column_id', 'after_cue_id', 'before_cue_id']);

/** Adds ID_PATTERN to every ID property, at any depth (position, cue_order, children). */
function constrainIds(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(constrainIds);
  if (!schema || typeof schema !== 'object') return schema;
  const out: JsonSchema = {};
  for (const [key, value] of Object.entries(schema as JsonSchema)) {
    if (key !== 'properties' || !value || typeof value !== 'object') {
      out[key] = constrainIds(value);
      continue;
    }
    const props: JsonSchema = {};
    for (const [name, prop] of Object.entries(value as Record<string, JsonSchema>)) {
      const child = constrainIds(prop) as JsonSchema;
      props[name] = ID_FIELDS.has(name) && child.type === 'string' ? { ...child, pattern: ID_PATTERN } : child;
    }
    out[key] = props;
  }
  return out;
}

/** Flattens a oneOf of object variants (create_cue) into one object with a `type` enum. */
function flattenOneOf(schema: JsonSchema): JsonSchema {
  const variants = schema.oneOf as JsonSchema[] | undefined;
  if (!variants) return schema;
  const properties: Record<string, JsonSchema> = {};
  const types: string[] = [];
  for (const variant of variants) {
    for (const [key, prop] of Object.entries((variant.properties ?? {}) as Record<string, JsonSchema>)) {
      if (key === 'type' && typeof prop.const === 'string') types.push(prop.const);
      else properties[key] ??= prop;
    }
  }
  return {
    type: 'object',
    properties: { type: { type: 'string', enum: types }, ...properties },
    required: ['type'],
  };
}

function describe(config: ToolConfig, key: string, schema: unknown): JsonSchema {
  const description = config.properties?.[key] ?? PROPERTY_DESCRIPTIONS[key];
  if (!description) throw new Error(`${config.name}.${key} needs a description in generate-tools.ts`);
  return { ...(schema as JsonSchema), description };
}

function buildTool(config: ToolConfig, spec: Spec): ToolDef {
  let found: { path: string; method: string; op: Operation } | undefined;
  for (const [path, item] of Object.entries(spec.paths)) {
    for (const [method, op] of Object.entries(item)) {
      if (op?.operationId === config.operationId) found = { path, method, op };
    }
  }
  if (!found) throw new Error(`Operation ${config.operationId} not in spec`);
  const { path, method, op } = found;
  if (op['x-mcp'] !== true) throw new Error(`${config.operationId} is not marked x-mcp`);

  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  const pathParams: Record<string, string> = {};
  const queryParams: string[] = [];

  for (const param of (clean(op.parameters ?? [], spec) as Parameter[])) {
    // The spec calls the rundown `id`; `rundown_id` reads better next to cue_id and column_id.
    const arg = param.in === 'path' && param.name === 'id' ? 'rundown_id' : param.name;
    if (param.in === 'path') pathParams[arg] = param.name;
    else if (param.in === 'query') queryParams.push(arg);
    else continue;
    properties[arg] = describe(config, arg, param.schema ?? {});
    if (param.required || param.in === 'path') required.push(arg);
  }

  const rawBody = op.requestBody?.content?.['application/json']?.schema;
  const bodyParams: string[] = [];
  if (rawBody) {
    const body = flattenOneOf(clean(rawBody, spec) as JsonSchema);
    const bodyProps = { ...((body.properties ?? {}) as Record<string, JsonSchema>) };
    for (const drop of config.dropBody ?? []) delete bodyProps[drop];
    for (const [key, prop] of Object.entries(bodyProps)) {
      properties[key] = describe(config, key, prop);
      bodyParams.push(key);
    }
    for (const key of [...((body.required ?? []) as string[]), ...(config.requireBody ?? [])]) {
      if (bodyProps[key] && !required.includes(key)) required.push(key);
    }
  }
  Object.assign(properties, config.extra ?? {});

  const httpMethod = method.toUpperCase() as ToolDef['method'];
  return {
    name: config.name,
    title: config.title,
    description: config.description,
    method: httpMethod,
    path,
    pathParams,
    queryParams,
    bodyParams,
    inputSchema: constrainIds({ type: 'object', properties, required, additionalProperties: false }) as ToolDef['inputSchema'],
    annotations: {
      readOnlyHint: httpMethod === 'GET',
      destructiveHint: httpMethod === 'DELETE',
      openWorldHint: false,
    },
  };
}

async function loadSpec(local: boolean): Promise<string> {
  if (!local) {
    const res = await fetch(SPEC_URL);
    if (!res.ok) throw new Error(`Spec download failed: HTTP ${res.status}`);
    await writeFile(SPEC_FILE, await res.text());
  }
  return readFile(SPEC_FILE, 'utf8');
}

export function generate(specYaml: string): { tools: ToolDef[]; version: string } {
  const spec = parse(specYaml, { maxAliasCount: -1 }) as Spec & { info?: { version?: string } };
  return { tools: TOOLS.map((t) => buildTool(t, spec)), version: spec.info?.version ?? 'unknown' };
}

if (process.argv[1]?.endsWith('generate-tools.ts')) {
  const { tools, version } = generate(await loadSpec(process.argv.includes('--local')));
  const source =
    `// Generated by scripts/generate-tools.ts. Structure comes from the Rundown Studio v1\n` +
    `// OpenAPI spec (version ${version}); all descriptions are written in the generator.\n` +
    `// Do not edit; run \`npm run generate\`.\n\n` +
    `import type { ToolDef } from './toolTypes';\n\n` +
    `export const SPEC_VERSION = ${JSON.stringify(version)};\n\n` +
    `export const TOOLS: ToolDef[] = ${JSON.stringify(tools, null, 2)};\n`;
  await writeFile(OUT_FILE, source);
  console.log(`Wrote ${tools.length} tools to ${OUT_FILE} (spec ${version}).`);
}
