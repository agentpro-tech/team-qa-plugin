# qa-gui — Product-Taste Review Layer (runnable rubric)

Full detail for SKILL.md §5. Turns the **Dragon Browser UI-Critic Rubric v1** into a runnable
review layer inside qa-gui: besides "does the feature work?", score "does it look good + is the
craft right?" — by numbers, with evidence. Source rubric (versioned, do NOT hard-code thresholds
in code): the Dragon Browser project's `UI-Critic-Rubric-v1.md` (A1–A6 · B1–B7 · C1–C13 · D · E · F).

## 0. Core idea (why 2 layers)
A single absolute aesthetic score from **one VLM call** is the **least reliable** signal
(correlates with designers only ρ≈0.49–0.70, drifts run-to-run). Recover trust with a
**decomposed · anchored · grounded · multi-sample** judgement — not a bigger model.
- **Layer 1 — Deterministic gate (machine).** Hard gate. `critical|high` here = FAIL, no VLM.
- **Layer 2 — Taste score (VLM judge).** Only when Layer 1 is clean. Per-criterion, anchored,
  reasoning-before-score, ≥3 samples → median.

The CSS/typography group flagged most often (🅒): **A6, B1, B2, B5, B6, C1, C2, C6, C7, C8,
C11** — run these first.

## 1. Mandatory pre-conditions (run once, before any measurement)
Wrong here → mass false-positives. Wrap every taste `read` in this:
```js
// step read {as:"ready"} — gate before any geometry/CSS measurement
await new Promise(r => (document.readyState==="complete") ? r() : addEventListener("load", r));
await document.fonts.ready;
await new Promise(r => requestAnimationFrame(()=>requestAnimationFrame(r)));
return { ready:true, vw: innerWidth, dpr: devicePixelRatio };
```
- Measure taste at **viewport 1280** first; responsive (A5) runs its own matrix — the canonical
  rows in `scripts/loop7/responsive-matrix.mjs` (`RESPONSIVE_MATRIX` / `responsiveMatrix()`).
- Use `EPS=1` for all px comparisons (scrollWidth is int, DOMRect is float → ~1px drift is normal).

## 2. GATE 1 — Deterministic (A1–A6) · pass/fail · NO LLM
Each check returns `{rule, pass, severity, expected, actual, selector}` → maps straight to the
feedback-contract (§6). The 🅒 group (CSS/typography-heavy) runs first.

### A1 · Accessibility (WCAG 2.2) — backbone = axe-core
Inject axe, score only `violations` (push `incomplete` → advisory):
```js
// step read {as:"a11y"} — inject axe-core first (CDN or internal bundle)
if (!window.axe) { /* inject https://cdn.jsdelivr.net/npm/axe-core/axe.min.js, await */ }
const r = await axe.run(document, { resultTypes:["violations"] });
return r.violations.map(v => ({
  rule:"A1", id:v.id, impact:v.impact,                 // critical|serious|moderate|minor
  help:v.help, nodes:v.nodes.map(n=>n.target).slice(0,5)
}));
```
| Check | Pass | Severity |
|---|---|---|
| Contrast text (1.4.3) 🅒 | ≥4.5:1 normal · ≥3:1 large (≥24px / ≥18.66px-bold) | **high** · *needs-review* on gradient/image/alpha bg |
| Accessible name (1.1.1/4.1.2) | img/button/input/select/link has a name | **critical** (img/control) · high (link) |
| Target size (2.5.8) | ≥24×24px (or spacing exception) | high |
| Valid ARIA (4.1.2) | role/attr/IDREF/parent-child valid | **critical** |
| Focus visible (2.4.7) 🅒 | has indicator, not occluded, `tabindex≤0` | high |

### A2 · Runtime health (binary — strongest signal)
Read console + network via Dragon (sanitize cross-origin "Script error."; `status:0` = opaque,
NOT an error):
| Check | Severity |
|---|---|
| Console error / uncaught exception | high (has stack → fixable) |
| Unhandled promise rejection | high |
| Request 4xx/5xx (script/css/img/font) | high (5xx & subresource) · medium (other 4xx) |
| Mixed content / CSP violation (enforced) | high (script/style) |

### A3 · Layout correctness (geometry — gate hard)
```js
// step read {as:"layout"} — overflow/clipping/overlap/broken-img
const EPS=1, de=document.documentElement;
const hScroll = de.scrollWidth > de.clientWidth + EPS;        // use clientWidth, NOT innerWidth
const clipped=[], truncSilent=[], brokenImg=[];
function cssPath(e){return e.tagName.toLowerCase()+(e.id?"#"+e.id:"")+(e.className&&typeof e.className==="string"?"."+e.className.trim().split(/\s+/).join("."):"");}
for (const el of document.querySelectorAll("*")) {
  const cs=getComputedStyle(el);
  const ov=(cs.overflow+cs.overflowX+cs.overflowY);
  if (el.scrollWidth>el.clientWidth+EPS && /hidden|clip/.test(ov)) {
    const ell = cs.textOverflow==="ellipsis" || el.title;   // ellipsis/title => valid truncation
    if (!ell) truncSilent.push(el.tagName);                 // silent loss
    clipped.push(cssPath(el));
  }
}
for (const im of document.images) if (im.complete && im.naturalWidth===0) brokenImg.push(im.currentSrc||im.src);
return { hScroll, clipped, truncSilent, brokenImg };
```
| Check | Pass / classify | Severity |
|---|---|---|
| Page horizontal scroll | `scrollWidth ≤ clientWidth+ε` | high → **critical** if it clips a CTA |
| Element overflow/clipping | overflow + `overflow:hidden/clip` = CLIPPED | high (text/interactive lost → critical) |
| Silent text truncation 🅒 | overflow + NO ellipsis/title | high (silent loss) · medium (heading/label/nav) |
| Bbox overlap | only same-parent **siblings**; skip absolute/fixed/transform; confirm with `elementFromPoint` | high (in-flow) · critical (covers a control) |
| Broken image | `complete && naturalWidth===0` | high (hero/logo → critical) |

### A4 · Core Web Vitals (lab — label "load-phase, lab")
Read via `PerformanceObserver` (CLS attribution = selector + Δpx):
| Metric | Good / NI / Poor | Severity |
|---|---|---|
| **CLS** ★ 🅒 | ≤0.1 / 0.1–0.25 / >0.25 | high (poor) · medium (single shift ≥0.1) |
| LCP | ≤2.5s / –4s / >4s | high (poor) — include element + phase |
| TBT (proxy for INP) | ≤200 / –600 / >600 ms | high (>600) — passive bot has no INP, use TBT |

### A5 · Responsive (WCAG 1.4.10 Reflow)
Emulate via Dragon across the **canonical matrix** — read the rows from
`scripts/loop7/responsive-matrix.mjs` (`RESPONSIVE_MATRIX` / `responsiveMatrix()`), never re-typed
here: a second copy of the sizes drifts and then reports a breakpoint it never measured. Each row
carries `w`/`h` plus the `profile`/`dpr` to emulate it with (`mobile:true` for phone rows), and the
rows already include the phone widths, the `bp−1/bp/bp+1` triple around the breakpoint, desktop and
a landscape phone. Re-run A3 at each viewport.
- **320px = hard gate:** 2-axis scroll at 320 → **critical** (except table/map/video/toolbar).
- Missing `width=device-width` meta-viewport → high. Tap target 24×24 (floor) · 48×48
  (best-practice). ≥40% text <12px → medium.

### A6 · Design-token / CSS conformance 🅒 (the CSS-heavy one with the highest priority)
> ⚠️ Limit: `getComputedStyle` returns values with `var()` already resolved
> (`padding:var(--space-4)` reads as `"16px"`) → you can only score "is the value on-scale",
> *approximating* "does it use a token". Each issue carries `authoritative:true|false`.
```js
// step read {as:"css"} — sprawl + off-scale spacing/radius/shadow + font/weight inventory
const SCALE=new Set([0,2,4,8,12,16,20,24,32,40,48,56,64,80,96,128]); // 4/8pt
const px=v=>parseFloat(v)||0;
const spaceOff=new Set(), radii=new Set(), shadows=new Set(), fams=new Set(), weights=new Set();
let tinyText=0, totalText=0;
for (const el of document.querySelectorAll("*")) {
  const cs=getComputedStyle(el);
  for (const p of ["marginTop","marginBottom","marginLeft","marginRight","paddingTop","paddingBottom","paddingLeft","paddingRight","gap","rowGap","columnGap"]) {
    const n=Math.round(px(cs[p])); if (n>0 && !SCALE.has(n)) spaceOff.add(n);   // magic-number spacing
  }
  if (px(cs.borderTopLeftRadius)>0) radii.add(Math.round(px(cs.borderTopLeftRadius)));
  if (cs.boxShadow && cs.boxShadow!=="none") shadows.add(cs.boxShadow);
  fams.add(cs.fontFamily.split(",")[0].replace(/["']/g,"").trim());
  weights.add(cs.fontWeight);
  if (el.childElementCount===0 && el.textContent.trim()) { totalText++; if (px(cs.fontSize)<12) tinyText++; }
}
return {
  spacingOffScale:[...spaceOff].sort((a,b)=>a-b),   // 🅒 magic numbers 13/17/47px…
  radiiSet:[...radii], shadowCount:shadows.size, shadowSet:[...shadows].slice(0,6),
  fontFamilies:[...fams], fontWeights:[...weights],
  tinyTextPct: totalText? +(tinyText/totalText*100).toFixed(1):0
};
```
| Check (CSS) | Has token set | No token (sprawl smell) |
|---|---|---|
| Spacing off-scale (4/8) 🅒 | medium | low ("47 different sizes") |
| Color off-palette 🅒 | medium-high | low |
| Type off-scale / sprawl 🅒 | medium | low-medium |
| radius / shadow magic 🅒 | low-medium | low |

## 3. GATE 2 — Anti-slop hard flags (C1–C13) · scan the CSS already read
Cheap flags → hard flags. Run right after A6 on the same `css`/`layout` data. Functional
hard-flags (**C9, C13**) → FAIL even if the taste score is pretty.

| Flag | Detect (from data already read) | Level |
|---|---|---|
| **C1** 🅒 Default Tailwind/shadcn palette | hex ∈ {`#6366f1` indigo-500, `#3b82f6` blue-500, default zinc/slate} | **hard flag** |
| **C2** 🅒 Purple→pink/indigo gradient | parse gradient stops, OKLCH hue ~270–330; CTA `#7C3AED` | **hard flag** |
| **C3** Emoji as feature/nav icon | emoji codepoint (🚀✨🔒) in an icon slot | medium-high |
| **C4** Center-everything | `text-align:center`/`mx-auto` on long text; ≥80% sections centered | 1–5 |
| **C5** "Hero + 3 feature-cards + CTA" cookie-cutter | uniform 3-col card grid under the hero | medium |
| **C6** 🅒 Spacing magic-numbers | `spacingOffScale` not clustering on 4/8 | 1–5 |
| **C7** 🅒 Drop-shadow overuse / one hard shadow | `shadowCount==1` everywhere; `rgba(0,0,0,0.1)` | 1–5 |
| **C8** 🅒 Over-rounded everything | one radius ≥16px everywhere / mixing ≥4 radii | 1–5 |
| **C9** Missing empty/loading/error/validation | probe form + data view (see B7) | **hard flag (functional)** |
| **C10** Purposeless glassmorphism | `backdrop-filter:blur` + text fails contrast over real bg | flag when contrast fails |
| **C11** 🅒 System font for all type | every `fontFamilies` ∈ {Inter, Roboto, Open Sans, Lato, system-ui}, no display face | flag (also flag the new cliche Space-Grotesk-default) |
| **C12** Lorem-style empty copy | "Empower your workflow" … | VLM-only 1–5 |
| **C13** Missing focus / unlabeled icon-button / color-only signal | `outline:none` not replaced; icon-only missing `aria-label` | **hard flag (functional)** |

```js
// step read {as:"slop"} — C1/C2/C11 from css already read; C9/C13 from probe (see B7)
const sysFonts=new Set(["inter","roboto","open sans","lato","system-ui","-apple-system","arial","helvetica"]);
return {
  C1_twPalette: false,       // set if fill/bg/border colors hit the default Tailwind table
  C2_purpleGradient: false,  // set if gradient hue 270–330
  C11_systemFontOnly: ($css.fontFamilies||[]).every(f=>sysFonts.has(String(f).toLowerCase())),
  C7_singleHardShadow: ($css.shadowCount===1),
  C8_overRounded: ($css.radiiSet||[]).some(r=>r>=16) && ($css.radiiSet||[]).length>=4
};
```

## 4. GATE 3 — Taste score 0–100 (B1–B7 · VLM judge) · only when Gate 1 is clean
7 dimensions = 100 taste points. Score **per-criterion** (NOT holistic), each 1–5 with anchors,
**reasoning-before-score**, **≥3 samples → median**. `captureTab {format:"jpeg",quality:40}` +
attach the **DOM facts** you read (§1–§3) next to the image so the model scores on evidence.

| # | Dimension | Weight | Measurable proxy (from `read`) — 🅒 = CSS/typo |
|---|---|---|---|
| **B1** | Spacing & rhythm 🅒 | **18** | ≥90% margin/padding/gap ∈ scale 4/8 (`spacingOffScale` empty); intra-group ≥ inter-group = "ambiguous spacing"; desktop section ≥48–64px |
| **B2** | Typographic craft 🅒 | **18** | flag if all fonts = Inter/Roboto/system (`C11`); flag `letter-spacing:normal` on h1 >40px (large headings need **negative** tracking); measure 45–75ch (flag >90 or <40); flag `font-weight<400`; `tabular-nums` for numbers |
| **B3** | Visual hierarchy | **16** | count same-level primary CTAs (>1 = flag); heading↔body contrast; one focal point |
| **B4** | Layout & alignment | **14** | flag centered paragraph >3 lines / >60ch; flag ≥80% identical centered sections (no asymmetry); never center long text |
| **B5** | Color & contrast (aesthetic) 🅒 | **14** | extract colors→OKLCH; flag uniformly high-chroma palette; reward shade ramp + semantic tokens; flag raw Tailwind default; 60-30-10 |
| **B6** | Depth/border/radius/shadow 🅒 | **8** | reward multi-layer `box-shadow` + elevation scale; flag one `rgba(0,0,0,0.1)` shadow everywhere; flag mixing ≥4 radii |
| **B7** | Consistency & polish (states) | **12** | ⚠️ ~½ NOT verifiable from one screenshot → **must probe** (below) |

**Anchors (send with the VLM prompt — these are the anchor, NOT "give a nice total"):**
- **B1** — *5:* clear rhythm, breathing room. *1:* magic-numbers 13/17px, cramped.
- **B2** 🅒 — *5:* own font, negative display tracking, 45–75ch measure. *1:* Inter everywhere, default tracking, 100ch lines, `font-bold` as the only hierarchy.
- **B3** — *5:* one clear focal point. *1:* everything same weight, "wall of content".
- **B4** — *5:* disciplined grid, intentional asymmetry. *1:* center-everything.
- **B5** 🅒 — *5:* token-driven, desaturated / single-accent. *1:* default saturated Tailwind, no shade system.
- **B6** 🅒 — *5:* elevation scale + subtle borders. *1:* one hard drop-shadow everywhere.
- **B7** — *5:* every state designed (hover/focus/active/disabled/empty/loading/error). *1:* none.

**B7 — MUST PROBE (one screenshot can't prove it; report "not verified" rather than scoring an
absent state)** using qa-gui `do` steps:
- Form: `fill` required empty → `click` submit → `assert {text:"required|invalid"}` / read
  `aria-invalid`. No error → C9.
- Empty list: navigate to an empty view → `assert {selector:"[role=status],.empty-state,.skeleton"}`.
  None → C9.
- Focus: `read` whether `:focus-visible` exists in stylesheets; `key Tab` then read
  `document.activeElement` outline. `outline:none` not replaced → C13.
- Dark mode: toggle → diff parity (text/border still has enough contrast).

**Taste score = `Σ (Bi_score/5) × weight_i`** (0–100). Multi-sample: run the VLM ≥3×, take the
**per-criterion median** then sum (kills run-to-run drift; low temp + seed).

## 5. VLM-judge protocol (makes the score trustworthy — D)
1. **Deterministic-first** — call the VLM only when Gate 1 is clean or you need a reference compare.
2. **Decompose, NOT holistic** — score each B1–B7 separately, each 1–5 with anchors.
3. **Reasoning-before-score** — make the model reason BEFORE the number (G-Eval).
4. **Relative > absolute** — with a reference design → reference-guided (output vs target);
   without → compare to the anchor descriptions.
5. **Multi-sample** — ≥3 runs, take the **median** per criterion.
6. **Grounding vs hallucination** — attach DOM facts (selector + computed style + bbox you read)
   beside the pixels.
7. **Evidence for long pages** — crop ROIs of suspect regions (top-k crops per criterion) instead
   of full-page; tile tall pages. Dragon: `captureTab` per region / scroll-then-capture.
8. **Strict JSON output** — `strict:true` schema → each issue has `selector + bbox + severity +
   fix_hint`, maps straight to §6.
9. **Bias guard** — position/verbosity/self-preference/leniency. Critic ≠ coder model (VLM
   scores · a different agent fixes) reduces self-preference.

## 6. Emit the feedback-contract (E) — maps straight into the auto-fix loop
All issues (deterministic + taste) into **one unified JSON array**:
```json
{
  "verdict": "FAIL|WARN|PASS",
  "score": 0,
  "delta_vs_prev": 0,
  "issues": [
    {
      "source": "deterministic",
      "rule": "A6",
      "severity": "medium",
      "selector": "section.pricing .card",
      "expected": "spacing in {4,8,12,16,24,32}",
      "actual": "padding: 13px 17px",
      "authoritative": false,
      "fix_hint": "Snap padding to 12/16px; replace magic-numbers with token --space-3/4"
    },
    {
      "source": "vlm",
      "rule": "B2",
      "severity": "high",
      "selector": "h1.hero",
      "evidence": "crop@(0,0,1280,360)",
      "actual": "Inter 64px, letter-spacing: normal",
      "fix_hint": "Display heading >40px needs negative tracking (~-0.02em); consider a display face over Inter"
    }
  ]
}
```
- Deterministic issue → `source:"deterministic"`, `rule`=A1–A6, `expected/actual`=measurements,
  `authoritative:true|false`.
- Taste issue → `source:"vlm"`, `rule`=B1–B7 / anti-slop C1–C13, `evidence`=crop+bbox, **specific**
  `fix_hint` (not "improve spacing" — say "snap 13px→12px").
- `score` = weighted(deterministic_penalty, Σ taste_dim×weight). `delta_vs_prev` tells the loop
  when to stop.
- The self-fix loop only iterates on `critical|high`; `low|medium` = advisory.

## 7. Verdict (put into workflow step 4 "Record")
```
deterministic critical|high                 → FAIL  (skip VLM)
anti-slop functional hard-flag (C9|C13)     → FAIL
taste_score < 70 with a critical taste issue → FAIL
taste_score < 85                            → WARN
else                                        → PASS
```
Report: **verdict + score + the 3–5 worst issues + fix_hint** + one piece of evidence
(measurement / crop). Note build/commit if known.

## 8. Operational notes
- **Dependencies:** Gate 1 needs **axe-core** injected (CDN `cdn.jsdelivr.net/npm/axe-core/axe.min.js`
  or bundle into `scripts/`). Gate 3 needs a **VLM vision** (same gpt-vision path as
  `product-launch-video`'s `qa-vision.sh`, or Codex-vision). No VLM → run Gates 1+2 and report
  taste = "not scored (no VLM)".
- **CSP:** builder/editor pages block `eval` → `read` steps fail. Per qa-gui's existing pitfall,
  score taste on the **deployed/preview** build, not the locked editor.
- **Clip frames (SSIL / product-launch-video):** no DOM → run only **Gate 3 (VLM B1–B7) + visual
  anti-slop (C2/C4/C11)** on the extracted frame; skip A1–A6 (need DOM). This is where the layer
  plugs into SSIL's "mirror".
- **Versioned:** this is `rubric.v1`. When the maintainer updates the master (the Dragon Browser
  project's `UI-Critic-Rubric-v1.md`), sync this file — do NOT scatter hard-coded thresholds in code.
- **Fold direction:** later, B+C can fold into a shared product-taste standard v2 (keep `.bak`)
  as a fleet-wide standard, not just qa-gui.

---
*Source: UI-Critic-Rubric-v1 (Dragon Browser) → runtime translation for qa-gui
(`do/read/perceive/captureTab/expectNet`). Originally drafted by CASE 2026-06-22; folded into the
skill 2026-06-23.*
