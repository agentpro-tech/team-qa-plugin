#!/usr/bin/env bash
set -euo pipefail
# The real path of a folder, a link to one followed, without the realpath command (macOS 12 and older have none);
# empty when it cannot be resolved, and an empty result never matches.
real_dir() { (CDPATH= cd -P -- "$1" 2>/dev/null && pwd -P) || true; }
ROOT="${1:-$HOME/.agents/skills/qa-gui}"
COMPAT_ROOT="${2:-$HOME}"
[ -f "$ROOT/SOURCE.json" ] || { echo "verify-install: missing $ROOT/SOURCE.json" >&2; exit 20; }
node "$ROOT/scripts/package-tool.mjs" verify-runtime --root "$ROOT" --source "$ROOT/SOURCE.json"
WANT="$(real_dir "$ROOT")"; [ -n "$WANT" ] || { echo "verify-install: cannot resolve $ROOT" >&2; exit 21; }
for scope in "$COMPAT_ROOT/.claude/skills/qa-gui" "$COMPAT_ROOT/.codex/skills/qa-gui"; do
  GOT="$(real_dir "$scope")"; [ -n "$GOT" ] && [ "$GOT" = "$WANT" ] || { echo "verify-install: compat mismatch $scope" >&2; exit 21; }
done
echo 'VERIFY_INSTALL_PASS skill=qa-gui'
