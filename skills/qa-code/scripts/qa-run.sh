#!/usr/bin/env bash
# qa-run.sh — Bash 3.2 wrapper for the P3 QA harness.
# All JSON handling lives in the built-in-only Node helper; the wrapper only finds the runtime and keeps argv intact.
set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" 2>/dev/null && pwd -P)" || exit 2

# V6: QA_CODE_NODE wins over PATH; set but not executable => UNGRADED exit 20, fallback forbidden.
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

exec "$NODE_BIN" "$SCRIPT_DIR/lib/qa-harness.mjs" "$@"
