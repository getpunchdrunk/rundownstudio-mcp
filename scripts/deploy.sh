#!/usr/bin/env bash
# scripts/deploy.sh: what `npm run deploy` runs.
#
# Refuses to deploy uncommitted changes and asks before deploying from any branch
# other than main. Then pushes secrets (scripts/secrets-push.sh) and runs
# `wrangler deploy` tagged with the short commit SHA, so every Worker version
# traces back to the commit it was built from. Both checks run before anything
# is sent to Cloudflare.

set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

if [ -n "$(git status --porcelain)" ]; then
  echo "deploy refused: uncommitted changes. Commit or stash them first:" >&2
  git status --short >&2
  exit 1
fi

branch=$(git rev-parse --abbrev-ref HEAD)
[ "$branch" = "HEAD" ] && branch="detached HEAD"
sha=$(git rev-parse --short HEAD)

if [ "$branch" != "main" ]; then
  echo "Warning: deploying from $branch, not main. Production will run code main doesn't have," >&2
  echo "and the next deploy from main will undo it." >&2
  read -r -p 'Type "yes" to deploy anyway: ' answer || answer=""
  if [ "$answer" != "yes" ]; then
    echo "deploy cancelled" >&2
    exit 1
  fi
fi

bash scripts/secrets-push.sh

log=$(mktemp)
trap 'rm -f "$log"' EXIT
npx wrangler deploy --tag "$sha" --message "Deployed from $branch at $sha" 2>&1 | tee "$log"

version=$(sed -n 's/^Current Version ID: *//p' "$log" | tail -n 1)
echo
echo "Deployed version ${version:-unknown (not found in wrangler output)}, tagged $sha"
