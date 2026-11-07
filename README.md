# Rundown Studio MCP

A remote [MCP](https://modelcontextprotocol.io) server that lets Claude (or any MCP client) read
and edit [Rundown Studio](https://rundownstudio.app) rundowns through the
[Rundown Studio v1 API](https://rundownstudio.app/docs/api-v1). It runs as a single Cloudflare
Worker that you deploy to your own Cloudflare account with `wrangler`.

## Disclaimer

This is an unofficial community project. It is not affiliated with or endorsed by Rundown Studio.
"Rundown Studio" is a trademark of its owner.

## What it can do

| Tool | What it does |
|---|---|
| `list_rundowns` | List the rundowns your API token can see (paginated). |
| `get_rundown` | Fetch one rundown, optionally with its cues, columns and cells. |
| `list_cells` | Read the cell grid, or one cue's row, one column, or one cell. For large rundowns. |
| `create_cue` | Add a cue, heading or group at the start, at the end, or before or after a cue. |
| `update_cue` | Change a cue's title, subtitle, duration, start time, colour or position. |
| `delete_cue` | Delete a cue, heading or empty group. Refuses a group that still holds cues, and any cue locked with Prevent Edits. |
| `reorder_cues` | Replace the whole cue order, including group membership. Refuses to move a cue locked with Prevent Edits. |
| `update_cell_text` | Set one cell to plain text. |

Not included: live show control (start, pause, next and so on), rich-text formatting, mentions,
text variables, and the v0 API.

**Plain text only.** Cells come back as plain text. `update_cell_text` replaces the whole cell, so
writing to a cell that holds formatting, mentions or images would erase them. The tool reads the
cell first and refuses to write if it holds anything beyond plain text, unless the call sets
`replace_rich_content: true`. Results mark such cells with `has_rich_content: true`.

## How access works

```
Claude ──OAuth 2.1──► Worker (/authorize, /callback, /token, /register, /mcp)
                        │  Google sign-in, checked against ALLOWED_EMAILS
                        ▼
                      MCP tools ──► Rundown Studio v1 API (your team API token)
```

- **Connecting** uses OAuth 2.1 via
  [`@cloudflare/workers-oauth-provider`](https://github.com/cloudflare/workers-oauth-provider).
  When you add the connector, you approve it on a consent page and sign in with Google.
- **Google is used only to learn who is signing in.** Only the `openid email` scopes are
  requested, and no Google tokens are stored. The `ALLOWED_EMAILS` allowlist is the approval gate.
  It is re-checked on every MCP request, so removing an address cuts off its existing grants
  right away.
- **Rundown Studio calls** use one team API token, stored as a Worker secret. Everyone on the
  allowlist acts with that token's permissions.
- OAuth grants and tokens live in a Workers KV namespace (`OAUTH_KV`).

## Requirements

- A Cloudflare account. The Workers free plan is enough.
- Node.js 20 or newer.
- A Rundown Studio API token. See the
  [getting started guide](https://rundownstudio.app/docs/api-v1/getting-started/).
- A Google Cloud project where you can create an OAuth client.

## Setup

Each team should deploy its own Worker with its own API token, since anyone allowed to sign in
acts with that token.

### 1. Install and log in

```sh
npm install
npx wrangler login
```

`wrangler login` picks your Cloudflare account, so no account ID goes in the config.

### 2. Deploy once to get your URL

```sh
npx wrangler deploy
```

This creates the Worker and its KV namespace, and prints the URL,
`https://rundown-studio-mcp.<your-subdomain>.workers.dev`. Until the secrets are set, every request
returns `503 Not configured: missing ...`, which lists the missing names but never their values.

### 3. Create a Google OAuth client

In Google Cloud Console, open **APIs & Services → Credentials → Create credentials → OAuth client
ID**, and choose the application type **Web application**. Add these authorized redirect URIs:

- `https://rundown-studio-mcp.<your-subdomain>.workers.dev/callback`
- `http://localhost:8787/callback` (only if you'll run it locally)

If the consent screen is in testing mode, add your Google account as a test user.

### 4. Set the secrets

```sh
npx wrangler secret put RUNDOWN_STUDIO_TOKEN
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
npx wrangler secret put ALLOWED_EMAILS
```

| Secret | What it is |
|---|---|
| `RUNDOWN_STUDIO_TOKEN` | Rundown Studio API token. A team-scoped token sees every rundown in the team; a rundown-scoped token sees one. |
| `GOOGLE_CLIENT_ID` | Client ID of the Google OAuth client from step 3. |
| `GOOGLE_CLIENT_SECRET` | Its client secret. |
| `ALLOWED_EMAILS` | Comma-separated Google accounts allowed to connect, e.g. `you@example.com,producer@example.com`. |

### 5. Connect it to Claude

In Claude, open **Settings → Connectors → Add custom connector** and enter
`https://rundown-studio-mcp.<your-subdomain>.workers.dev/mcp`. Approve the consent page, then sign
in with an allowlisted Google account.

## Local development

```sh
cp .dev.vars.example .dev.vars   # then fill in real values
npm run dev                      # http://localhost:8787
```

| Command | What it does |
|---|---|
| `npm test` | Unit tests. They use mocked API calls, so no network or token is needed. |
| `npm run typecheck` | TypeScript check. |
| `npm run smoke` | Live check against the real API, using `RUNDOWN_STUDIO_TOKEN` and `TEST_RUNDOWN_ID` from `.dev.vars`. It adds one temporary cue to the end of that rundown, writes and reads one of its cells, then deletes it. Existing content is not touched. |
| `npm run generate` | Regenerates `src/tools.generated.ts` from the published OpenAPI spec. |
| `npm run deploy` | Deploys to production. Refuses if there are uncommitted changes, and asks you to type `yes` when the current branch isn't `main`. Runs `secrets:push` (below), then `wrangler deploy` tagged with the short commit SHA, and prints the new version ID with that SHA. |
| `npm run scan` | Secret scan of the working tree and full git history with [gitleaks](https://github.com/gitleaks/gitleaks), plus checks for emails, workers.dev hostnames, local paths and ID-shaped strings. Run it before every push. |

### Optional: Doppler

`wrangler secret put` and `.dev.vars` are all you need. If you already keep secrets in
[Doppler](https://www.doppler.com), you can use it instead:

```sh
doppler setup --scope .      # pick your project and dev config; stored outside the repo
npm run dev:doppler          # wrangler dev with secrets from Doppler
npm run smoke:doppler        # smoke test with secrets from Doppler
```

`dev:doppler` needs every secret in the table above (plus `TEST_RUNDOWN_ID` for the smoke test).

Doppler has no built-in sync to Cloudflare Workers. To push your production config to the Worker,
create a gitignored `.doppler-push` file naming it:

```sh
DOPPLER_PROJECT=<your-project>
DOPPLER_CONFIG=<your-production-config>
```

Then `npm run secrets:push` sends the four Worker secrets with `wrangler secret bulk` (needs
[`jq`](https://jqlang.org)). `npm run deploy` runs it first, so Doppler becomes the source of
truth and any value changed only in the Cloudflare dashboard is overwritten on the next deploy.
The push refuses to run if any of the four is empty in Doppler. Without `.doppler-push`, it is
skipped and deploys use the secrets already on the Worker.

## How the tools are built

`scripts/generate-tools.ts` downloads the
[OpenAPI spec](https://api-v1.rundownstudio.app/openapi.yml) and turns an allowlist of operations
into tool definitions. Only the spec's structure is used: paths, methods, field names, types and
limits. The spec itself is not stored in this repo, and none of its text is copied. The generator:

- takes every tool title and description, and every argument description, from text written in
  the generator, and fails if an argument has none;
- drops every `description`, `summary`, `title`, `example` and `x-*` key from the spec (the
  spec's examples carry sample IDs), plus the rich-text field `content_html`;
- merges path, query and body parameters into one input schema, renaming the rundown `id` to
  `rundown_id`;
- marks GET tools read-only and DELETE tools destructive, using MCP annotations;
- pins every ID argument (`rundown_id`, `cue_id`, `column_id`, and the IDs inside `position` and
  `cue_order`) to `^[A-Za-z0-9_-]{1,64}$`;
- fails if an allowlisted operation disappears or is no longer marked `x-mcp: true`.

To add a tool, add an entry to `TOOLS` in the generator with its title, description and argument
descriptions, run `npm run generate`, and add tests.

## Rate limits and retries

Rundown Studio limits requests per team: 20 per minute on the free plan and 120 per minute on paid
plans, shared by every token in the team. The server:

- waits for `Retry-After` on a `429` and retries, waiting at most 30 seconds at a time and 45
  seconds per tool call;
- retries `5xx` errors and network failures with exponential backoff;
- sends an `Idempotency-Key` with every write and reuses it across that write's retries, so a
  retried create never makes a duplicate cue.

`get_rundown` with `include=cues,columns,cells` returns a whole rundown in one request. For a
rundown with more than 1,000 cells, use `list_cells` instead.

## Security notes

- Secrets live only in Worker secrets and your local, gitignored `.dev.vars`.
- Logs never include tokens, request URLs or cell content.
- The Worker refuses to serve until every secret and the KV binding is present.
- Every tool call is validated against its full input schema before any request reaches Rundown
  Studio, so a malformed argument or an ID such as `..` never shapes an API path.
- Requests to Rundown Studio never follow redirects, so the API token is only sent to the API
  itself. A redirect comes back as an error.
- `delete_cue` reads the cue order first and refuses a group that still holds cues, which the API
  would otherwise delete along with it.
- The API lets delete and reorder ignore a cue's Prevent Edits lock, so `delete_cue` and
  `reorder_cues` read the rundown's cues first. `delete_cue` refuses a locked cue, or a group holding
  one. `reorder_cues` refuses any order that changes a locked cue's group or its index among its
  siblings; other cues may still move. If the cues can't be read, both refuse rather than guess.
- Only redirect URIs for Claude, Cursor and localhost are accepted when connecting (see
  `allowedRedirectPatterns` in `src/googleHandler.ts`).

## Project layout

```
src/index.ts            Worker entry: OAuth provider, missing-secret check
src/googleHandler.ts    Consent page, Google sign-in, allowlist
src/mcpHandler.ts       /mcp: stateless Streamable HTTP MCP server
src/tools.ts            Tool dispatch, plain-text shaping, cell guard
src/tools.generated.ts  Generated tool definitions (do not edit)
src/rundownClient.ts    API client: retries, backoff, idempotency keys
scripts/                Generator, live smoke test, secret scan
test/                   Unit tests (vitest)
```
