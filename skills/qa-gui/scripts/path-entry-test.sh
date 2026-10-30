#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
BASE="$ROOT/qa-evidence/fixture-a/baseline/1280x800/after-load.png"
[ -f "$BASE" ] || { echo "path-entry-test: missing fixture $BASE" >&2; exit 2; }
TMP="$(mktemp -d /tmp/qa-gui-path-entry.XXXXXX)"
ln -s "$ROOT" "$TMP/qa-gui-link"
run_case() {
  local label="$1" script="$2" out
  out="$(node "$script" "$BASE" "$BASE" --state "$label")"
  printf '%s' "$out" | grep -q '"verdict":"PASS"' || { echo "FAIL $label: entrypoint did not really run" >&2; exit 1; }
  echo "OK   $label"
}
run_case source "$ROOT/scripts/visual-diff.mjs"
run_case symlink "$TMP/qa-gui-link/scripts/visual-diff.mjs"
ALIAS="/tmp/$(basename "$TMP")/qa-gui-link/scripts/visual-diff.mjs"
run_case tmp-alias "$ALIAS"
echo 'PATH_ENTRY_PASS source+symlink+tmp-alias'
