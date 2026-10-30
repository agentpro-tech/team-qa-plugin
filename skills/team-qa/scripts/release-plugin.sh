#!/usr/bin/env bash
# Builds the Team QA plugin for Claude Code from a signed suite folder (BA "Team QA as a Claude Code plugin", C6).
#
#   bash scripts/release-plugin.sh --suite <teamqa-suite-X.Y.Z folder> --out <new folder>
#
# 1. The suite's own install.sh checks the publisher signature of the suite and of each skill, and installs QA Code,
#    QA GUI and Team QA into a scratch root, exactly as it does on a user's Mac.
# 2. Those installed folders become skills/ of the plugin, unchanged.
# 3. The plugin's manifest, README, bin/teamqa and hooks/hooks.json come from the installed (signed) Team QA's
#    scripts/plugin folder; only {{VERSION}} is filled in.
# 4. Every skill passes package-tool verify-runtime again in its final place, the plugin holds no symlink or system
#    file, and `claude plugin validate` passes when Claude Code is on PATH.
# Nothing outside --out and a scratch folder is written; the user's ~/.agents, ~/.claude and ~/.codex are not touched.
set -euo pipefail
SUITE=""; OUT=""
while [ "$#" -gt 0 ]; do case "$1" in
  --suite) SUITE="${2:?}"; shift 2;;
  --out) OUT="${2:?}"; shift 2;;
  *) echo "usage: release-plugin.sh --suite <suite folder> --out <new folder>" >&2; exit 2;;
esac; done
[ -n "$SUITE" ] && [ -n "$OUT" ] || { echo "usage: release-plugin.sh --suite <suite folder> --out <new folder>" >&2; exit 2; }
SUITE="$(cd "$SUITE" && pwd -P)"
[ -f "$SUITE/suite.json" ] && [ -f "$SUITE/install.sh" ] || { echo "PLUGIN_SUITE_INVALID $SUITE has no suite.json or install.sh" >&2; exit 2; }
if [ -e "$OUT" ] && [ -n "$(ls -A "$OUT" 2>/dev/null)" ]; then echo "PLUGIN_OUT_NOT_EMPTY $OUT" >&2; exit 2; fi
mkdir -p "$OUT"; OUT="$(cd "$OUT" && pwd -P)"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/teamqa-plugin-build.XXXXXX")"
VERSION="$(node -p "JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).version" "$SUITE/suite.json")"
echo "plugin: Team QA suite $VERSION from $SUITE"

# 1. Install with the suite's own installer into scratch roots (never the user's).
bash "$SUITE/install.sh" --dest-root "$WORK/skills" --compat-root "$WORK/compat" > "$WORK/install.log" 2>&1 || { cat "$WORK/install.log" >&2; echo "PLUGIN_SUITE_INSTALL_FAILED" >&2; exit 3; }
grep -E 'publisher key|SUITE_INSTALLED' "$WORK/install.log" || true

# 2. The installed skills, unchanged.
mkdir -p "$OUT/.claude-plugin" "$OUT/skills" "$OUT/bin" "$OUT/hooks"
for skill in qa-code qa-gui team-qa; do
  [ -f "$WORK/skills/$skill/SOURCE.json" ] && [ -f "$WORK/skills/$skill/release-signature.json" ] || { echo "PLUGIN_SKILL_MISSING $skill" >&2; exit 3; }
  cp -R "$WORK/skills/$skill" "$OUT/skills/$skill"
done
TQ="$OUT/skills/team-qa"

# 3. Plugin files from the signed Team QA.
for f in plugin.json README.md hooks.json teamqa plugin-gate.sh; do [ -f "$TQ/scripts/plugin/$f" ] || { echo "PLUGIN_TEMPLATE_MISSING scripts/plugin/$f" >&2; exit 3; }; done
node -e '
const fs = require("fs"); const [src, dest, version] = process.argv.slice(1);
const doc = JSON.parse(fs.readFileSync(src, "utf8")); doc.version = version;
fs.writeFileSync(dest, JSON.stringify(doc, null, 2) + "\n");' "$TQ/scripts/plugin/plugin.json" "$OUT/.claude-plugin/plugin.json" "$VERSION"
sed "s/{{VERSION}}/$VERSION/g" "$TQ/scripts/plugin/README.md" > "$OUT/README.md"
cp "$TQ/scripts/plugin/hooks.json" "$OUT/hooks/hooks.json"
cp "$TQ/scripts/plugin/teamqa" "$OUT/bin/teamqa"; chmod 755 "$OUT/bin/teamqa"

# 4. Checks.
for skill in qa-code qa-gui team-qa; do
  node "$OUT/skills/$skill/scripts/package-tool.mjs" verify-runtime --root "$OUT/skills/$skill" || { echo "PLUGIN_SKILL_VERIFY_FAILED $skill" >&2; exit 4; }
done
if [ -n "$(find "$OUT" -type l -print -quit)" ]; then echo "PLUGIN_SYMLINK $(find "$OUT" -type l | head -3)" >&2; exit 4; fi
if [ -n "$(find "$OUT" \( -name .DS_Store -o -name Thumbs.db -o -name desktop.ini -o -name __MACOSX \) -print -quit)" ]; then echo "PLUGIN_SYSTEM_FILE" >&2; exit 4; fi
IDS="${TEAMQA_HYGIENE_IDS:-$HOME/.agentpro/hygiene-ids.txt}"
if [ -f "$IDS" ]; then
  if grep -R -i -n -F -f "$IDS" "$OUT/.claude-plugin" "$OUT/README.md" "$OUT/bin" "$OUT/hooks" > "$WORK/ids.txt" 2>/dev/null; then cut -c1-160 "$WORK/ids.txt" >&2; echo "PLUGIN_PERSONAL_ID" >&2; exit 4; fi
fi
if command -v claude > /dev/null 2>&1; then
  claude plugin validate "$OUT" > "$WORK/validate.log" 2>&1 || { cat "$WORK/validate.log" >&2; echo "PLUGIN_VALIDATE_FAILED" >&2; exit 4; }
  grep -E 'Validation' "$WORK/validate.log" || true
else
  echo "note: claude is not on PATH; claude plugin validate was not run"
fi
echo "PLUGIN_BUILT version=$VERSION out=$OUT files=$(find "$OUT" -type f | wc -l | tr -d ' ')"
