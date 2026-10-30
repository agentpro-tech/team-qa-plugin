# QA GUI Loop 6 product contract

The checker imports `scripts/loop6/index.mjs`. The module must expose the eight named functions below. They must be pure, deterministic, perform no I/O, mutate no input, and return JSON-compatible data. A missing export is a miss for that feature, not a checker crash.

All comparisons are canonical deep comparisons: object key names, scalar types and values, array membership, and array order must match the frozen corpus. The corpus does not declare any array order meaningless, so the checker does not sort or deduplicate any output. Extra fields fail deep comparison except for V6.4's explicitly open diagnostic payload described below. `undefined`, thrown errors, promises that reject, malformed shapes, and invented source/target data are misses.

## Exports

- `buildAppMap(observations)` returns the case's `expectedGraph` object exactly: `{nodes, edges, visited, total, denominatorReason?}`. Node and edge objects retain every corpus field and order. If `total` is unknown it is `null` and `denominatorReason` is present; no coverage percentage may be fabricated.

- `generateProperties(appMap, baRequirements)` returns `{verdict, properties, ungradedReason}`. `verdict` is the corpus value (`GRADED` or `UNGRADED`), `properties` is the exact `expectedProperties` array, and `ungradedReason` is the exact corpus string or `null`. Each graded property is `{sourceRef:{appMapNodes,baCodes},P,I,Q}`. Conflicts, insufficient/unknown sources, and a wrong HR2 target return the frozen UNGRADED output and no guessed property.

- `recallMemory(appIdentity, appMapHash, records, nextRound)` returns the case's `expected` object exactly. Its fixed fields are `verdict`, `ungradedReason`, `usedRecordIds`, `staleRecordIds`, `foreignRecordIds`, `duplicateRecordIds`, `missingEvidenceRecordIds`, `retentionDroppedRecordIds`, `priorityPathOrder`, `testPlanSources`, and `notes`. Foreign and stale records cannot silently become used PASS sources.

- `diagnoseFailure(evidence)` returns an object containing exact `label` and `action` values from `expectedLabel` and `expectedAction`, plus a non-empty string `reason` and a defined JSON-compatible `evidence` value. Additional report fields are allowed only for this export because the corpus freezes the classification/action oracle but not prose. Allowed graded labels are `selector`, `timing`, `data`, `runtime`, and `real-bug`; ambiguous evidence must preserve the frozen `UNGRADED` label. A case marked `mustNeverRetry` must not return action `retry`.

- `baToPlan(markdown)` returns `{cases, coverage}` where both values exactly match `expectedCases` and `expectedCoverage`. Invalid documents return `cases:[]` and the frozen UNGRADED coverage object; generation stops for the entire document. No orphan case or untraced required line is accepted.

- `replayIntent(savedSteps, redesignedControls)` returns `{verdict, targets, haltAtStep, reason, ungradedReason}` using the exact corpus values (`null` where absent). Targets and their order are frozen. Multiple plausible controls, state mismatch, unsafe intent changes, foreign/wrong environment, or other ambiguity halt with the corpus's UNGRADED result; the function must not choose a control.

- `evaluateRegressionJob(job, runResult)` returns the case's `expectedReport` exactly. Group and case order are significant. Missing Dragon, HR2 pin failure, timeout, missing group/checker/evidence, invalid schedule, or blind retry remain fail-closed exactly as frozen. A Dragon policy denial is FAIL, not absent/UNGRADED. Production and official fallback are never permitted.

- `planFormProbes(fields)` returns `{probes, untested}`. `probes` exactly matches `expectedProbes`; `untested` exactly matches `expectedUntested` or `[]`. Each probe is `{field,kind,value,expected}` with `kind` `EP` or `BVA`. Disabled, readonly, static, or unconstrained ordinary fields produce no probes. Unreadable custom-widget constraints produce the frozen `untested` entry, never guessed probes.

## Scoring and fail-closed rules

Every frozen case, including cases whose expected product verdict is `UNGRADED`, is a graded oracle case. “UNGRADED” describes the required product output; it does not remove that case from the denominator. Product exceptions and unavailable exports count as misses. The evaluator reports per-feature graded/matched/missed/ordinary/false-positive counts, recall, false-positive rate, and V6.4 real-bug recall.

Before importing or scoring product code, every run validates manifest status/version, all eight SHA-256 values, corpus headers/counts, source BA hash linkage, and manifest totals. Any validation or checker execution failure exits non-zero and emits no metric. If the product module itself is absent, the required numeric baseline is feature/overall/real-bug recall `0` and false-positive rate `1`.
