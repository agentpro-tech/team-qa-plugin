#!/usr/bin/env bash
set -euo pipefail
ROOT="${1:-$HOME/.agents/skills/qa-code}"
[ -f "$ROOT/SOURCE.json" ] || { echo "verify-install: missing $ROOT/SOURCE.json" >&2; exit 20; }
NODE_FILE="$ROOT/scripts/.node-path"
[ -f "$NODE_FILE" ] || { echo "verify-install: missing $NODE_FILE" >&2; exit 20; }
NODE_BIN="$(head -n1 "$NODE_FILE" 2>/dev/null || true)"
case "$NODE_BIN" in /*) ;; *) echo "verify-install: node pin is not absolute: $NODE_FILE" >&2; exit 20;; esac
[ -x "$NODE_BIN" ] || { echo "verify-install: node pin is not executable: $NODE_BIN" >&2; exit 20; }
"$NODE_BIN" "$ROOT/scripts/package-tool.mjs" verify-runtime --root "$ROOT" --source "$ROOT/SOURCE.json"
COMPAT="${2:-$HOME}"
for scope in "$COMPAT/.claude/skills/qa-code" "$COMPAT/.codex/skills/qa-code"; do
  [ "$(realpath "$scope" 2>/dev/null || true)" = "$(realpath "$ROOT")" ] || { echo "verify-install: compat mismatch $scope" >&2; exit 21; }
done
echo 'VERIFY_INSTALL_PASS skill=qa-code'
