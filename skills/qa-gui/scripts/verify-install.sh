#!/usr/bin/env bash
set -euo pipefail
ROOT="${1:-$HOME/.agents/skills/qa-gui}"
COMPAT_ROOT="${2:-$HOME}"
[ -f "$ROOT/SOURCE.json" ] || { echo "verify-install: missing $ROOT/SOURCE.json" >&2; exit 20; }
node "$ROOT/scripts/package-tool.mjs" verify-runtime --root "$ROOT" --source "$ROOT/SOURCE.json"
for scope in "$COMPAT_ROOT/.claude/skills/qa-gui" "$COMPAT_ROOT/.codex/skills/qa-gui"; do
  [ "$(realpath "$scope" 2>/dev/null || true)" = "$(realpath "$ROOT")" ] || { echo "verify-install: compat mismatch $scope" >&2; exit 21; }
done
echo 'VERIFY_INSTALL_PASS skill=qa-gui'
