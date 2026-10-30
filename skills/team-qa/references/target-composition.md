# Explicit target composition

This adds parent accounting to existing single-target runs. It does not change child grading, approval, source graph, recording or exit gates.

## Inputs and preparation

`schemas/target-composition.json` defines a request. Pin the original signed plan, tracked v2 and historical approval bytes. Supply explicit target IDs, `data.app` values, current planned run UUID/base/final SHA/requirements hash and exact target tuple. `case_targets` contains every original case ID in original order. Each mapping must equal the targets whose explicit `app_values` contains that case's `data.app`; no title inference is permitted. A cross-app label must be mapped to all its declared targets.

```sh
node scripts/teamqa.mjs composition validate --file composition.json
node scripts/teamqa.mjs composition prepare --file composition.json --out projected-round-1
```

Output refuses an existing directory. Parent files stay immutable. Per-target tracked cases retain exact objects and order, including full original steps/expected/sourceRefs; source registry entries are the referenced parent entries in parent order. Child plans retain original exit criteria and applicable requirements/lanes. The parent still owns all original sources, cases and gaps.

The child plan includes parent plan/tracked and composition SHA outside its machine block. Thus its ordinary current SIGN binds this projection/mapping. Historical parent approval is a preserved source artifact; it is never copied into a current child approval. Preparation is ungraded and grants no permission to dispatch.

Use each projection in its own existing TeamQA run; gather the actual current roster and plan user events, role attestations, frozen graph/RTM/board, exact target/source binding and child receipts through normal commands. Target IDs/builds are separate; there is no joined SHA. Cross-app steps are not reduced to a local subset: execution must supply the full original oracle with exact other-target dependency evidence. Missing cross-target evidence stays ungraded.

For every cross-app PASS row, include one `schemas/composition-execution.json` artifact in that row's existing `evidence` array. Name it `composition-execution-<sha256-of-file-bytes>.json`. The filename is locked by the child's board receipt; changing the proof bytes cannot preserve its accepted pin. Its composition hash, case ID, executing target ID and run UUID must match this run. Its ordered `targets` must contain each declared component's exact `{id, run_uuid, target, exact_final_sha}`. Record the builds actually used during execution, rather than copying the requested builds into a claim. Include nonempty `flow_evidence` pins for the original cross-app oracle; each file must also be in that row's evidence. The ordinary child QA remains responsible for evaluating the oracle and the captured target observations; the composition gate checks their binding and file hashes, not model comprehension.

Both components need this proof. Missing, stale, mismatched or changed proof/flow bytes makes an otherwise passing shared case UNGRADED, and the parent NO-GO. Single-target cases retain their existing child grading. No new board fields or approval bypass are introduced.

## Aggregate only authentic child proof

`schemas/composition-children.json` pins one current TeamQA receipt v2 for every target, in request order. Receipt files must reside in the declared `runs/<run_id>/` directory. Legacy, re-sealed, diagnostic, wrong UUID/SHA/target or altered plan/case bytes are rejected. The builder calls the unchanged official `teamqa receipt verify`, which validates current run provenance, SIGN/roster, child proof and recomputed report. No manually supplied child verdict is accepted.

```sh
node scripts/teamqa.mjs composition build --file composition.json --children children.json --out parent-report-r1.json
node scripts/teamqa.mjs composition verify --file parent-report-r1.json
```

The report counts each original ID once. All its declared target components must pass for parent pass; any component fail is parent fail; absent/ungraded is ungraded. GO additionally requires every authentic child GO, every original case pass, and no uncovered original source/requirement. Function/UI remains in the unchanged cases and child gates. The report is a separate composition contract, not a forged single-target receipt. Verify reopens every pinned input and repeats the official child gate. An integrity hash proves bytes, not human authorship.

`build --out` requires a new path: existing inputs, reports and symlinks are rejected before child verification. The final write is exclusive as well, so a file created concurrently remains intact. Use a new report filename for each build; do not replace pinned inputs or prior reports.

## Verification boundaries

Focused fixtures test projection fidelity, exact app mapping, denominator/order preservation, exact cross-app execution pins, missing/stale/changed proof rejection and immutable output (including a concurrent write). A positive build/verify fixture stubs only the official child-verifier process to test its adapter calls and parent accounting; it is not an authentic current approval or product receipt. Separate rejection tests invoke the unchanged real child gate. These fixtures create no real approval or product acceptance. Strict Dragon collector fixtures run stub CLI version/help probes only. Mutation tests archive independent mutant copies and require RED; they never alter canonical/runtime source or call models.

The required `fixtures/run_fixtures.sh` runner archives its generated scratch directory on exit, including failures, under `${TMPDIR:-/tmp}/teamqa-fixtures-archive/` and prints `FIXTURE_ARCHIVE`. Fixture assertions, inputs and exit codes remain unchanged; archived evidence is retained for readback.
