// src/toolTypes.ts
//
// Shape of the tool definitions emitted by scripts/generate-tools.ts.

export type JsonSchema = { [key: string]: unknown };

export interface ToolDef {
  name: string;
  title: string;
  description: string;
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  /** API path template, e.g. /rundowns/{id}/cues/{cue_id}. */
  path: string;
  /** Tool argument name -> path placeholder. */
  pathParams: Record<string, string>;
  queryParams: string[];
  bodyParams: string[];
  inputSchema: JsonSchema & { type: 'object' };
  annotations: { readOnlyHint: boolean; destructiveHint: boolean; openWorldHint: boolean };
}
