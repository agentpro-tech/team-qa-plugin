---
name: qa-code
description: >-
  Grades CODE with machines first and an LLM second. Give it a diff or a repo: four machine layers
  (secret · SAST · CVE · coverage) block cheap defects first, then an LLM from a DIFFERENT VENDOR
  than the coder grades the rest against the A/B/C/D rule table and returns a machine-readable
  verdict with a TRUST GRADE (PASS · PASS-STATIC · FAIL · UNGRADED). Use when the user says
  "QA code", "review this code", "grade this diff", "find bugs before merge", "check code
  security", or when a code verdict with file:line evidence is needed instead of a paragraph of
  praise and criticism. Works STANDALONE, no pipeline needed. In team-code it is phase ④a.
  DIFFERENT from qa-gui (grades the USER INTERFACE in a real browser) — this skill grades CODE.
  DIFFERENT from asking Grok/Sonnet for a bare review: here machines run first, the verdict has a
  schema, and a mode that cannot run tools is capped at PASS-STATIC.
---

# QA Code — machines block first, an LLM grades second, the verdict has a grade

> **In one sentence:** whatever a machine can measure, do not let an LLM judge it; for the rest,
> make the LLM give an address, and record clearly whether it actually ran anything or only read.

The measurement that opens this whole design, same model Opus 4.6, same repo: the class **that can
run the runtime** caught **66 real defects**; the class **that only reads statically** caught **41 real
defects plus 24 false positives**. The whole defect group **auth · authorization · business logic** was
seen only by the class that really ran. So a verdict must declare which class it belongs to — mixing
the two under the same word "PASS" is lying.

---

## Definition of done — check all of it before handing over a verdict

1. Lock `TASK_BASE` as an immutable SHA when the task is received; Gate 0 runs the cumulative diff
   `TASK_BASE → the exact commit` being graded and writes both SHAs to `gate0.json`.
2. Gate 0 red ⇒ **do not call the LLM**, return straight to the coder (L1). No verdict exists on this branch.
3. The verdict passes `verdict-validate.mjs` with **exit 0**. The validator has no off switch and no
   fail-open. A grade it cannot compute is `UNGRADED`, and **UNGRADED is not PASS**.
4. The security sweep **S1–S5 declares all 5 items**. One missing item rejects the whole verdict.
5. Every finding of severity **A and B has `file:line` + evidence**. Missing it rejects the whole verdict,
   not just that finding.
6. After QA, run `git diff --quiet` — QA touching the code it is grading is **tampering**, and the verdict is cancelled.
7. For agent-written code, the receipt must be enough to check the environment, test stability, requirement trace,
   prompt surface, threat model, product-path security, CVE reachability, trajectory and finding
   anchors. Any part without evidence stays `UNGRADED` and is not inferred as PASS.
8. `PASS` for auth/permission/migration needs `qa-code/runtime-receipt/v1`: the legacy identifier audit,
   migration ledger, permission and RLS readback must match expected/actual on the exact commit/base.
9. Standalone keeps `qa-code/receipt/v1`; a run with a locked graph issues `qa-code/receipt/v2`, which binds the contract,
   the real repo, TASK_BASE, source revision, HEAD, requirements hash and atomic evidence to the same `run_uuid`.
10. Mode `tools` may PASS only when the tool-log is read by a machine from the provider trajectory; an empty tool-log is
    `UNGRADED`. `--engine-cmd` is always stamped `engine_injected=true`.
11. An escaped defect must go through `gate-wiring-detector.mjs`: affected layer, fixture, positive test,
    mutation test, release gate and closure evidence all bind SHA-256; one missing wire keeps FAIL.
12. A Vitest/Deno repo declares `test_runners` explicitly; native coverage, stability and acceptance run
    with the same runtime/config, keeping a minimum threshold of 80. See `references/native-test-runners.md`.
13. A scanner finding may be adjudicated only through an exact independent post-review proof; the raw report and
    the scanner FAIL stay unchanged, and the reader rechecks the source/report/proof. See `references/secret-adjudication-v1.md`.

---

# Part I — Five hard rules

## ⛔ HR1 — Machines first, LLM second

When Gate 0 is red, **do not call the QA LLM**. The reason is not saving money: an LLM reading code with a
broken build will hunt for bugs at the wrong layer and produce a noisy list that someone has to read.

## ⛔ HR2 — The LLM does not grade severity D

Naming, style and format are the linter's job. When a severity-D finding slips into the verdict, the validator **drops it
and logs it** — the rest of the verdict survives. Letting an LLM grade D means paying for reasoning on work that
a regex does better, and it takes the place of real bugs in the list.

## ⛔ HR3 — An independent eye, from a different vendor than the coder

Standalone and Team-code: QA must come from a different vendor than the one who wrote the code.
Team QA has a `same-provider review` exception when the roster approval/provenance is valid,
the reviewer has an agent/session runtime different from the coder's, the pre/post binding has been checked and permissions are read-only.
Without proof, HR3 keeps blocking. Details: `references/teamqa-provider-routes.md`.

Independent QA by default must come from a different vendor than the code's author. The same vendor means the same blind spots, and agreement between two
models from the same house only amplifies shared errors; it confirms nothing. Do not build a council of several
models from the same vendor. Do not let a third LLM mediate disagreements — merge by machine, and the human reader decides.

## ⛔ HR4 — A spotless fixture is a lying fixture

Three times while building this skill, the same disease, in a different place each time:

| Time | Where the fixture was tidy | What it hid |
|---|---|---|
| P1 | the CVE layer used a stub that exits **0** | the REAL `osv-scanner` exits **1** when it finds a vulnerability ⇒ the CVE layer returned `UNGRADED` instead of `FAIL`. The CVE gate had never turned red correctly on real tooling, yet all seven yardstick cases stayed green. |
| P1 | the "clean" fixture pinned `lodash@4.17.21` | That version has a **HIGH** advisory GHSA-r5fr-rjxr-66jc (fixed in 4.18.0). Gate 0 reporting red was RIGHT — the yardstick was wrong. |
| P3 | the fixture was a **spotless** repo | `tampering()` compared against "absolutely clean" instead of BEFORE-versus-AFTER. In team-code phase ④ the worktree is always dirty ⇒ every real QA run came out `UNGRADED`. |

All three slipped through the yardstick and all three were caught by an **independent eye from a different vendor**, not by adding test cases.

The rule drawn from this, applied to every gate of this skill:

1. **Every stub must come with at least one case that runs the REAL binary/engine.** It may `skip` when the machine lacks
   the binary, but it may not be absent.
2. **Every "pretty state" fixture must come with a "real-life state" fixture.** A clean repo needs
   a dirty repo. A well-formed verdict needs a malformed verdict. A happy path needs a
   sad path.
3. **Ask before freezing the yardstick:** *what does this look like when it really runs?* If the answer differs from the
   fixture, the fixture is not done.

A stub's blind spot is always **exactly its own size**. It is no bigger, but it is
never smaller either.

## ⛔ HR5 — QA writes no files

To add a test, write it into `proposed_tests[]`; the orchestrator decides whether it goes into acceptance or
to the coder. A coder who writes tests and then grades them will hardcode or delete assertions to pass — this has been
measured. QA editing the files it grades is the same disease, just in a different seat.

---

# Part II — The rule table: what a finding is

| Severity | Defect group | Handling |
|---|---|---|
| **A** | wrong result against acceptance · serious security hole · wrong authorization | P0, **blocks merge** |
| **B** | swallowed error on the main flow · resource leak · a test that exists but checks nothing | P1, must be fixed before handover |
| **C** | hard-to-maintain code · duplication · function too long | recorded, does not block |
| **D** | naming · style · format | **the linter's job — the LLM does not grade it** (HR2) |

Each finding also declares a `defect_type` from IBM's eight ODC types: `assignment` · `checking` ·
`algorithm` · `timing` · `interface` · `function` · `build` · `documentation`. This is not
paperwork: it is the only way to read later **where the system tends to break**, instead of counting
the total number of bugs and learning nothing.

**Groups a statically reading LLM often misses — `static` mode sends them to `concerns` by default and does not count them as FAIL:**
role-based authorization · multi-step stateful flows · race conditions.

## Security sweep — declare all 5, no skimming

| Code | What to check |
|---|---|
| **S1** | Is external input validated before it goes into queries, commands, paths |
| **S2** | Does every touched endpoint or function check the right role and the right data owner (IDOR) |
| **S3** | Secrets and tokens are not hardcoded and do not leak into logs |
| **S4** | Errors returned outside do not expose stack traces or system details |
| **S5** | Passwords, tokens and sensitive data are not exposed in plain form in responses or logs |

Each item declares one of three values: `PASS` · `DEFECT` · `NOT_APPLICABLE`. An item declared `DEFECT` **must have an
accompanying finding of at least severity B (A or B)**. In `static` mode, an S2 suspicion without enough evidence goes to `concerns` —
but it **must still be declared**; leaving it blank is forbidden.

---

# Part III — Verdict grades, and why there are four

```
PASS  >  PASS-STATIC  >  FAIL  >  UNGRADED
```

| Grade | Meaning |
|---|---|
| `PASS` | QA **could run tools**, ran tests, and no severity A or B finding remains |
| `PASS-STATIC` | QA **could only read**, could not run anything. The ceiling of `static` mode — **there is no path to `PASS`** |
| `FAIL` | a severity A or B finding remains |
| `UNGRADED` | the engine died, timed out, returned broken JSON, or no check actually ran. **Treat as FAIL, fail-closed** |

**`PASS-STATIC` may be accepted only when Gate 0 is green on that exact commit and the diff does not touch a
high-risk area.** Auth/payment/permission/migration/secret require a tool/runtime product path;
a static review has no authority to close the task. If any one of these conditions is missing, reject the verdict.
Reason: static mode is blind to exactly the most
dangerous defect group, so what machines can measure must make up for it, and it must do so on **the same commit**,
not on some roughly matching commit.

---

# Part IV — Nine operating rules

| Code | Rule |
|---|---|
| **L1** | Machines first, LLM second. Gate 0 red ⇒ do not call the LLM, return straight to the coder. |
| **L2** | The LLM does not grade severity D. A D finding that slips in is dropped by the validator. |
| **L3** | `PASS` > `PASS-STATIC` > `FAIL` > `UNGRADED`. A mode that cannot run tools has a `PASS-STATIC` ceiling. |
| **L4** | `PASS-STATIC` is accepted only when Gate 0 is green on **that exact commit**, and it may not be used to close a high-risk diff. |
| **L5** | QA writes no files. To add a test ⇒ `proposed_tests[]`. After QA, still run `git diff` to catch tampering. |
| **L6** | A severity-A finding requires `file:line` + evidence. Missing ⇒ **reject the whole verdict**, not just that finding. |
| **L7** | Mutation does not run in the fix loop. A surviving mutant on acceptance is the spec writer's job (a missing assertion), not the coder's. |
| **L8** | Keep the three things that were already right: QA from a different vendor than the coder · merge findings **by machine**, never let an LLM mediate · spec + acceptance are the only yardstick. The QA prompt stays in the form **rule table + JSON**; stuffing in long reasoning chains is forbidden — it has been measured: the more convoluted the prompt, the more wrong the judgments. |
| **L9** | Lock `TASK_BASE` at intake and grade the whole diff `TASK_BASE → final`. A diff that touches **auth · payment · permission · migration · secret** ⇒ at least 1 product-path acceptance that really runs; the validator requires `--base`, `--task-base` and `gate0.base` to resolve to the same SHA. |

---

# Part V — Failure cases

| Code | Case | Handling |
|---|---|---|
| **H1** | The QA engine dies midway or times out | verdict = `UNGRADED`. **Silence is forbidden, counting it as PASS is forbidden.** |
| **H2** | The verdict JSON is broken or missing a required field | validator red, **rerun exactly 1 time**. Still broken ⇒ `UNGRADED`, report to the orchestrator. |
| **H3** | semgrep or the CVE scan produces false positives en masse | block only high-confidence findings; for a noisy rule, **exclude exactly that rule** + log it. **Turning off the whole layer is forbidden.** |
| **H4** | QA edits a file it is grading | `git diff` catches it ⇒ cancel the verdict, treat it as tampering. |
| **H5** | Mutation runs longer than 30 minutes | narrow to incremental + core modules. Still too long ⇒ cut the scope and **state clearly what was not scanned**. |
| **H6** | Both Grok and Sonnet are down | the main session grades by itself, but the verdict **ceiling is only `PASS-STATIC`** — there is no longer an independent eye that runs tools. |

---

# Part VI — How to run

## Agentic QA opt-in — the 10 capabilities of v1.1

Gate 0 always records the runtime/toolchain receipt and timing; policies that add cost or need repo
artifacts are enabled only when declared in the config. A full example:

```json
{
  "receipts": { "required": ["gitleaks", "semgrep", "osv-scanner", "node"] },
  "timeouts": {
    "layers": { "secret": 300000, "sast": 900000, "cve": 300000, "coverage": 1800000 },
    "total": 2400000
  },
  "stability": { "runs": 3 },
  "acceptance": {
    "requirements": [{
      "id": "REQ-001",
      "fail_to_pass": ["test/feature.test.mjs"],
      "pass_to_pass": ["test/regression.test.mjs"]
    }]
  },
  "threat_model": { "path": "security/threat-model.json" },
  "security_product_path": { "tests": ["test/security-product-path.test.mjs"] },
  "cve": { "reachability": { "blocking": "called" } }
}
```

- `timeouts` returns `UNGRADED`/20 when a checker hangs and records both the `duration_ms` of each layer and
  the `total_duration_ms` of the run.
- `stability.runs` accepts 2–5; inconsistent outcomes may not PASS.
- `acceptance.requirements` requires unique IDs and both classes fail-to-pass/pass-to-pass.
  Gate 0 runs the same fail-to-pass tests on TASK_BASE (must be red) and HEAD (must be green), and
  runs pass-to-pass on both commits; an empty test cannot raise coverage.
- Only for a “keep unchanged/add nothing/no rewrite” invariant in graph v2 may
  `mode:"preservation"` + `preservation[]` + `pass_to_pass[]` be used, if and only if the frozen
  `evidence_contract.allowed_types` contains `diff-proof`. Both classes must be green on TASK_BASE and HEAD;
  Gate 0 rejects this mode for feature requirements so that a missing RED does not turn into PASS.
- New lines in Markdown/config meant for agents are scanned for hidden Unicode, instruction hijack and
  secret exfiltration; a finding always has `file:line`.
- A diff that touches auth/payment/permission/migration/secret must have a threat-model JSON with all four sections
  `entry_points`, `trust_boundaries`, `sensitive_assets`, `high_impact_sinks` and a product-path test
  that really runs with the pinned Node.
- `cve.reachability.blocking="called"` only changes the blocking authority; findings with `called=false|"unknown"` still
  stay in the evidence. Leaving this config out keeps the old `any` policy.

## Release Truth v2 — runs with a locked requirement graph

Contract v2 lives at `contracts/release-truth-contract/v2` and has SHA-256
`77433f4c204e7f32848976b585cfb901152f97b775726467a0a5128eb3ec362c`. When
`--requirements` is passed, Gate 0 must read the `requirements.freeze/v2` graph together with the `LOCK.json` next to it:

- the denominator is every requirement in lane `code|multi`, never taken from the config;
- each mapping uses `requirement_id`, `assertion_id`, `fail_to_pass`, `pass_to_pass`;
- a preservation mapping uses `requirement_id`, `assertion_id`, `mode:"preservation"`,
  `preservation`, `pass_to_pass` and is valid only when the graph allows `diff-proof`;
- the config may only raise the threshold; it may not change base/source/lane or pick its own subset;
- a v2 receipt is valid only when the verifier rereads the exact graph/LOCK, the current repo and the evidence bytes;
- `RECEIPT_STALE`, tampering, a skip without a reason and a missing atomic row are all fail-closed.

Schema details and the verify command: `references/release-receipt-v2.md`. A v1 receipt can still be read in
legacy mode but returns `CAPABILITY_MISSING:release-truth-v2` and does not close customer-ready v2.

Audit a JSONL trajectory independently of Gate 0:

```bash
node scripts/trajectory-validate.mjs --log trajectory.jsonl --repo <path> --json trajectory-audit.json
# 0 PASS · 1 FAIL · 20 UNGRADED
```

Ground the A/B verdict in the exact commit and diff without changing the existing module API:

```bash
node scripts/verdict-validate.mjs --verdict verdict.json --gate0 gate0.json \
  --runtime-receipt runtime-receipt.json \
  --repo <path> --base "$TASK_BASE" --task-base "$TASK_BASE" --json validation.json
```

`TASK_BASE` is the SHA locked when the task is received, not a `HEAD~1` recomputed at the end. Every A/B must anchor to
a file+line that really exists at `verdict.commit` and is an added line compared with that task baseline.
A pre-existing-debt finding is exempt from the added-line condition only when it explicitly declares `pre_existing: true`; the file and line must
still exist at that commit.

For a monorepo, anchor coverage and mutation blame to the module's own suite with a config in the repo:

```json
{
  "coverage": {
    "threshold": 80,
    "testFiles": ["apps/web/tests/*.test.mjs"]
  },
  "mutation": {
    "core": [],
    "threshold": 70,
    "testCmd": "node --test apps/web/tests/*.test.mjs",
    "testFiles": ["apps/web/tests/*.test.mjs"]
  }
}
```

`coverage.testFiles` and `mutation.testFiles` are globs over repo paths. Gate 0 blocks
Semgrep only on the diff's added lines; CVE runs only when the diff changes a manifest/lockfile. When `--base`
equals `HEAD` (baseline scan, no diff), these two layers still scan the whole repo as before.
Coverage merges LCOV with raw V8 data; lines executed inside `vm` are counted when Node's LCOV
reporter wrongly records 0 hits, and the number of supplemented lines is declared in `dynamic_vm_lines`.
Patch coverage excludes exactly the harness under `.teamcode/**/acceptance/`; with a Node that has
`stripTypeScriptTypes`, erased TypeScript syntax is also replaced with whitespace that keeps the
lines before classification, while an old runtime/TSX that cannot be stripped keeps the conservative fail-closed measurement.
Mutation excludes `test/tests/__tests__/e2e` and `*.test|spec|e2e.*` from the source, then interleaves mutants
by file so that modules sorted later are not starved when the budget is hit.

```bash
# ⓪ lock once when the task is received; keep this SHA through every fix round
TASK_BASE="$(git -C <path> rev-parse HEAD)"

# ① machines run first — cumulative diff from the task baseline
bash scripts/gate0.sh --repo <path> --base "$TASK_BASE" \
  --requirements <path-in-repo>/REQUIREMENTS.json \
  --config <path-in-repo> --json gate0.json
#   exit 0 = green · 1 = red, STOP, return to the coder · 20 = UNGRADED, treat as red

# ② the LLM grades the rest (only when ① exits 0)
bash scripts/qa-run.sh --repo <path> --mode tools|static --gate0 gate0.json \
  --base "$TASK_BASE" --json verdict.json --receipt qa-code.receipt.json

# ③ grade that verdict itself
node scripts/verdict-validate.mjs --verdict verdict.json --gate0 gate0.json \
  --runtime-receipt runtime-receipt.json \
  --repo <path> --base "$TASK_BASE" --task-base "$TASK_BASE"
#   exit 0 = PASS/PASS-STATIC · 1 = FAIL/REJECTED · 20 = UNGRADED/broken JSON
```

Broken JSON or a missing schema is retried exactly once by default; the `--retry-once` flag was removed.
The `codex-native` route uses a two-phase native host (prepare/grade) through a locked child proof, static mode only with a PASS-STATIC ceiling; it does not call a model CLI or MIXER. The `codex` and `claude` routes call the real CLI with an exact model and explicit reasoning;
they do not just relabel `--engine` while still calling Grok. Configuration examples and metadata limits:
`references/teamqa-provider-routes.md`.

A Team-code repo must record `coder_vendor: <vendor>` in `.teamcode/spec.md` or
`roles.coder.vendor` in `.teamcode/spec.json`; the same vendor as QA makes the verdict `UNGRADED`.
In Team-code, the receipt lives at
`.teamcode/runs/<run_uuid>/receipts/qa-code.receipt.json`; see
`references/release-receipt-v2.md` for runs with a graph and `references/release-receipt-v1.md` for
standalone legacy.

`--runtime-receipt` is required when the verdict is `PASS` and the diff touches auth/permission/migration.
Format and evidence sources: `references/runtime-receipt-v1.md`.

## Nightly mutation — install the LaunchAgent (F1) + pin Node (C2)

The plist in the repo (`launchd/io.qacode.mutation-nightly.plist`) is a **template** with
`__PLACEHOLDER__` values — it deliberately hardcodes nobody's checkout, so it cannot load on its own. To make it
really run under `launchd`, render it into absolute paths with the zero-dependency installer:

```bash
# render + write ~/Library/LaunchAgents (not loaded yet), and pin the absolute node for the wrappers
bash scripts/install.sh --repo <path-of-repo-to-grade>
# check before writing anywhere: render to stdout, touch nothing on the machine
bash scripts/install.sh --repo <path> --print
# really activate (opt-in): add --load to launchctl bootstrap
bash scripts/install.sh --repo <path> --load
# uninstall: bootout + delete the rendered plist + delete the pinned node-path
bash scripts/install.sh --uninstall
```

The installer renders all six paths as absolute — nightly script, target repo, Node, state dir,
stdout, stderr — and sets `WorkingDirectory` = the skill folder, so `launchd` (which starts in `/`)
can resolve everything. It also writes the absolute Node path to `scripts/.node-path` (changeable through
`--node-file` / `QA_CODE_NODE_FILE`); **when `QA_CODE_NODE` is not set, the wrappers read this file
instead of searching PATH** (C2). By default there is NO `--load` and the real LaunchAgent is NOT touched — tests only render
into a temporary `--dest`.

## Exit table — required runtime and binaries

The three wrappers prefer `QA_CODE_NODE`; if it is valid, it wins. When it is not set, they read the Node record written at
install time (`scripts/.node-path`, changeable through `QA_CODE_NODE_FILE`). PRESENT and ABSENT are different:
a record that is **PRESENT** but whose first line is empty / relative / points to a missing file / is not executable ⇒ exit 20
fail-closed, **searching PATH is forbidden** (no undeclared runtime change); only an **ABSENT** record (not installed)
keeps the old discovery for the dev/test path. `QA_CODE_NODE` pointing to a file that is not executable ⇒ exit 20,
**fallback forbidden**.

| Case | Code | Meaning |
|---|---|---|
| Four layers green / mutation meets the threshold | 0 | usable |
| A layer is red or an A/B finding remains | 1 | FAIL, blocks merge |
| Missing Node or a required binary ⇒ exit 20 UNGRADED, PATH fallback forbidden | 20 | fail-closed |
| Wrong CLI arguments (except a missing TASK_BASE) | 2 | invocation error |

Missing Node or a required binary (`QA_CODE_NODE` points to a file that is not executable, or there is no node) ⇒ exit 20 `UNGRADED`, treated as red — never silently counted as PASS.

## Out of scope

- **K1** Do not build a `qa` router that calls qa-gui + qa-code together in this version. Do it after both have really run at least one run.
- **K2** Do not let the LLM grade design and business intent when there is no acceptance as the yardstick. That area is the main source of false positives.
- **K3** Do not build a council of several models from the same vendor.
- **K4** Do not debug Grok's `cancelled` disease within the scope of this skill. Use the measured path: put the material straight into the prompt, forbid tools, lower the verdict grade to `static`.

---

*v1.11.1 — 2026-10-30 · Every PASS (tools or static) needs a green Gate 0; a gitleaks or CVE scanner failure is
UNGRADED, and gitleaks runs with a QA-owned config the reviewed repo cannot change.
v1.11.0 — 2026-10-30 · The Team QA a review proof is checked against defaults to the one installed next to this QA Code
(the suite install or the Claude Code plugin `team-qa@agentpro`); a source checkout keeps `~/.agents/skills/team-qa`.
v1.9.0 — 2026-10-23 · `claude` route: effort and model are observed from the original transcript of the worker session
(`~/.claude/projects/<project>/<session-id>.jsonl`), because stream-json does not emit effort; an edited source,
a session mismatch, a nested transcript or one outside the root are all UNGRADED.
v1.5.0 — 2026-09-02 · Release C: an immutable escaped-defect registry and a cross-layer gate-wiring
detector bind exact fixture/test/mutation/gate/evidence bytes; a surviving mutation blocks the package.
v1.4.0 — 2026-09-01 · Receipt v2 binds every atomic row to a case from the locked `acceptance_ids`;
the producer and the independent verifier both reject a missing, unknown or requirement-mismatched case.
v1.3.2 — 2026-08-27 · A checker declared required in `receipts.required` is always activated, so that
a required receipt cannot fall into `UNGRADED` on its own just because the diff does not touch a default trigger.
v1.3.1 — 2026-08-26 · Added fail-closed preservation/diff-proof and patch-coverage classification
by executable code, not counting the Team-code acceptance harness or erased TypeScript syntax.
v1.3 — 2026-08-25 · Release Truth v2. Frozen graph/LOCK denominator, immutable threshold/base/
source/lane, atomic evidence, stale receipt rejection, tampering seal and v1 legacy compatibility.*
