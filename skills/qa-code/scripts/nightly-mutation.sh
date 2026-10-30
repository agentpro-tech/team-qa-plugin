#!/usr/bin/env bash
# nightly-mutation.sh — V6: runs mutation every night, writes a log and alerts when skipped runs pile up.
# The 3rd consecutive skipped run creates an `alert` file; one gradable run resets the skip streak.
# Tests inject through QA_CODE_NIGHTLY_STATE_DIR, QA_CODE_NIGHTLY_NOW, QA_CODE_NIGHTLY_FORCE_SKIP.
set -u

usage() {
  echo "Usage: bash scripts/nightly-mutation.sh --repo <path> [--base <ref>]" >&2
  exit 2
}

REPO=""
BASE="HEAD~1"
while [ "$#" -gt 0 ]; do
  case "$1" in
    --repo|--base)
      [ "$#" -ge 2 ] || usage
      case "$1" in
        --repo) REPO="$2" ;;
        --base) BASE="$2" ;;
      esac
      shift 2
      ;;
    -h|--help) usage ;;
    *) usage ;;
  esac
done

[ -n "$REPO" ] || usage

SCRIPT_DIR="$(cd "$(dirname "$0")" 2>/dev/null && pwd -P)" || exit 2
STATE_DIR="${QA_CODE_NIGHTLY_STATE_DIR:-$HOME/.qa-code/nightly}"
NOW="${QA_CODE_NIGHTLY_NOW:-$(date -u +%Y-%m-%dT%H:%M:%SZ)}"
mkdir -p "$STATE_DIR" || { echo "qa-code: cannot create state dir: $STATE_DIR" >&2; exit 20; }

LOG="$STATE_DIR/nightly.log"
STREAK_FILE="$STATE_DIR/skip-streak"
ALERT="$STATE_DIR/alert"

read_streak() {
  if [ -f "$STREAK_FILE" ]; then
    cat "$STREAK_FILE" 2>/dev/null || echo 0
  else
    echo 0
  fi
}

record_skip() {
  streak="$(read_streak)"
  case "$streak" in ''|*[!0-9]*) streak=0 ;; esac
  streak=$((streak + 1))
  printf '%s\n' "$streak" > "$STREAK_FILE"
  printf '%s SKIP streak=%s reason=%s\n' "$NOW" "$streak" "$1" >> "$LOG"
  if [ "$streak" -ge 3 ]; then
    printf '%s alert: %s consecutive skipped runs\n' "$NOW" "$streak" > "$ALERT"
    printf '%s ALERT %s consecutive skipped runs\n' "$NOW" "$streak" >> "$LOG"
  fi
}

record_run() {
  printf '0\n' > "$STREAK_FILE"
  rm -f "$ALERT"
  printf '%s RUN status=%s\n' "$NOW" "$1" >> "$LOG"
}

# Test injection path: force a skipped run to check the alert streak without running real mutation.
if [ "${QA_CODE_NIGHTLY_FORCE_SKIP:-0}" = "1" ]; then
  record_skip "forced"
  exit 0
fi

# Real path: run mutation. Gradable (pass/fail) resets the streak; ungraded/error counts as a skipped run.
MUT_JSON="$STATE_DIR/last-mutation.json"
bash "$SCRIPT_DIR/mutate.sh" --repo "$REPO" --base "$BASE" --json "$MUT_JSON"
MUT_STATUS="$?"
if [ "$MUT_STATUS" -eq 0 ] || [ "$MUT_STATUS" -eq 1 ]; then
  record_run "$MUT_STATUS"
else
  record_skip "mutation-ungraded-exit-$MUT_STATUS"
fi
exit 0
