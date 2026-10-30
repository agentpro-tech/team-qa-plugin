#!/usr/bin/env bash
# install.sh — V6/F1+C2: renders the nightly LaunchAgent with ABSOLUTE paths and
# records the absolute node path for the wrappers to use when QA_CODE_NODE is not set.
# Zero dependency: only bash + sed + plutil + launchctl (already present on macOS).
#
# Usage:
#   bash scripts/install.sh --repo <path> [--dest <dir>] [--node <path>]
#                           [--state-dir <dir>] [--base <ref>] [--node-file <path>]
#                           [--print] [--load]
#   bash scripts/install.sh --uninstall [--dest <dir>] [--node-file <path>]
#
#   --print       render the plist to stdout, do NOT write files, do NOT load (for checking).
#   --load        opt-in: launchctl bootstrap the rendered plist. Default is NOT to load.
#   --dest        folder that holds the LaunchAgent. Default ~/Library/LaunchAgents.
set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" 2>/dev/null && pwd -P)" || exit 2
SKILL_DIR="$(cd "$SCRIPT_DIR/.." 2>/dev/null && pwd -P)" || exit 2
NIGHTLY_SCRIPT="$SCRIPT_DIR/nightly-mutation.sh"
TEMPLATE="$SKILL_DIR/launchd/io.qacode.mutation-nightly.plist"
LABEL="io.qacode.mutation-nightly"

usage() {
  echo "Usage: bash scripts/install.sh --repo <path> [--dest <dir>] [--node <path>] [--state-dir <dir>] [--base <ref>] [--node-file <path>] [--print] [--load]" >&2
  echo "       bash scripts/install.sh --uninstall [--dest <dir>] [--node-file <path>]" >&2
  exit 2
}

REPO=""
DEST="$HOME/Library/LaunchAgents"
NODE_OVERRIDE=""
STATE_DIR="$HOME/.qa-code/nightly"
BASE="HEAD~1"
NODE_FILE="${QA_CODE_NODE_FILE:-$SCRIPT_DIR/.node-path}"
PRINT=0
LOAD=0
UNINSTALL=0

while [ "$#" -gt 0 ]; do
  case "$1" in
    --repo|--dest|--node|--state-dir|--base|--node-file)
      [ "$#" -ge 2 ] || usage
      case "$1" in
        --repo) REPO="$2" ;;
        --dest) DEST="$2" ;;
        --node) NODE_OVERRIDE="$2" ;;
        --state-dir) STATE_DIR="$2" ;;
        --base) BASE="$2" ;;
        --node-file) NODE_FILE="$2" ;;
      esac
      shift 2
      ;;
    --print) PRINT=1; shift ;;
    --load) LOAD=1; shift ;;
    --uninstall) UNINSTALL=1; shift ;;
    -h|--help) usage ;;
    *) usage ;;
  esac
done

# Make a node candidate absolute; print the absolute path, or nothing if it cannot be executed.
absolutize_node() {
  candidate="$1"
  [ -n "$candidate" ] || { echo ""; return; }
  [ -x "$candidate" ] || { echo ""; return; }
  dir="$(cd "$(dirname "$candidate")" 2>/dev/null && pwd -P)" || { echo ""; return; }
  echo "$dir/$(basename "$candidate")"
}

resolve_node() {
  # Priority: --node > QA_CODE_NODE > discovery. The result is ALWAYS an absolute path.
  local picked=""
  if [ -n "$NODE_OVERRIDE" ]; then
    picked="$(absolutize_node "$NODE_OVERRIDE")"
    [ -n "$picked" ] || { echo "qa-code install: --node is not executable: $NODE_OVERRIDE" >&2; exit 2; }
  elif [ -n "${QA_CODE_NODE:-}" ]; then
    picked="$(absolutize_node "$QA_CODE_NODE")"
    [ -n "$picked" ] || { echo "qa-code install: QA_CODE_NODE is not executable: $QA_CODE_NODE" >&2; exit 2; }
  else
    picked="$(absolutize_node "$(command -v node 2>/dev/null || true)")"
    if [ -z "$picked" ]; then
      for c in /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node; do
        picked="$(absolutize_node "$c")"; [ -n "$picked" ] && break
      done
    fi
  fi
  [ -n "$picked" ] || { echo "qa-code install: cannot find a node executable to pin" >&2; exit 2; }
  echo "$picked"
}

# Escape sed special characters in the replacement side (\, &, and the | delimiter).
sed_escape() {
  printf '%s' "$1" | sed -e 's/[\\&|]/\\&/g'
}

# XML-escape so that a value inserted into <string> does not break the plist when a path/ref contains & < >.
# plutil/launchd un-escape it again, so the runtime value (argv, env, path) is unchanged.
xml_escape() {
  printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'
}

# Replacement side for the sed template: XML-escape first (plist-safe), then sed_escape (sed-safe).
sub_value() {
  sed_escape "$(xml_escape "$1")"
}

if [ "$UNINSTALL" -eq 1 ]; then
  target="$DEST/$LABEL.plist"
  if command -v launchctl >/dev/null 2>&1; then
    launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || launchctl unload "$target" 2>/dev/null || true
  fi
  rm -f "$target" "$NODE_FILE"
  echo "qa-code install: removed $LABEL from $DEST and deleted $NODE_FILE"
  exit 0
fi

[ -n "$REPO" ] || usage
[ -f "$TEMPLATE" ] || { echo "qa-code install: missing plist template: $TEMPLATE" >&2; exit 2; }
REPO_REAL="$(cd "$REPO" 2>/dev/null && pwd -P)" || { echo "qa-code install: cannot read --repo: $REPO" >&2; exit 2; }
[ -e "$REPO_REAL/.git" ] || { echo "qa-code install: --repo must be a git repo: $REPO_REAL" >&2; exit 2; }

# resolve_node runs inside $(); its exit 2 only leaves the subshell => it must be passed on,
# otherwise the script keeps going and writes the plist/node-file with an empty NODE (round-2 bug).
NODE_ABS="$(resolve_node)" || exit $?
STDOUT="$STATE_DIR/stdout.log"
STDERR="$STATE_DIR/stderr.log"

RENDERED="$(sed \
  -e "s|__NIGHTLY_SCRIPT__|$(sub_value "$NIGHTLY_SCRIPT")|g" \
  -e "s|__TARGET_REPO__|$(sub_value "$REPO_REAL")|g" \
  -e "s|__SKILL_DIR__|$(sub_value "$SKILL_DIR")|g" \
  -e "s|__NODE__|$(sub_value "$NODE_ABS")|g" \
  -e "s|__STATE_DIR__|$(sub_value "$STATE_DIR")|g" \
  -e "s|__STDOUT__|$(sub_value "$STDOUT")|g" \
  -e "s|__STDERR__|$(sub_value "$STDERR")|g" \
  -e "s|__BASE__|$(sub_value "$BASE")|g" \
  "$TEMPLATE")"

if [ "$PRINT" -eq 1 ]; then
  printf '%s\n' "$RENDERED"
  exit 0
fi

# Write the node record for the wrappers (C2): when QA_CODE_NODE is not set they read this file instead of searching PATH.
mkdir -p "$(dirname "$NODE_FILE")" || { echo "qa-code install: cannot create the node-file folder" >&2; exit 2; }
printf '%s\n' "$NODE_ABS" > "$NODE_FILE"

mkdir -p "$DEST" "$STATE_DIR" || { echo "qa-code install: cannot create DEST/STATE_DIR" >&2; exit 2; }
TARGET="$DEST/$LABEL.plist"
printf '%s\n' "$RENDERED" > "$TARGET"
/usr/bin/plutil -lint "$TARGET" >/dev/null || { echo "qa-code install: rendered plist is invalid: $TARGET" >&2; exit 2; }

if [ "$LOAD" -eq 1 ]; then
  if command -v launchctl >/dev/null 2>&1; then
    launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
    launchctl bootstrap "gui/$(id -u)" "$TARGET" 2>/dev/null \
      || launchctl load "$TARGET" 2>/dev/null \
      || { echo "qa-code install: launchctl cannot load $TARGET" >&2; exit 2; }
    echo "qa-code install: rendered + loaded $LABEL"
  else
    echo "qa-code install: launchctl missing, render only (not loaded)" >&2
  fi
else
  echo "qa-code install: rendered $TARGET (not loaded; use --load to activate)"
fi
echo "  node pin : $NODE_ABS"
echo "  node file: $NODE_FILE"
echo "  repo     : $REPO_REAL"
echo "  state    : $STATE_DIR"
