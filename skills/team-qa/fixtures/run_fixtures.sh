#!/usr/bin/env bash
set -euo pipefail

FIXTURE_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NODE_BIN="${TEAMQA_NODE:-$(command -v node)}"
NODE_MAJOR="$($NODE_BIN -p 'process.versions.node.split(".")[0]')"
if [[ "$NODE_MAJOR" != "24" && "$NODE_MAJOR" != "26" ]]; then
  echo "verdict=ungraded NODE_VERSION_UNSUPPORTED $NODE_MAJOR" >&2
  exit 5
fi
export PATH="$(dirname "$NODE_BIN"):$PATH"

RUN_DIR="$(mktemp -d "${TMPDIR:-/tmp}/teamqa-fixtures.XXXXXX")"
trap 'if [[ -n "${RUN_DIR:-}" && "$RUN_DIR" == "${TMPDIR:-/tmp}/teamqa-fixtures."* ]]; then ARCHIVE_DIR="${TMPDIR:-/tmp}/teamqa-fixtures-archive"; mkdir -p -- "$ARCHIVE_DIR"; mv -- "$RUN_DIR" "$ARCHIVE_DIR/"; printf "FIXTURE_ARCHIVE=%s\n" "$ARCHIVE_DIR/${RUN_DIR##*/}"; fi' EXIT

expect_exit() {
  local expected="$1"
  shift
  set +e
  local output
  output="$("$@" 2>&1)"
  local actual="$?"
  set -e
  if [[ "$actual" != "$expected" ]]; then
    echo "$output" >&2
    echo "verdict=fail FIXTURE_EXIT expected=$expected actual=$actual" >&2
    exit 1
  fi
  printf '%s\n' "$output"
}

cp -R "$FIXTURE_ROOT/fixtures/data/." "$RUN_DIR/"
cp "$FIXTURE_ROOT/contracts/release-truth-contract/v2/qa-gui.receipt.schema.json" "$RUN_DIR/skill-schemas/qa-gui-receipt-v2.json"
cp "$FIXTURE_ROOT/contracts/release-truth-contract/v2/qa-code.receipt.schema.json" "$RUN_DIR/skill-schemas/qa-code-receipt-v2.json"
mkdir -p "$RUN_DIR/fixtures"
cp -R "$FIXTURE_ROOT/fixtures/support" "$RUN_DIR/fixtures/support"
cp "$RUN_DIR/roles.fixture.json" "$RUN_DIR/roles.json"
cp "$RUN_DIR/roles-check.fixture.json" "$RUN_DIR/roles-check.json"
mkdir -p "$RUN_DIR/runs/fixture-run"
cp "$RUN_DIR/test-plan.md" "$RUN_DIR/runs/fixture-run/test-plan.md"
cp "$RUN_DIR/tracked-plan.json" "$RUN_DIR/runs/fixture-run/tracked-plan.json"
cp "$RUN_DIR/board.jsonl" "$RUN_DIR/runs/fixture-run/board.jsonl"
cp -R "$RUN_DIR/evidence" "$RUN_DIR/runs/fixture-run/evidence"

cd "$RUN_DIR"
TEAMQA_ROLES="$RUN_DIR/roles-check.json" "$NODE_BIN" "$FIXTURE_ROOT/scripts/teamqa.mjs" roles check >/dev/null
echo "G1=PASS"

"$NODE_BIN" "$FIXTURE_ROOT/scripts/teamqa.mjs" plan validate test-plan.md >/dev/null
expect_exit 2 "$NODE_BIN" "$FIXTURE_ROOT/scripts/teamqa.mjs" plan validate invalid-plan.md | grep -q 'PLAN_MISSING_FIELD'
echo "G2=PASS"

expect_exit 3 "$NODE_BIN" "$FIXTURE_ROOT/scripts/teamqa.mjs" gate status --run fixture-run --plan runs/fixture-run/test-plan.md | grep -q 'GATE_UNSIGNED'
"$NODE_BIN" "$FIXTURE_ROOT/scripts/teamqa.mjs" gate publish --run fixture-run --plan runs/fixture-run/test-plan.md | grep -q 'mirror=doc-colab'
"$NODE_BIN" "$FIXTURE_ROOT/scripts/teamqa.mjs" gate approve --run fixture-run --plan runs/fixture-run/test-plan.md --signed-by owner >/dev/null
"$NODE_BIN" "$FIXTURE_ROOT/scripts/teamqa.mjs" gate status --run fixture-run --plan runs/fixture-run/test-plan.md >/dev/null
echo "G3=PASS"

"$NODE_BIN" "$FIXTURE_ROOT/scripts/teamqa.mjs" design validate --file runs/fixture-run/tracked-plan.json >/dev/null
"$NODE_BIN" "$FIXTURE_ROOT/scripts/teamqa.mjs" rtm build --plan runs/fixture-run/test-plan.md --tracked runs/fixture-run/tracked-plan.json --out runs/fixture-run/rtm.md >/dev/null
echo "G4=PASS"

"$NODE_BIN" "$FIXTURE_ROOT/scripts/teamqa.mjs" board verify --file runs/fixture-run/board.jsonl >/dev/null
"$NODE_BIN" "$FIXTURE_ROOT/scripts/teamqa.mjs" board add --file board-add.jsonl --record record.json >/dev/null
expect_exit 1 "$NODE_BIN" "$FIXTURE_ROOT/scripts/teamqa.mjs" board add --file board-no-proof.jsonl --record record-no-evidence.json | grep -q 'verdict=ungraded'
"$NODE_BIN" "$FIXTURE_ROOT/scripts/teamqa.mjs" smoke >/dev/null
cp skill-schemas/qa-code-v2.json skill-schemas/qa-code.json
expect_exit 4 "$NODE_BIN" "$FIXTURE_ROOT/scripts/teamqa.mjs" smoke | grep -q 'SCHEMA_MAJOR_MISMATCH'
echo "G5=PASS"

cp "$FIXTURE_ROOT/fixtures/data/skill-schemas/qa-code.json" skill-schemas/qa-code.json
cp board-no-go.jsonl runs/fixture-run/board.jsonl
"$NODE_BIN" "$FIXTURE_ROOT/scripts/teamqa.mjs" rtm fill --rtm runs/fixture-run/rtm.md --board runs/fixture-run/board.jsonl --out runs/fixture-run/rtm.md >/dev/null
expect_exit 1 "$NODE_BIN" "$FIXTURE_ROOT/scripts/teamqa.mjs" report build --run fixture-run | grep -q 'coverage_low_pct 0 < 70'
cp board.jsonl runs/fixture-run/board.jsonl
"$NODE_BIN" "$FIXTURE_ROOT/scripts/teamqa.mjs" rtm fill --rtm runs/fixture-run/rtm.md --board runs/fixture-run/board.jsonl --out runs/fixture-run/rtm.md >/dev/null
"$NODE_BIN" "$FIXTURE_ROOT/scripts/teamqa.mjs" report build --run fixture-run >/dev/null
"$NODE_BIN" "$FIXTURE_ROOT/scripts/teamqa.mjs" report verify --run fixture-run >/dev/null
"$NODE_BIN" "$FIXTURE_ROOT/scripts/teamqa.mjs" report publish --run fixture-run | grep -q 'effect=confirmed'
echo "G6=PASS"

test -f "$FIXTURE_ROOT/SKILL.md"
test -f "$FIXTURE_ROOT/agents/openai.yaml"
for agent in test-manager analyst designer executor-gui executor-code coverage-gate; do
  test -f "$FIXTURE_ROOT/agents/$agent/IDENTITY.md"
  test -f "$FIXTURE_ROOT/agents/$agent/SOUL.md"
done
if grep -q '\[TODO' "$FIXTURE_ROOT/SKILL.md"; then
  echo "verdict=fail G7_SKILL_TODO" >&2
  exit 1
fi
echo "G7=PASS"
echo "verdict=pass TEAM_QA_FIXTURES=PASS node=$($NODE_BIN --version)"
