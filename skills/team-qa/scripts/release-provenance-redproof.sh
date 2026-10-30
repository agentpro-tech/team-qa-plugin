#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
node "$ROOT/test/release/release-provenance.test.mjs" >/dev/null
TMP="$(mktemp -d /tmp/team-qa-release-redproof.XXXXXX)"; MUT="$TMP/team-qa"; mkdir -p "$MUT"
(cd "$ROOT" && /usr/bin/tar --exclude=.git --exclude=dist -cf - .) | (cd "$MUT" && /usr/bin/tar -xf -)
perl -0pi -e 's/node "\$TRUTH_GATE" prove[^\n]+/true # release truth detached/' "$MUT/scripts/build-package.sh"
node "$MUT/scripts/package-tool.mjs" manifest --root "$MUT" --out "$MUT/package-manifest.json" >/dev/null
if node "$MUT/test/release/release-provenance.test.mjs" >/dev/null 2>&1; then echo 'FAIL the mutation that removes release truth from the build survived' >&2; exit 1; fi
echo 'TEAM_QA_RELEASE_REDPROOF_PASS mutation=build-gate-detached'
