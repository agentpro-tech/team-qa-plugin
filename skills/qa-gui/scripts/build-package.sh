#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
OUT="$ROOT/dist"
while [ "$#" -gt 0 ]; do
  case "$1" in --out) OUT="${2:?}"; shift 2;; *) echo "build-package: unknown flag $1" >&2; exit 2;; esac
done
[ -z "$(git -C "$ROOT" status --porcelain --untracked-files=no)" ] || { echo 'build-package: source has uncommitted changes' >&2; exit 20; }
node --test "$ROOT/test/teamqa-attestation.test.mjs" "$ROOT/test/publisher-signature.test.mjs" "$ROOT/test/native-gui-trajectory.test.mjs" "$ROOT/test/native-gui-attestation-guard.test.mjs" "$ROOT/test/claude-stream-web-route.test.mjs" "$ROOT/test/teamwork-board-quality.test.mjs"
npm --prefix "$ROOT" run test:release-truth
printf 'INCIDENT_REPLAY_PASS\n'
npm --prefix "$ROOT" run test:release-c
printf 'RELEASE_C_TRANSITION_CORPUS_PASS\n'
node "$ROOT/scripts/package-tool.mjs" verify --root "$ROOT" --manifest "$ROOT/package-manifest.json"
SKILL="$(node -p "require('$ROOT/package-files.json').skill")"
VERSION="$(tr -d '[:space:]' < "$ROOT/VERSION")"
COMMIT="$(git -C "$ROOT" rev-parse HEAD)"
TREE="$(git -C "$ROOT" rev-parse 'HEAD^{tree}')"
REPO="$(git -C "$ROOT" config --get remote.origin.url)"
STAMP="$(date -u +%Y%m%d-%H%M%S)-$$"
WORK="$OUT/archive/build-work-$SKILL-$STAMP"
RELEASE="$OUT/$SKILL-$VERSION-release"
mkdir -p "$WORK/payload/$SKILL" "$RELEASE"
node "$ROOT/scripts/package-tool.mjs" copy --root "$ROOT" --manifest "$ROOT/package-manifest.json" --dest "$WORK/payload/$SKILL"
cp "$ROOT/package-manifest.json" "$WORK/payload/$SKILL/package-manifest.json"
(cd "$WORK/payload" && /usr/bin/zip -qr "$RELEASE/payload.zip" "$SKILL")
PAYLOAD_SHA="$(shasum -a 256 "$RELEASE/payload.zip" | awk '{print $1}')"
MANIFEST_SHA="$(shasum -a 256 "$ROOT/package-manifest.json" | awk '{print $1}')"
node "$ROOT/scripts/package-tool.mjs" source --out "$RELEASE/SOURCE.json" --skill "$SKILL" --version "$VERSION" --repo "$REPO" --commit "$COMMIT" --tree "$TREE" --manifest-sha "$MANIFEST_SHA" --package-sha "$PAYLOAD_SHA"
cp "$ROOT/scripts/install-package.sh" "$RELEASE/install.sh"
cp "$ROOT/scripts/verify-install.sh" "$RELEASE/verify-install.sh"
chmod +x "$RELEASE/install.sh" "$RELEASE/verify-install.sh"
FINAL="$OUT/$SKILL-$VERSION-release.zip"
(cd "$OUT" && /usr/bin/zip -qr "$FINAL" "$(basename "$RELEASE")")
shasum -a 256 "$FINAL" > "$FINAL.sha256"
printf 'RELEASE_ZIP=%s\nRELEASE_SHA256=%s\n' "$FINAL" "$(awk '{print $1}' "$FINAL.sha256")"
