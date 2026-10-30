#!/usr/bin/env bash
# mutate.sh — the nightly mutation gate of qa-code P4.
# Bash only normalizes the CLI; all mutant generation and restoring live in lib/mutate.mjs.
set -u

usage() {
  echo "Usage: bash scripts/mutate.sh --repo <path> [--base <ref>] [--config <file>] [--json <out>] [--max-seconds N]" >&2
  exit 2
}

REPO=""
BASE="HEAD~1"
CONFIG=""
JSON_OUT=""
MAX_SECONDS="1800"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --repo|--base|--config|--json|--max-seconds)
      [ "$#" -ge 2 ] || usage
      case "$1" in
        --repo) REPO="$2" ;;
        --base) BASE="$2" ;;
        --config) CONFIG="$2" ;;
        --json) JSON_OUT="$2" ;;
        --max-seconds) MAX_SECONDS="$2" ;;
      esac
      shift 2
      ;;
    -h|--help)
      usage
      ;;
    *)
      usage
      ;;
  esac
done

[ -n "$REPO" ] || usage
[ -d "$REPO" ] || { echo "qa-code: --repo is not a directory: $REPO" >&2; exit 2; }

# pwd -P resolves symlinks and keeps a path with spaces intact when passed as one argv.
REPO_REAL="$(cd "$REPO" 2>/dev/null && pwd -P)" || {
  echo "qa-code: cannot read --repo: $REPO" >&2
  exit 2
}
[ -e "$REPO_REAL/.git" ] || {
  echo "qa-code: --repo must be a git repo: $REPO_REAL" >&2
  exit 2
}

SCRIPT_DIR="$(cd "$(dirname "$0")" 2>/dev/null && pwd -P)" || exit 2

# V6: QA_CODE_NODE wins over PATH. Set but not executable => UNGRADED exit 20, fallback forbidden.
if [ -n "${QA_CODE_NODE:-}" ]; then
  if [ ! -x "$QA_CODE_NODE" ]; then
    echo "qa-code: QA_CODE_NODE is not executable, no PATH fallback: $QA_CODE_NODE" >&2
    exit 20
  fi
  NODE_BIN="$QA_CODE_NODE"
else
  # C2: QA_CODE_NODE not set => use the absolute path recorded at install time (install.sh), do NOT search PATH.
  NODE_FILE="${QA_CODE_NODE_FILE:-$SCRIPT_DIR/.node-path}"
  if [ -f "$NODE_FILE" ]; then
    # Record PRESENT => it must be an absolute executable. Empty/relative/missing/not executable all mean a broken
    # record => fail-closed exit 20, NEVER search PATH for another Node (an undeclared runtime change).
    NODE_RECORDED="$(head -n1 "$NODE_FILE" 2>/dev/null || true)"
    case "$NODE_RECORDED" in
      /*) ;;
      *) echo "qa-code: broken node record (empty/not absolute), PATH fallback forbidden: $NODE_FILE" >&2; exit 20 ;;
    esac
    if [ ! -x "$NODE_RECORDED" ]; then
      echo "qa-code: node record points to a file that is not executable, PATH fallback forbidden: $NODE_RECORDED" >&2
      exit 20
    fi
    NODE_BIN="$NODE_RECORDED"
  else
    # Record ABSENT (not installed): keep the old discovery for the dev/test path — the frozen yardstick relies on it.
    NODE_BIN="$(command -v node 2>/dev/null || true)"
    if [ -z "$NODE_BIN" ]; then
      for NODE_CANDIDATE in /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node; do
        if [ -x "$NODE_CANDIDATE" ]; then
          NODE_BIN="$NODE_CANDIDATE"
          break
        fi
      done
    fi
  fi
fi
[ -n "$NODE_BIN" ] || { echo "qa-code: missing node runtime" >&2; exit 20; }

set -- "$SCRIPT_DIR/lib/mutate.mjs" --repo "$REPO_REAL" --base "$BASE" --max-seconds "$MAX_SECONDS"
[ -z "$CONFIG" ] || set -- "$@" --config "$CONFIG"
[ -z "$JSON_OUT" ] || set -- "$@" --json "$JSON_OUT"

exec "$NODE_BIN" "$@"
