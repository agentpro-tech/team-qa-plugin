# ui-sanity — Gate 0 rule reference

> Companion to `scripts/ui-sanity.js`. SKILL.md carries the mandate + how-to; this file carries
> the per-rule detail, false-positive policy, and E2E evidence.

## Rules

| Rule | Sev | Fires when | Deliberately NOT flagged |
|---|---|---|---|
| `text-clipped-x` | high | element with direct text, `overflow-x:hidden/clip`, `scrollWidth > clientWidth+2` | `text-overflow:ellipsis`, `-webkit-line-clamp` (intentional truncation) |
| `text-clipped-y` | high | same vertically AND >0.45 line-height hidden (sub-pixel ≠ chop) | line-clamp; boxes <8px |
| `occluded-control` | high | visible interactive element whose center `elementFromPoint` hits an unrelated element | elements behind an OPEN modal (check scoped inside topmost dialog); label-wrapped inputs; below-the-fold |
| `overlay-cut-viewport` | high | open dialog/menu/popover <98% inside viewport | — |
| `overlay-cut-ancestor` | high | overlay escapes nearest `overflow:hidden` ancestor (dropdown-in-card bug) | scrollable ancestors (`auto/scroll`) |
| `page-overflow-x` | high | `documentElement.scrollWidth > clientWidth+2`; names ≤5 offenders | — |
| `misaligned-row/column` | warn | ≥3 same-tag visible siblings, tops/lefts drift 3px…60% of item size | bigger offsets (assumed intentional); absolute/fixed positioned |
| `zero-size-interactive` | warn | button/link/input rendered 0×0, statically positioned | `sr-only`/`visually-hidden`/`aria-hidden`/clip-rect patterns |

Output shape:
```json
{ "v":"ui-sanity/1.0", "state":"after-open-modal", "viewport":{"w":1280,"h":800},
  "scanned":312, "verdict":"FAIL", "counts":{"high":2,"warn":1},
  "issues":[{"sev":"high","rule":"occluded-control","sel":"button#confirm-btn",
             "detail":"center hit div#toast instead","text":"Confirm"}] }
```

## False-positive policy

Conservative by design — a linter that cries wolf gets ignored. Caps: 3000 elements scanned,
20 issues, 150 occlusion probes, dedupe by rule+selector. Epsilon 2px everywhere. When an open
modal exists, occlusion is checked ONLY inside the topmost overlay (everything behind a
backdrop is legitimately covered).

## Known blind spots (do not oversell the gate)

1. **Visually-broken-but-DOM-legal**: overlapping positioned texts, off-palette colors, broken
   images, font fallback — covered by the Tier-2 visual spot-check (SKILL.md), not the sweep.
2. **Occlusion checks element CENTER only** — a half-covered edge passes.
3. **CSP-locked pages** — eval blocked ⇒ sweep unmeasurable; report + 1 screenshot.

## E2E evidence (2026-07-14, CASE)

`tests/fixture-a.html` (clip-x, clip-y, occluded button, misaligned row, page overflow,
zero-size) + `tests/fixture-b.html` (menu cut by card, dialog off-viewport 65%, confirm button
covered by toast, background controls behind backdrop): **9/9 seeded defects caught, 0 false
positives** (ellipsis, sr-only, aligned rows, behind-modal controls all clean). Run via Dragon
`executeJs` on `file://` fixtures in a background session window. Fixture gotcha: seed overflow
with `calc(100vw + X)`, not fixed px (a 1600px div doesn't overflow a 1687px viewport).

## v2 rules (Phase 2)
Layer A (DOM deterministic, high ⇒ UI FAIL) — added on top of A1-A6:
- A7 broken-image — `img.complete && naturalWidth===0` (finished loading, no pixels).
- A8 distorted-image — object-fit:fill and render aspect ratio deviates > 15% from natural (Q1 default).
- A9 stacking-error — an OPEN overlay (dialog/menu/tooltip/popover) whose center hit-tests to another element ⇒ rendered underneath / wrong z-order.
- A10 invisible-interactive — a control with opacity:0 yet still hit-testable (pointer-events not none) ⇒ invisible click target.
- A11 unintended-text-overflow — element with direct text whose box escapes a NON-clipping parent (ellipsis/line-clamp whitelisted).
Run identically to v1 (one Dragon `read` step). Returns v:'ui-sanity/2.0'.

## Layer D — Console & Network sweep (Phase 2)
Run alongside ui-sanity at EVERY settled state via Dragon `getConsole`/`getNetwork` (or Playwright console/response listeners in tests):
- D1 console-error (console.error / uncaught) during the flow ⇒ high, FAIL that state.
- D2 console-warn repeated (>5 same message) ⇒ warn.
- D3 network 4xx/5xx not surfaced by an error state ⇒ high.
- D4 request hung/timeout ⇒ warn.
Record results per state; the gate enforces their presence **unconditionally** (there is no
opt-in flag) with `node qa-gate.mjs <board>` (each case must carry a non-empty `sweeps[]`).
Reference test: `.teamcode/browser-harness/p2-acceptance.mjs` (real Chrome via Playwright) proves A7-A11 + D1/D3 on fixtures in `.teamcode/p2/fixtures/`.

## Layer B — a11y (Phase 3, promoted to Gate-0)
`scripts/a11y-gate0.js` → `__a11yB({minTarget:24})` returns v:'a11y-b/1.0'. Rules: B6 contrast, B8 target-size, B9 reflow (current viewport — run every row from `scripts/loop7/responsive-matrix.mjs`). B7 focus-visible via `__a11yFocusProbe(el)` after the flow focuses the control. axe-core bundled offline at scripts/vendor/axe.min.js (4.10.2).

## Layer U — UX rules in the same sweeps (R1c)
`__uiSanity(label, {ux})` now also runs **U9 occluded-control-partial**: the controls A3 checks, hit-tested at the
centre and the 20%/80% corners of their part in view; a control with at least 2 of the 5 points covered fails (warn by
default). It closes blind spot 2 above: A3 still reports a covered centre, U9 adds the half-covered control whose
centre is free. `__a11yB({minTarget, ux})` runs **U4** (field error not tied to its field), **U5** (status message
outside every live region) and **U6** (focused element fully covered, block by default). Each report carries
`ux.rules` with PASS / FAIL / UNGRADED per rule; a U issue has an `id` (`"U9"`) next to its `rule`. The A/B issues
are unchanged (checked on every fixture and board template in this repo); a warn-level U finding never changes the
verdict, and with the default levels only U6 (focus fully hidden) can turn a passing a11y sweep into FAIL. `__uxObserve(opts)` (same file) returns the
observation the Node graders of U1/U2/U3/U8/U10 compare. All rules, levels, thresholds and forced-state recipes:
`references/ux-rules.md`.
