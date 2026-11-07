#!/usr/bin/env bash
# scripts/secrets-push.sh: optional. Copies the Worker's secrets from Doppler to
# Cloudflare with `wrangler secret bulk`. `npm run deploy` runs it first.
#
# Reads DOPPLER_PROJECT and DOPPLER_CONFIG (your production config) from
# .doppler-push, which is gitignored:
#
#   DOPPLER_PROJECT=<your-project>
#   DOPPLER_CONFIG=<your-production-config>
#
# Without that file it does nothing, so deploys without Doppler are unaffected.
# Values are never printed; wrangler reports secret names only.

set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

KEYS=(RUNDOWN_STUDIO_TOKEN GOOGLE_CLIENT_ID GOOGLE_CLIENT_SECRET ALLOWED_EMAILS)

if [ ! -f .doppler-push ]; then
  echo "secrets:push skipped (no .doppler-push file; using secrets already on the Worker)"
  exit 0
fi
# shellcheck disable=SC1091
. ./.doppler-push
: "${DOPPLER_PROJECT:?set DOPPLER_PROJECT in .doppler-push}"
: "${DOPPLER_CONFIG:?set DOPPLER_CONFIG in .doppler-push}"

filter="{$(IFS=,; echo "${KEYS[*]}")}"
payload=$(doppler secrets download --project "$DOPPLER_PROJECT" --config "$DOPPLER_CONFIG" \
  --no-file --format json | jq -c "$filter")

# Refuse to push if any value is missing or empty, so a bad download can't blank a secret.
empty=$(jq -r 'to_entries | map(select((.value // "") == "") | .key) | join(", ")' <<<"$payload")
if [ -n "$empty" ]; then
  echo "secrets:push refused: empty in Doppler: $empty" >&2
  exit 1
fi

npx wrangler secret bulk <<<"$payload"
