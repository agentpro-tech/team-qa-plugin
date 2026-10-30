#!/usr/bin/env bash
# gate0.sh — orchestrates the four-layer Gate 0 of qa-code P1.
# Output normalization and coverage computation live in lib/gate0.mjs to avoid an npm dependency.
set -u

usage() {
  echo "Usage: bash scripts/gate0.sh --repo <path> --base <ref> [--requirements <requirements.freeze/v2>] [--json <out>] [--cve-cmd <cmd>] [--config <file>]" >&2
  exit 2
}

REPO=""
BASE=""
JSON_OUT=""
CVE_CMD=""
CONFIG=""
REQUIREMENTS=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --repo|--base|--json|--cve-cmd|--config|--requirements)
      [ "$#" -ge 2 ] || usage
      case "$1" in
        --repo) REPO="$2" ;;
        --base) BASE="$2" ;;
        --json) JSON_OUT="$2" ;;
        --cve-cmd) CVE_CMD="$2" ;;
        --config) CONFIG="$2" ;;
        --requirements) REQUIREMENTS="$2" ;;
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
[ -n "$BASE" ] || { echo 'qa-code: UNGRADED — missing --base; TASK_BASE is required' >&2; exit 20; }
[ -d "$REPO" ] || { echo "qa-code: --repo is not a directory: $REPO" >&2; exit 2; }

# Take the physical path so that symlinks and spaces do not break comparisons in the helper.
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
# Acceptance deliberately narrows PATH to /usr/bin:/bin to make the three scanners disappear. Node is still
# a required runtime of qa-code, so also look in the standard macOS Homebrew locations.
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
[ -n "$NODE_BIN" ] || {
  echo "qa-code: missing node runtime" >&2
  exit 20
}

set -- "$SCRIPT_DIR/lib/gate0.mjs" --repo "$REPO_REAL" --base "$BASE"
[ -z "$JSON_OUT" ] || set -- "$@" --json "$JSON_OUT"
[ -z "$CVE_CMD" ] || set -- "$@" --cve-cmd "$CVE_CMD"
[ -z "$CONFIG" ] || set -- "$@" --config "$CONFIG"
[ -z "$REQUIREMENTS" ] || set -- "$@" --requirements "$REQUIREMENTS"

exec "$NODE_BIN" "$@"
