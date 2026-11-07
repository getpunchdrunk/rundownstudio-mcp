#!/bin/sh
# scripts/scan.sh: run before every push. Exits non-zero on any finding.
#
#   1. gitleaks over the working tree and over full git history (all refs)
#   2. pattern checks for things that must never be committed (private terms,
#      emails, workers.dev hostnames, local paths, account and Rundown Studio
#      IDs) over three sources:
#        - tracked files, plus untracked files that aren't gitignored
#        - every line ever added in the history being pushed
#        - the commit messages in that history
#
# The pattern checks read the history of HEAD, which is what `git push` sends.
# To check other refs too, set SCAN_REFS, e.g. `SCAN_REFS=--all npm run scan`.
# Author and committer lines aren't checked; set your identity before committing.
#
# Private terms to catch (your name, company, Cloudflare subdomain) go one per
# line in .scan-terms, which is gitignored. Matched case-insensitively.

set -u
cd "$(git rev-parse --show-toplevel)" || exit 2
status=0
refs=${SCAN_REFS:-HEAD}
tmp=$(mktemp -d) || exit 2
trap 'rm -rf "$tmp"' EXIT

if ! command -v gitleaks >/dev/null 2>&1; then
  echo "gitleaks not installed (brew install gitleaks)"; exit 2
fi

echo "== gitleaks: working tree"
gitleaks dir . --no-banner --redact || status=1
has_history=false
if git rev-parse --verify HEAD >/dev/null 2>&1; then
  has_history=true
  echo "== gitleaks: full history"
  gitleaks git . --no-banner --redact --log-opts="--all" || status=1
fi

# Every source becomes lines of "where:location:text", so one set of checks and
# one allowlist covers them all:
#   files     path:line:text
#   history   path:commit:text            (lines added by that commit)
#   messages  commit-message:commit:text
git ls-files > "$tmp/list"
git ls-files --others --exclude-standard >> "$tmp/list"
tr '\n' '\0' < "$tmp/list" | xargs -0 grep -n -H -I -e '' -- > "$tmp/files" 2>/dev/null
: > "$tmp/history"
: > "$tmp/messages"
if $has_history; then
  # shellcheck disable=SC2086
  git -c core.quotepath=off log $refs -p --no-color --no-ext-diff --format='@@scan-commit %h' |
    awk '/^@@scan-commit [0-9a-f]+$/ { sha = $2; hunk = 0; next }
         /^diff --git / { hunk = 0; next }
         !hunk && /^\+\+\+ / { path = substr($0, 5); sub(/^b\//, "", path); sub(/\t$/, "", path); next }
         /^@@/ { hunk = 1; next }
         hunk && /^\+/ { print path ":" sha ":" substr($0, 2) }' > "$tmp/history"
  # shellcheck disable=SC2086
  git log $refs --format='@@scan-commit %h%n%B' |
    awk '/^@@scan-commit [0-9a-f]+$/ { sha = $2; next }
         { print "commit-message:" sha ":" $0 }' > "$tmp/messages"
fi
# shellcheck disable=SC2086 # $refs may hold several options
count=$(git rev-list --count $refs 2>/dev/null || echo 0)
echo "== pattern checks: files, history of $refs ($count commits), commit messages"

# Placeholders, this script's own patterns, the LICENSE copyright line and the
# Co-Authored-By trailer address may match.
ALLOW='you@example\.com|example\.com|<your-subdomain>|<subdomain>|^scripts/scan\.sh:'
ALLOW="$ALLOW"'|^LICENSE:[0-9a-f]+:Copyright \(c\) 2026 Punch Drunk Productions$'
ALLOW="$ALLOW"'|^commit-message:[0-9a-f]+:Co-Authored-By: Claude [^<]*<noreply@anthropic\.com>$'

report() { # label, hits
  if [ -n "$2" ]; then echo "FOUND $1:"; echo "$2"; status=1; fi
}
check() { # label, grep flags, regex
  # shellcheck disable=SC2086
  hits=$(cat "$tmp/files" "$tmp/history" "$tmp/messages" | grep $2 -e "$3" | grep -v -E "$ALLOW")
  report "$1" "$hits"
}

check "email address" -E '[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z]{2,}'
check "workers.dev subdomain" -E '[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev'
check "local path" -E '/(Users|home)/[A-Za-z]'
check "account_id setting" -E '^[^:]*:[^:]*:[[:space:]]*account_id[[:space:]]*='
check "namespace or account id" -E '"[0-9a-f]{32}"'

# Rundown Studio IDs: 20 characters mixing upper case, lower case and digits.
ids=$(cat "$tmp/files" "$tmp/history" "$tmp/messages" | grep -v -E '^package-lock\.json:' |
  awk '{ i = index($0, ":"); j = index(substr($0, i + 1), ":")
         where = substr($0, 1, i + j); text = substr($0, i + j + 1)
         while (match(text, /[A-Za-z0-9_]+/)) {
           id = substr(text, RSTART, RLENGTH); text = substr(text, RSTART + RLENGTH)
           if (length(id) == 20 && id !~ /_/ && id ~ /[0-9]/ && id ~ /[A-Z]/ && id ~ /[a-z]/)
             print where " " id
         } }')
report "Rundown Studio-style ID" "$ids"

if [ -f .scan-terms ]; then
  while IFS= read -r term; do
    [ -n "$term" ] && check "private term" "-i -F" "$term"
  done < .scan-terms
else
  echo "note: no .scan-terms file, so private terms weren't checked"
fi

[ $status -eq 0 ] && echo "scan: clean" || echo "scan: FINDINGS above; do not push"
exit $status
