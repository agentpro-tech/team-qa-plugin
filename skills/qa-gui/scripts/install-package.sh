#!/usr/bin/env bash
set -euo pipefail
# The real path of a folder, a link to one followed, without the realpath command (macOS 12 and older have none);
# empty when it cannot be resolved, and an empty result never matches.
real_dir() { (CDPATH= cd -P -- "$1" 2>/dev/null && pwd -P) || true; }
ENVELOPE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
DEST_ROOT="$HOME/.agents/skills"
COMPAT_ROOT="$HOME"
BACKUP_ROOT=""
RECORD=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --dest-root) DEST_ROOT="${2:?}"; shift 2;;
    --compat-root) COMPAT_ROOT="${2:?}"; shift 2;;
    --archive-root) BACKUP_ROOT="${2:?}"; shift 2;;
    --record) RECORD="${2:?}"; shift 2;;
    *) echo "install: unknown flag $1" >&2; exit 2;;
  esac
done
SOURCE="$ENVELOPE/SOURCE.json"
PAYLOAD="$ENVELOPE/payload.zip"
[ -f "$SOURCE" ] && [ -f "$PAYLOAD" ] || { echo 'install: missing SOURCE.json or payload.zip' >&2; exit 20; }
SKILL="$(node -p "JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).skill" "$SOURCE")"
EXPECTED="$(node -p "JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).package_sha256" "$SOURCE")"
ACTUAL="$(shasum -a 256 "$PAYLOAD" | awk '{print $1}')"
[ "$EXPECTED" = "$ACTUAL" ] || { echo 'install: payload SHA mismatch' >&2; exit 21; }
[ -n "$BACKUP_ROOT" ] || BACKUP_ROOT="$DEST_ROOT/.backups"
STAMP="$(date -u +%Y%m%d-%H%M%S)-$$"
STAGE="$DEST_ROOT/.staging/$SKILL-$STAMP"
DEST="$DEST_ROOT/$SKILL"
mkdir -p "$STAGE" "$BACKUP_ROOT" "$DEST_ROOT" "$COMPAT_ROOT/.claude/skills" "$COMPAT_ROOT/.codex/skills"
/usr/bin/unzip -q "$PAYLOAD" -d "$STAGE"
[ -d "$STAGE/$SKILL" ] || { echo 'install: payload is missing the skill folder' >&2; exit 22; }
cp "$SOURCE" "$STAGE/$SKILL/SOURCE.json"
node "$STAGE/$SKILL/scripts/package-tool.mjs" verify-runtime --root "$STAGE/$SKILL" --source "$STAGE/$SKILL/SOURCE.json"
PREVIOUS="-"
CLAUDE_PREVIOUS="-"
CODEX_PREVIOUS="-"
if [ -e "$DEST" ] || [ -L "$DEST" ]; then
  PREVIOUS="$BACKUP_ROOT/$SKILL-pre-$STAMP"
  mv "$DEST" "$PREVIOUS"
fi
mv "$STAGE/$SKILL" "$DEST"
rollback() {
  local failed="$BACKUP_ROOT/$SKILL-failed-$STAMP" link previous label
  for label in claude codex; do
    if [ "$label" = claude ]; then link="$COMPAT_ROOT/.claude/skills/$SKILL"; previous="$CLAUDE_PREVIOUS"; else link="$COMPAT_ROOT/.codex/skills/$SKILL"; previous="$CODEX_PREVIOUS"; fi
    if [ -e "$link" ] || [ -L "$link" ]; then mv "$link" "$BACKUP_ROOT/$SKILL-failed-$label-$STAMP"; fi
    if [ "$previous" != "-" ] && [ -e "$previous" ]; then mv "$previous" "$link"; fi
  done
  [ ! -e "$DEST" ] && [ ! -L "$DEST" ] || mv "$DEST" "$failed"
  [ "$PREVIOUS" = "-" ] || mv "$PREVIOUS" "$DEST"
  echo "install: post-check failed; rolled back, the failed copy is at $failed" >&2
  exit 23
}
for scope in "$COMPAT_ROOT/.claude/skills" "$COMPAT_ROOT/.codex/skills"; do
  link="$scope/$SKILL"
  if [ -L "$link" ] && [ -n "$(real_dir "$DEST")" ] && [ "$(real_dir "$link")" = "$(real_dir "$DEST")" ]; then
    continue
  fi
  label="$(basename "$(dirname "$scope")")"
  if [ -e "$link" ] || [ -L "$link" ]; then
    compat="$BACKUP_ROOT/${SKILL}-compat-$label-$STAMP"
    mv "$link" "$compat" || rollback
    if [ "$label" = .claude ]; then CLAUDE_PREVIOUS="$compat"; else CODEX_PREVIOUS="$compat"; fi
  fi
  ln -s "$DEST" "$link" || rollback
done
node "$DEST/scripts/package-tool.mjs" verify-runtime --root "$DEST" --source "$DEST/SOURCE.json" || rollback
[ -z "$RECORD" ] || printf '%s\t%s\t%s\t%s\t%s\n' "$SKILL" "$DEST" "$PREVIOUS" "$CLAUDE_PREVIOUS" "$CODEX_PREVIOUS" >> "$RECORD"
printf 'INSTALL_PASS skill=%s dest=%s backup=%s\n' "$SKILL" "$DEST" "$PREVIOUS"
