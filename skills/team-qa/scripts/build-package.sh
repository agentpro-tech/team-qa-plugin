#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
OUT="$ROOT/dist"
LOCAL_CANDIDATE=0
while [ "$#" -gt 0 ]; do case "$1" in --out) OUT="${2:?}"; shift 2;; --local-candidate) LOCAL_CANDIDATE=1; shift;; *) echo "build-package: unknown flag $1" >&2; exit 2;; esac; done
[ -z "$(git -C "$ROOT" status --porcelain --untracked-files=no)" ] || { echo 'build-package: the source has uncommitted tracked changes' >&2; exit 20; }
node "$ROOT/scripts/package-tool.mjs" verify --root "$ROOT" --manifest "$ROOT/package-manifest.json"
node "$ROOT/scripts/package-tool.mjs" hygiene --root "$ROOT"
node --test "$ROOT/test/release-c-escaped-defect-compile.acceptance.mjs"
node --test "$ROOT/test/release-c-escaped-defect-compile.mutation.mjs"
node --test "$ROOT/test/release-c-scroll-agent-contract.acceptance.mjs"
node --test "$ROOT/test/release-c-scroll-agent-contract.mutation.mjs"
printf 'RELEASE_C_ESCAPED_DEFECT_COMPILE=PASS\n'
env -u NODE_TEST_CONTEXT node "$ROOT/test/roster-dynamic.acceptance.mjs"
env -u NODE_TEST_CONTEXT node --test "$ROOT"/test/catalog-status/*.test.mjs "$ROOT"/test/roster-contract/*.test.mjs "$ROOT"/test/roster-hardening/*.test.mjs
env -u NODE_TEST_CONTEXT node "$ROOT/test/roster-contract/run-gates.mutation.mjs"
node --test "$ROOT/test/target-composition.test.mjs"
node "$ROOT/test/target-composition.mutation.mjs"
node --test "$ROOT"/test/chat-preflight/*.test.mjs
node "$ROOT/test/chat-preflight/mutation.mjs"
node --test "$ROOT"/test/native-adapters/*.test.mjs
node --test "$ROOT/test/attempt-history.test.mjs" "$ROOT/test/continuation.test.mjs" "$ROOT/test/continuation-reader.test.mjs" "$ROOT/test/dragon-admission.test.mjs" "$ROOT/test/qa-lifecycle-hook.test.mjs" "$ROOT/test/publication-debt.test.mjs"
node --test "$ROOT/test/qa-board-teamwork.acceptance.test.mjs" "$ROOT/test/board-write-admission.test.mjs" "$ROOT/test/board-write-hook.test.mjs" "$ROOT/test/board-quality-write-request-cli.test.mjs" "$ROOT/test/notion-board-env.test.mjs"
TRUTH_GATE="${TEAMCODE_RELEASE_TRUTH_GATE:-$HOME/.agents/skills/team-code/scripts/release-truth-gate.mjs}"
[ -f "$TRUTH_GATE" ] || { echo "build-package: missing the canonical Team-code release truth gate: $TRUTH_GATE" >&2; exit 20; }
TRUTH_POLICY="$(cd "$(dirname "$TRUTH_GATE")" && pwd -P)/release-policy.mjs"
[ -f "$TRUTH_POLICY" ] || { echo "build-package: missing a dependency of the canonical release truth gate: $TRUTH_POLICY" >&2; exit 20; }
SKILL="$(node -p "require('$ROOT/package-files.json').skill")"
VERSION="$(tr -d '[:space:]' < "$ROOT/VERSION")"
COMMIT="$(git -C "$ROOT" rev-parse HEAD)"
TREE="$(git -C "$ROOT" rev-parse 'HEAD^{tree}')"
REPO="$(git -C "$ROOT" config --get remote.origin.url)"
STAMP="$(date -u +%Y%m%d-%H%M%S)-$$"
WORK="$OUT/archive/build-work-$SKILL-$STAMP"
LABEL="release"; [ "$LOCAL_CANDIDATE" != 1 ] || LABEL="local-candidate"
RELEASE="$OUT/$SKILL-$VERSION-$LABEL"
FINAL="$OUT/$SKILL-$VERSION-$LABEL.zip"
FINAL_SHA="$FINAL.sha256"
mkdir -p "$OUT/archive"
[ ! -e "$RELEASE" ] || mv "$RELEASE" "$OUT/archive/$SKILL-$VERSION-$LABEL-pre-$STAMP"
[ ! -e "$FINAL" ] || mv "$FINAL" "$OUT/archive/$SKILL-$VERSION-$LABEL-pre-$STAMP.zip"
[ ! -e "$FINAL_SHA" ] || mv "$FINAL_SHA" "$OUT/archive/$SKILL-$VERSION-$LABEL-pre-$STAMP.zip.sha256"
mkdir -p "$WORK/payload/$SKILL" "$RELEASE"
if [ "$LOCAL_CANDIDATE" = 1 ]; then
  TRUTH_COMMAND="prove-local"
  node "$TRUTH_GATE" "$TRUTH_COMMAND" --repo "$ROOT" --receipt "$RELEASE/release-truth.json"
else
  node "$TRUTH_GATE" prove --repo "$ROOT" --receipt "$RELEASE/release-truth.json"
fi
node "$ROOT/scripts/package-tool.mjs" copy --root "$ROOT" --manifest "$ROOT/package-manifest.json" --dest "$WORK/payload/$SKILL"
cp "$ROOT/package-manifest.json" "$WORK/payload/$SKILL/package-manifest.json"
(cd "$WORK/payload" && /usr/bin/zip -qr "$RELEASE/payload.zip" "$SKILL")
PAYLOAD_SHA="$(shasum -a 256 "$RELEASE/payload.zip" | awk '{print $1}')"
MANIFEST_SHA="$(shasum -a 256 "$ROOT/package-manifest.json" | awk '{print $1}')"
node "$ROOT/scripts/package-tool.mjs" source --out "$RELEASE/SOURCE.json" --skill "$SKILL" --version "$VERSION" --repo "$REPO" --commit "$COMMIT" --tree "$TREE" --manifest-sha "$MANIFEST_SHA" --package-sha "$PAYLOAD_SHA"
cp "$ROOT/scripts/install-package.sh" "$RELEASE/install.sh"
cp "$ROOT/scripts/verify-install.sh" "$RELEASE/verify-install.sh"
cp "$TRUTH_GATE" "$RELEASE/release-truth-gate.mjs"
cp "$TRUTH_POLICY" "$RELEASE/release-policy.mjs"
chmod +x "$RELEASE/install.sh" "$RELEASE/verify-install.sh" "$RELEASE/release-truth-gate.mjs"
(cd "$OUT" && /usr/bin/zip -qr "$FINAL" "$(basename "$RELEASE")")
(cd "$OUT" && shasum -a 256 "$(basename "$FINAL")" > "$(basename "$FINAL_SHA")")
unzip -t "$FINAL" >/dev/null
printf 'RELEASE_ZIP=%s\nRELEASE_SHA256=%s\n' "$FINAL" "$(awk '{print $1}' "$FINAL_SHA")"
