# Coverage cells (R1b)

A coverage cell is the unit of GUI coverage:

    route × state × action × viewport row × environment condition

QA GUI owns the vocabulary, the app map that records what an exploration did not do, and the optional `cell` of a
state receipt that its gate checks. Team QA builds the coverage map from these (the denominator, the counts and the
report); QA GUI never decides coverage, and Team QA never grades a cell. Code: `scripts/lib/coverage-cell.mjs`,
`buildAppMapV2` in `scripts/loop6/app-map.mjs`.

## The axes

| Axis | Value |
|---|---|
| `route` | The surface: a screen's URL path (no origin, no query; hash routes keep `#/…`), a templated route's pattern (`/orders/:id`), or the node id of an overlay or tab (`dialog:delete-order`). |
| `state` | The coarse state. By rule: `loading` (readyState loading, skeleton or busy) > `error` (HTTP-like status ≥ 400 or an error flag) > the row family from a measured row count (`empty` 0, `one-row` 1, `many-rows` ≥ 2) > `ideal`. A label is never taken on trust: a row-family state needs a row count that agrees. |
| `action` | `view` (the state itself was observed and checked), or the gesture in the app map's trigger form (`click:Save`, `submit:order-form`, `click:nav-orders`). |
| `viewport` | A row id of the responsive matrix (`scripts/loop7/responsive-matrix.mjs`: `phone-320`, `phone-360`, `desktop-767`, `desktop-768`, `desktop-769`, `desktop-1280`, `phone-landscape`). |
| `condition` | `default` when nothing was forced, else the sorted `kind=value` pairs joined by `+` (`cpu=4x+network=offline`). Kinds: `network`, `request`, `cpu`, `timezone`, `locale`, `media`. Conditions are forced only at the environment layer (HR1); a fake clock or injected state is not a condition. |

`*` on an axis means "any": a skipped state that names no viewport, or a planned cell under any condition.

The state family of a screen with data: `empty`, `loading`, `error`, `one-row`, `many-rows`.

## Status of a cell

Run cells are `PASS`, `FAIL` or `UNGRADED`. A cell not run is `NOT_EXPLORED` with exactly one code:

| Code | Meaning |
|---|---|
| `BUDGET` | the step or time budget ran out first |
| `AUTH` | it needs a sign-in or a role the run does not have |
| `NEEDS_APPROVAL` | a destructive action the signed plan does not approve |
| `NO_DATA` | it needs data the test environment does not hold and the environment layer cannot force |
| `UNREACHABLE` | no path to it was found |
| `HOVER_ONLY` | only a hover reaches it |
| `OBSCURED` | another element covers the control |
| `TOOL_LIMIT` | the tool cannot perform the action, or the log does not say why it stopped |

`N/A` is Team QA's: it needs a reason signed in the test plan.

## App map v2 (`qa-gui/app-map/v2`)

`node scripts/qa-gui.mjs app-map --log <exploration log .json> --out <app-map.json>` (or `buildAppMapV2(observations)`
from `scripts/loop6/index.mjs`). The log is the V6.1 observation log; v1's `buildAppMap` ignores the extra fields and
keeps its frozen output.

Extra input fields:

- On a settled observation: `domHash` (64 hex, the strict state key), `rows` (a row count read in that state),
  `viewport` (row id or `WxH`), `conditions` (object), `route` (URL the screen was seen at), and
  `candidates: [{target, action?, blocked?, leadsTo?, detail?}]`, the affordances seen there. A candidate later taken
  from that node is an edge; one never taken stays in the frontier.
- A nodeless observation `{action, target, blocked: <code>, detail?}`: an attempt that was refused.
- `{action: "skip", route, state, reason: <code>, viewport?, conditions?, detail?}`: a state not reached.
- `{action: "stop", reason: FRONTIER_EMPTY | BUDGET_EXHAUSTED | BLOCKED, code?: <code, required for BLOCKED>, detail?}`.

Output: `{schema, nodes, edges, visited, total, denominatorReason?, states, frontier, stop, saturation, issues}`.

- `nodes`, `edges`, `visited`: the v1 graph; each node also carries its `route`.
- `total` is the v1 total only when the stop reason is `FRONTIER_EMPTY`; otherwise `null` with a `denominatorReason`.
- `states`: one entry per settled observation (and per loading observation on a known route):
  `{step, node, route, state, strict, viewport, condition}`.
- `frontier`: the cells seen and not run, `{id, kind: action|state, from, route, state, strict, action, target,
  viewport, condition, reason, leadsTo?, detail?}`. Every `reason` is one of the eight codes: the candidate's own
  `blocked` code, else the one the stop implies (`BUDGET_EXHAUSTED` → `BUDGET`, `BLOCKED` → the stop's code,
  `FRONTIER_EMPTY` → `UNREACHABLE`).
- `stop`: `{reason, code, detail, step}`. Declared, else `BUDGET_EXHAUSTED` from the v1 budget hint, else
  `FRONTIER_EMPTY` when no explorable candidate is left, else `BLOCKED`/`TOOL_LIMIT`. A declared `FRONTIER_EMPTY`
  while an explorable candidate is left is corrected to `BLOCKED` and reported as `STOP_FRONTIER_NOT_EMPTY`.
- `issues`: codes for log entries that could not be used (`SKIP_REASON_INVALID`, `STOP_REASON_INVALID`, …); an
  invalid code never passes through.

### Saturation Û

Û = f1 / n, Good-Turing's estimate of the chance that the next observation shows a state not seen yet.

- n = the number of state observations in `states` (for the strict grouping, those that carry a `domHash`);
- f1 = the number of distinct states seen exactly once (singletons) among them;
- computed twice: strict, the state key is the DOM hash; coarse, it is `route|state` by the rule above.
- `saturation.{strict,coarse} = {n, f1, distinct, u}`; `u` is `null` when n = 0. Receipts of directed cases are
  not samples of the exploration and do not count.

## The state receipt's `cell`

Optional, versioned. A receipt without it is unchanged.

```json
"cell": {
  "version": "qa-gui/coverage-cell/v1",
  "route": "/orders",
  "state": "empty",
  "action": "view",
  "viewport": "desktop-1280",
  "conditions": {},
  "rows": 0
}
```

`state` defaults to the receipt's `state`; `rows` is required when the state is `empty`, `one-row` or `many-rows`.
The gate (every mode) refuses, as UNGRADED for that state: an unknown or missing field, another version, a viewport
that is not a matrix row or not the size the receipt measured (`viewport` `WxH`), an unknown condition kind or a value
with spaces, `=` or `+`, and a row count that contradicts the state (`CELL_STATE_ROWS_MISMATCH`) or is missing
(`CELL_ROWS_UNMEASURED`). The strict key of the cell is the receipt's `domHash`. When some receipt has a `cell`, the
gate prints `Cells with receipt: <PASS+FAIL> (PASS a · FAIL b · UNGRADED c)`.

`conditions` are the ones Dragon recorded for the state (R1a): `cellConditionsOf(receipt.env.conditions)` in
`scripts/lib/coverage-cell.mjs` (`network`, `request`, `cpu`, `timezone`, `locale`, `media`; values in
[team-qa-detectors.md](team-qa-detectors.md)). With an `env` block the gate refuses a cell whose conditions differ from
that record (`CELL_CONDITIONS_MISMATCH`); without one, a cell that names any condition (`CELL_CONDITIONS_UNBACKED`).
