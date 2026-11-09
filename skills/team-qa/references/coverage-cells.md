# Coverage cells and the Coverage Gate (R1b)

The Coverage Gate counts **cells that have a state receipt**. A cell is

    route × state × action × viewport row × environment condition

The vocabulary (codes, the state rule, the condition key, the receipt's `cell`, app map v2) is QA GUI's; see QA GUI
`references/coverage-cells.md`. Team QA builds the coverage map and the report from it and never grades a cell.
Code: `scripts/lib/coverage-cells.mjs`. Everything here is opt-in: a run whose tracked plan has no `coverage` block
keeps its old plan, report and decision byte for byte.

## Inputs

**Tracked plan v2** (`schemaVersion: 2`) may add a root `coverage` block:

```json
"coverage": {
  "version": "team-qa/coverage-cells/v1",
  "rows": [{ "id": "desktop-1280", "size": "1280x800", "classes": ["desktop"] }],
  "staticRoutes": ["/orders", "/orders/new", "/admin"],
  "dataScreens": ["/orders"]
}
```

- `rows`: the viewport rows of the run (QA GUI responsive matrix ids), their `WxH` size and the case viewport classes
  (`mobile`, `tablet`, `desktop`) each stands for.
- With the block, a case may add `route` (a URL path, route pattern or overlay node id such as `dialog:delete-order`),
  `actions` (default `["view"]`) and `conditions` (default `["*"]`, any; otherwise `default` or sorted `kind=value`
  pairs joined by `+`). A case with `route` is a cell case: it declares route × states × actions × the rows of its
  viewports × conditions. Its `states` may also use `one-row` and `many-rows`.

**Signed test plan** may add `coverage: {version, na: [{route, state?, action?, viewport?, condition?, reason}]}`.
An `N/A` cell needs a reason, and only the plan the owner signs can hold one. An omitted axis matches any value.

**App map**: `runs/<run_id>/app-map.json`, QA GUI app map v2 (`node <qa-gui>/scripts/qa-gui.mjs app-map --log
<exploration log> --out runs/<run_id>/app-map.json`). On the web lane `teamqa web collect` writes it from the
explorations the GUI executor ran by recipe (`evidence/qa-gui/<case>/explore.json`, in case order; QA GUI
`references/team-qa-detectors.md`). Optional; without it the stop reason is `BLOCKED`/`TOOL_LIMIT` with detail
`APP_MAP_ABSENT` and Û has no sample.

**State receipts**: for each latest board record with `source: "qa-gui"`, the `qa-gui/state-receipt/v1` files of
its own case listed in its evidence, or named by the `evidence_manifest` of a QA GUI gate receipt in its evidence
(`qa-gui/receipt/v1|v2|web-v1`), accepted only when the file's SHA-256 equals the manifest's. Fields read:
`caseId`, `state`, `viewport` (`WxH`), `domHash`, `function.verdict`, `ui.verdict`, and the optional `cell`
(`version`, `route`, `state`, `action`, `viewport`, `conditions`). Without a `cell` the receipt backs the case's
route, its own state, `view`, the row of its measured size and `default`. A receipt of a record that is not
`pass`/`fail` backs its cell as UNGRADED. On the web lane, `teamqa web collect` writes the `cell` itself for a cell
case: the plan route, the state, the draft's `action`, the plan row of the measured size, the `conditions` QA GUI
derives from the Dragon conditions recorded for the state (`cellConditionsOf(env.conditions)`; `{}` when the case
touched no environment) and the row count of the draft's `rows` read step ([executor evidence](executor-evidence.md)).
A state receipt's `probes[].cells` (QA GUI's sealed probe cells) are counted too, hash for hash.

## The denominator

The union, in this order, of: the cells cases declare (origin `source:<sourceRef>`), the static routes (`ideal`,
`view`, every row; origin `static-route`), the state family `empty`, `loading`, `error`, `one-row`, `many-rows` of each
data screen (origin `state-family`), the app map's state observations (`app-map:node`) and its frontier
(`app-map:frontier`). A source that is concrete on an axis joins a cell that has `*` there. A receipt that backs no
cell adds one (origin `receipt`).

**Probe cells (R1e)**: a state receipt's `probes[].cells: {path, sha256}` names QA GUI's sealed per-cell result of a
width sweep or overlay check (`qa-gui/probe-cells/v1`: `{case, state, kind, probe_sha256, cells: [{route, state,
action, viewport, condition, status, reason?}]}`), which QA GUI's gate re-derives and enforces. Team QA reads it hash
for hash: the cells file and the probe file must match the state receipt's references, and the file must name that
case, state and probe. Its cells are counted like receipts (origin `probe`; an UNGRADED cell keeps its reason, such as
`PRECONDITION_ABSENT`); a file that does not match lists its cells UNGRADED `NO_RECEIPT`; a missing one backs nothing.
Both are recorded in the map's `receipt_problems` (`PROBE_CELLS_HASH_MISMATCH`, `PROBE_HASH_MISMATCH`,
`PROBE_CELLS_MISMATCH`, `PROBE_CELLS_MISSING`). Team QA never grades these cells.

## Status

1. A receipt backs it: `FAIL` if any graded receipt fails, else `PASS` if one passes, else `UNGRADED`
   (`RECEIPT_UNGRADED`).
2. Else a signed N/A matches: `N/A`, reason = the signed reason.
3. Else it was run (a case that declares it has a record, or the exploration saw it): `UNGRADED` (`NO_RECEIPT`).
4. Else `NOT_EXPLORED` with one code: its frontier code, else the code of a frontier branch that leads to its route
   (`leadsTo`), else the code the stop reason implies (`BUDGET_EXHAUSTED` → `BUDGET`, `BLOCKED` → its code,
   `FRONTIER_EMPTY` → `UNREACHABLE`).

**The case rule.** A cell case whose record is `pass` or `fail` while a cell it declares has no graded receipt of its
own (for example `states: ["empty"]` with no receipt in the empty state) gets the grounded issue
`COVERAGE_CELL_UNGRADED <case> <missing>/<declared> declared cell(s) without a state receipt` (checker
`coverage-cells`, contract `RED-TQ-COVERAGE-CELLS-001`), and it does not cover its requirement in
`coverage_high_pct`/`coverage_low_pct`. Either makes the decision `NO_GO`.

## Outputs

`report build` writes `runs/<run_id>/coverage-map.json` (`team-qa/coverage-map/v1`: every cell with `key`
`route|state|action|viewport|condition`, `status`, `reason`, `origins`, `cases`, `receipts`, `strict`, `frontier`,
`observed`; the strict splits; receipt problems) and adds to the report JSON:

| Field | Meaning |
|---|---|
| `coverage_cells.version`, `map`, `map_sha256` | `team-qa/coverage-cells/v1`, `coverage-map.json`, the SHA-256 of that file |
| `app_map` | `{present:false}` or `{present, schema, sha256, skipped}` |
| `coarse` | cells by the rule grouping (`route\|state`): `cells`, `covered` (PASS+FAIL), `PASS`, `FAIL`, `UNGRADED`, `NOT_EXPLORED`, `NA` |
| `strict` | the same by DOM hash: each cell splits into the DOM states seen for it; a split counts only with a receipt of that hash |
| `not_explored` | NOT_EXPLORED cells per code (all eight codes) |
| `saturation.strict`, `saturation.coarse` | `{n, f1, distinct, u}` over the app map's state observations: n = observations (strict: those with a DOM hash), f1 = states seen exactly once, u = Û = f1/n (`null` when n = 0) |
| `frontier` | `{candidates, by_reason}`: branches the exploration left, per code |
| `stop` | `{reason, code, detail}`: `FRONTIER_EMPTY`, `BUDGET_EXHAUSTED` or `BLOCKED` |
| `case_cells` | `{cases, declared, with_own_receipt, ungraded_cases}` |

These are separate numbers and never one percentage. The report adds a `## Coverage cells` section, `red_checkers`
gets the `coverage-cells` row (only in such a report), and the result line gets `cells_covered`, `cells`, `frontier`
and `stop`. `report verify` rebuilds the block and checks the map file's SHA-256 (`COVERAGE_MAP_MISMATCH`).

## The exploration policy (R1e)

Team QA orders QA GUI's frontier exploration; QA GUI explores and grades. `teamqa coverage policy --run <run_id>
[--out <file>]` writes `runs/<run_id>/exploration-policy.json` (`qa-gui/exploration-policy/v1`):

- `requirementCells`: every cell a cell case declares, `{route, state, action, requirement, case}`;
- `highRisk`: the cells of the cases on a FULL-tier requirement or with priority P0/P1;
- `approvedDestructive`: `{route, action}` of the signed plan's `coverage.destructive: [{route, action, reason}]`.
  A destructive action the signed plan does not list is never pressed; the explorer leaves it with `NEEDS_APPROVAL`.

The command needs the tracked plan's coverage block (`COVERAGE_CELLS_REQUIRED` otherwise). Run QA GUI's explorer with
this policy and put its app map (`qa-gui.mjs app-map --log <exploration log>`) at `runs/<run_id>/app-map.json`. On the
web lane the case dispatch of a cell case carries the policy in its exploration recipe (`TEAMQA_DETECTORS`), and
`web collect` writes the app map.
