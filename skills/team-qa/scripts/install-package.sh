#!/usr/bin/env bash
set -euo pipefail
ENVELOPE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
DEST_ROOT="$HOME/.agents/skills"; COMPAT_ROOT="$HOME"; BACKUP_ROOT=""; ALLOW_LOCAL_CANDIDATE=no; DEST_ROOT_EXPLICIT=0; COMPAT_ROOT_EXPLICIT=0
while [ "$#" -gt 0 ]; do case "$1" in --dest-root) DEST_ROOT="${2:?}"; DEST_ROOT_EXPLICIT=1; shift 2;; --compat-root) COMPAT_ROOT="${2:?}"; COMPAT_ROOT_EXPLICIT=1; shift 2;; --archive-root) BACKUP_ROOT="${2:?}"; shift 2;; --allow-local-candidate) ALLOW_LOCAL_CANDIDATE="${2:?}"; shift 2;; *) echo "install: unknown flag $1" >&2; exit 2;; esac; done
SOURCE="$ENVELOPE/SOURCE.json"; PAYLOAD="$ENVELOPE/payload.zip"; TRUTH="$ENVELOPE/release-truth.json"; TRUTH_GATE="$ENVELOPE/release-truth-gate.mjs"; TRUTH_POLICY="$ENVELOPE/release-policy.mjs"
[ -f "$SOURCE" ] && [ -f "$PAYLOAD" ] && [ -f "$TRUTH" ] && [ -f "$TRUTH_GATE" ] && [ -f "$TRUTH_POLICY" ] || { echo 'install: missing SOURCE/payload/release-truth/verifier dependency' >&2; exit 20; }
case "$ALLOW_LOCAL_CANDIDATE" in yes|no) :;; *) echo 'install: --allow-local-candidate must be yes|no' >&2; exit 2;; esac
if [ "$ALLOW_LOCAL_CANDIDATE" = yes ] && { [ "$DEST_ROOT_EXPLICIT" != 1 ] || [ "$COMPAT_ROOT_EXPLICIT" != 1 ] || [ "$DEST_ROOT" = "$HOME/.agents/skills" ] || [ "$COMPAT_ROOT" = "$HOME" ]; }; then
  echo 'LOCAL_CANDIDATE_REQUIRES_EXPLICIT_COMPAT_ROOT' >&2; exit 24
fi
verify_truth(){ if [ "$ALLOW_LOCAL_CANDIDATE" = yes ]; then node "$1" verify-envelope --receipt "$2" --source "$3" --allow-local-candidate yes; else node "$1" verify-envelope --receipt "$2" --source "$3"; fi; }
verify_truth "$TRUTH_GATE" "$TRUTH" "$SOURCE"
SKILL="$(node -p "JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).skill" "$SOURCE")"
EXPECTED="$(node -p "JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).package_sha256" "$SOURCE")"
ACTUAL="$(shasum -a 256 "$PAYLOAD" | awk '{print $1}')"
[ "$EXPECTED" = "$ACTUAL" ] || { echo 'install: payload SHA mismatch' >&2; exit 21; }
[ -n "$BACKUP_ROOT" ] || BACKUP_ROOT="$DEST_ROOT/.backups"
STAMP="$(date -u +%Y%m%d-%H%M%S)-$$"; STAGE="$DEST_ROOT/.staging/$SKILL-$STAMP"; DEST="$DEST_ROOT/$SKILL"
mkdir -p "$STAGE" "$BACKUP_ROOT" "$DEST_ROOT" "$COMPAT_ROOT/.claude/skills" "$COMPAT_ROOT/.codex/skills"
/usr/bin/unzip -q "$PAYLOAD" -d "$STAGE"
[ -d "$STAGE/$SKILL" ] || { echo 'install: payload is missing the skill root' >&2; exit 22; }
cp "$SOURCE" "$STAGE/$SKILL/SOURCE.json"; cp "$TRUTH" "$STAGE/$SKILL/release-truth.json"; cp "$TRUTH_GATE" "$STAGE/$SKILL/release-truth-gate.mjs"; cp "$TRUTH_POLICY" "$STAGE/$SKILL/release-policy.mjs"
node "$STAGE/$SKILL/scripts/package-tool.mjs" verify-runtime --root "$STAGE/$SKILL" --source "$STAGE/$SKILL/SOURCE.json"
verify_truth "$STAGE/$SKILL/release-truth-gate.mjs" "$STAGE/$SKILL/release-truth.json" "$STAGE/$SKILL/SOURCE.json"
PREVIOUS="-"; CLAUDE_PREVIOUS="-"; CODEX_PREVIOUS="-"
[ ! -e "$DEST" ] && [ ! -L "$DEST" ] || { PREVIOUS="$BACKUP_ROOT/$SKILL-pre-$STAMP"; mv "$DEST" "$PREVIOUS"; }
mv "$STAGE/$SKILL" "$DEST"
rollback() {
  local failed="$BACKUP_ROOT/$SKILL-failed-$STAMP" link previous label
  for label in claude codex; do
    if [ "$label" = claude ]; then link="$COMPAT_ROOT/.claude/skills/$SKILL"; previous="$CLAUDE_PREVIOUS"; else link="$COMPAT_ROOT/.codex/skills/$SKILL"; previous="$CODEX_PREVIOUS"; fi
    [ ! -e "$link" ] && [ ! -L "$link" ] || mv "$link" "$BACKUP_ROOT/$SKILL-failed-$label-$STAMP"
    [ "$previous" = "-" ] || mv "$previous" "$link"
  done
  [ ! -e "$DEST" ] && [ ! -L "$DEST" ] || mv "$DEST" "$failed"
  [ "$PREVIOUS" = "-" ] || mv "$PREVIOUS" "$DEST"
  echo "install: post-check failed; rolled back, the failed copy is in $failed" >&2; exit 23
}
for scope in "$COMPAT_ROOT/.claude/skills" "$COMPAT_ROOT/.codex/skills"; do
  link="$scope/$SKILL"; [ -L "$link" ] && [ "$(realpath "$link" 2>/dev/null || true)" = "$(realpath "$DEST")" ] && continue
  label="$(basename "$(dirname "$scope")")"
  if [ -e "$link" ] || [ -L "$link" ]; then compat="$BACKUP_ROOT/${SKILL}-compat-$label-$STAMP"; mv "$link" "$compat" || rollback; [ "$label" = .claude ] && CLAUDE_PREVIOUS="$compat" || CODEX_PREVIOUS="$compat"; fi
  ln -s "$DEST" "$link" || rollback
done
bash "$DEST/scripts/verify-install.sh" "$DEST" "$COMPAT_ROOT" || rollback
printf 'INSTALL_PASS skill=%s dest=%s backup=%s\n' "$SKILL" "$DEST" "$PREVIOUS"
