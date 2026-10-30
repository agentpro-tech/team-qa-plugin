#!/usr/bin/env bash
# Owner tool (BA public v1, R1/R2): build QA Code, QA GUI and Team QA in a neutral folder and sign them into one suite.
# Each skill is cloned from GitHub into $TEAMQA_RELEASE_WORKDIR (default /tmp/agentpro-release), so the release-truth
# receipts name that folder instead of a home path, and SOURCE.json names the GitHub repo. An official build takes
# GitHub main as it is; --local-candidate fetches the given branch from the owner's local repo on top of it.
#   release-suite.sh --out <dir> [--local-candidate] [--no-license] [--changelog <text|file>] [--upgrade-from <x.y.z>] [--dragon-runtime <dbrc>] [--truth-gate <release-truth-gate.mjs>]
#                    [--qa-code <repo> --qa-code-ref <branch>] [--qa-gui <repo> --qa-gui-ref <branch>] [--team-qa <repo> --team-qa-ref <branch>]
# --truth-gate picks the Team Code release truth gate the builds copy into each envelope (default: the installed one).
set -euo pipefail
# The organization that holds the skill repositories (scripts/lib/source-repo.mjs says the same).
SOURCE_OWNER=agentpro-tech
OUT=""; LOCAL=0; EXTRA=(); WORKDIR="${TEAMQA_RELEASE_WORKDIR:-/tmp/agentpro-release}"
QA_CODE="$HOME/Dev/qa-code"; QA_CODE_REF=main; QA_GUI="$HOME/Dev/qa-gui"; QA_GUI_REF=main; TEAM_QA="$HOME/Dev/team-qa"; TEAM_QA_REF=main
while [ "$#" -gt 0 ]; do case "$1" in
  --out) OUT="${2:?}"; shift 2;; --local-candidate) LOCAL=1; shift;; --no-license) EXTRA+=(--no-license); shift;; --changelog) EXTRA+=(--changelog "${2:?}"); shift 2;; --upgrade-from) EXTRA+=(--upgrade-from "${2:?}"); shift 2;; --dragon-runtime) EXTRA+=(--dragon-runtime "${2:?}"); shift 2;; --truth-gate) export TEAMCODE_RELEASE_TRUTH_GATE="$(cd "$(dirname "${2:?}")" && pwd -P)/$(basename "$2")"; shift 2;;
  --qa-code) QA_CODE="${2:?}"; shift 2;; --qa-code-ref) QA_CODE_REF="${2:?}"; shift 2;;
  --qa-gui) QA_GUI="${2:?}"; shift 2;; --qa-gui-ref) QA_GUI_REF="${2:?}"; shift 2;;
  --team-qa) TEAM_QA="${2:?}"; shift 2;; --team-qa-ref) TEAM_QA_REF="${2:?}"; shift 2;;
  *) echo "release-suite: unknown flag $1" >&2; exit 2;; esac; done
[ -n "$OUT" ] || { echo 'release-suite: --out <dir> is required' >&2; exit 2; }
mkdir -p "$OUT/envelopes" "$WORKDIR"
OUT="$(cd "$OUT" && pwd -P)"
prepare() { # skill local-repo ref
  local skill="$1" repo="$2" ref="$3" w="$WORKDIR/$1"
  [ -d "$w/.git" ] || git clone --quiet "https://github.com/$SOURCE_OWNER/$skill.git" "$w"
  git -C "$w" remote set-url origin "https://github.com/$SOURCE_OWNER/$skill.git"
  [ -z "$(git -C "$w" status --porcelain --untracked-files=no)" ] || { echo "release-suite: $w has local changes; it is a build folder, not a work folder" >&2; exit 20; }
  git -C "$w" fetch --quiet origin
  if [ "$LOCAL" = 1 ]; then
    git -C "$w" fetch --quiet "$repo" "$ref"
    git -C "$w" checkout --quiet -B agentpro-release-candidate FETCH_HEAD
  else
    git -C "$w" checkout --quiet main && git -C "$w" merge --quiet --ff-only origin/main
    [ "$(git -C "$w" rev-parse HEAD)" = "$(git -C "$w" rev-parse origin/main)" ] || { echo "release-suite: $skill main is not GitHub main" >&2; exit 20; }
  fi
  printf 'PREPARED skill=%s head=%s dir=%s\n' "$skill" "$(git -C "$w" rev-parse --short HEAD)" "$w"
}
build() { # skill
  local w="$WORKDIR/$1" flags=(--out "$OUT/envelopes")
  if [ "$1" = team-qa ] && [ "$LOCAL" = 1 ]; then flags+=(--local-candidate); fi
  # Each build runs from its own root: some suites resolve their scripts relative to the working directory.
  (cd "$w" && bash scripts/build-package.sh "${flags[@]}") > "$OUT/build-$1.log" 2>&1 || { tail -n 20 "$OUT/build-$1.log" >&2; echo "release-suite: $1 build failed (log $OUT/build-$1.log)" >&2; exit 20; }
  tail -n 2 "$OUT/build-$1.log"
}
prepare qa-code "$QA_CODE" "$QA_CODE_REF"; prepare qa-gui "$QA_GUI" "$QA_GUI_REF"; prepare team-qa "$TEAM_QA" "$TEAM_QA_REF"
for skill in qa-code qa-gui team-qa; do build "$skill"; done
zip_of() { local v; v="$(tr -d '[:space:]' < "$WORKDIR/$1/VERSION")"; ls -1t "$OUT/envelopes/$1-$v-"*.zip | head -1; }
node "$WORKDIR/team-qa/scripts/teamqa.mjs" suite build --release "$(zip_of qa-code)" --release "$(zip_of qa-gui)" --release "$(zip_of team-qa)" --out "$OUT/suite" ${EXTRA[@]+"${EXTRA[@]}"}
node "$WORKDIR/team-qa/scripts/teamqa.mjs" suite verify --dir "$OUT/suite"
