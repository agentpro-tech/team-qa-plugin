#!/usr/bin/env bash
set -euo pipefail
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
for scope in "$COMPAT_ROOT/.claude/skills/team-qa" "$COMPAT_ROOT/.codex/skills/team-qa"; do [ "$(realpath "$scope" 2>/dev/null || true)" = "$(realpath "$ROOT")" ] || { echo "verify-install: compat mismatch $scope" >&2; exit 21; }; done
echo 'VERIFY_INSTALL_PASS skill=team-qa'
