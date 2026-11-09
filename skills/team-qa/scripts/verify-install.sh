#!/usr/bin/env bash
set -euo pipefail
# The real path of a folder, a link to one followed, without the realpath command (macOS 12 and older have none);
# empty when it cannot be resolved, and an empty result never matches.
real_dir() { (CDPATH= cd -P -- "$1" 2>/dev/null && pwd -P) || true; }
ROOT="${1:-$HOME/.agents/skills/team-qa}"
COMPAT_ROOT="${2:-$HOME}"
for file in SOURCE.json package-manifest.json release-truth.json release-truth-gate.mjs release-policy.mjs; do [ -f "$ROOT/$file" ] || { echo "verify-install: missing $ROOT/$file" >&2; exit 20; }; done
node "$ROOT/scripts/package-tool.mjs" verify-runtime --root "$ROOT" --source "$ROOT/SOURCE.json"
TRUTH_SCOPE="$(node -p "JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).scope" "$ROOT/release-truth.json")"
if [ "$TRUTH_SCOPE" = local_candidate ]; then
  [ "$COMPAT_ROOT" != "$HOME" ] || { echo 'verify-install: a local candidate must not use the official compat root' >&2; exit 24; }
  node "$ROOT/release-truth-gate.mjs" verify-envelope --receipt "$ROOT/release-truth.json" --source "$ROOT/SOURCE.json" --allow-local-candidate yes
else
  node "$ROOT/release-truth-gate.mjs" verify-envelope --receipt "$ROOT/release-truth.json" --source "$ROOT/SOURCE.json"
fi
WANT="$(real_dir "$ROOT")"; [ -n "$WANT" ] || { echo "verify-install: cannot resolve $ROOT" >&2; exit 21; }
for scope in "$COMPAT_ROOT/.claude/skills/team-qa" "$COMPAT_ROOT/.codex/skills/team-qa"; do GOT="$(real_dir "$scope")"; [ -n "$GOT" ] && [ "$GOT" = "$WANT" ] || { echo "verify-install: compat mismatch $scope" >&2; exit 21; }; done
echo 'VERIFY_INSTALL_PASS skill=team-qa'
