#!/bin/sh
# scripts/scan.sh: run before every push. Exits non-zero on any finding.
#
#   1. gitleaks over the working tree and over full git history
#   2. grep of tracked files for things that must never be committed
#
# Private terms to catch (your name, company, Cloudflare subdomain) go one per
# line in .scan-terms, which is gitignored. Matched case-insensitively.

set -u
cd "$(git rev-parse --show-toplevel)" || exit 2
status=0

if ! command -v gitleaks >/dev/null 2>&1; then
  echo "gitleaks not installed (brew install gitleaks)"; exit 2
fi

echo "== gitleaks: working tree"
gitleaks dir . --no-banner --redact || status=1
if git rev-parse --verify HEAD >/dev/null 2>&1; then
  echo "== gitleaks: full history"
  gitleaks git . --no-banner --redact --log-opts="--all" || status=1
fi

echo "== tracked files"
files=$(git ls-files; git ls-files --others --exclude-standard)

# Placeholders, this script's own patterns and the LICENSE copyright line may match.
ALLOW='you@example\.com|example\.com|<your-subdomain>|<subdomain>|^scripts/scan\.sh:'
ALLOW="$ALLOW"'|^LICENSE:3:Copyright \(c\) 2026 Punch Drunk Productions$'

report() { # label, hits
  if [ -n "$2" ]; then echo "FOUND $1:"; echo "$2"; status=1; fi
}
check() { # label, grep flags, regex
  hits=$(printf '%s\n' "$files" | xargs grep -n -I $2 -e "$3" -- 2>/dev/null | grep -v -E "$ALLOW")
  report "$1" "$hits"
}

check "email address" -E '[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z]{2,}'
check "workers.dev subdomain" -E '[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev'
check "local path" -E '/(Users|home)/[A-Za-z]'
check "account_id setting" -E '^[[:space:]]*account_id[[:space:]]*='
check "namespace or account id" -E '"[0-9a-f]{32}"'

# Rundown Studio IDs: 20 characters mixing upper case, lower case and digits.
ids=$(printf '%s\n' "$files" | grep -v -E '^package-lock\.json$' |
  xargs grep -n -I -o -E '(^|[^A-Za-z0-9_])[A-Za-z0-9]{20}([^A-Za-z0-9_]|$)' -- 2>/dev/null |
  awk -F: '{ id = $3; gsub(/[^A-Za-z0-9]/, "", id) }
           id ~ /[0-9]/ && id ~ /[A-Z]/ && id ~ /[a-z]/ { print $1 ":" $2 ": " id }')
report "Rundown Studio-style ID" "$ids"

if [ -f .scan-terms ]; then
  while IFS= read -r term; do
    [ -n "$term" ] && check "private term" "-i -F" "$term"
  done < .scan-terms
fi

[ $status -eq 0 ] && echo "scan: clean" || echo "scan: FINDINGS above; do not push"
exit $status
