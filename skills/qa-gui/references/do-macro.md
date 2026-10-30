# `do` macro — full step reference

`do {tabId, steps:[...], snapshot?, form?, waitNet?, max?}` runs a chain of steps in ONE
round-trip and returns `{completed, results, reads?, asserts?, snapshot?, form?, net?}`.

- `completed` = false if a `required` step fails (chain stops early).
- `results` = per-step log.
- `reads` = map of `read` steps that had an `as` key (your custom extracted values).
- `asserts` = `assert`/`expectNet` checkpoints (for a quick PASS/FAIL roll-up).
- `snapshot` = a perceive at the end of the chain (disable with `snapshot:false` to keep it lean).

Long chains (>40s): pass `{timeout: <ms>}` in the POST body to `/rpc` (default 40s).

## Step table

| Step | Syntax | Meaning |
|---|---|---|
| click (semantic) | `{click:"Save", role?, exact?}` | Find by visible text, **climb to the clickable ancestor** (button / role=tab / menuitem / a…) → opens Radix triggers. |
| clickXY | `{clickXY:[x,y]}` | Click coordinates (trusted). Use when there's no text/selector. |
| clickSelector | `{clickSelector:"css", nth?}` | Click by CSS selector. |
| fill | `{fill:{selector,value,date?}}` | Type into a controlled input (trusted keyboard). `date:true` = type by segment. |
| select | `{select:{triggerText\|triggerSelector, search?, optionText}}` | Pick in a combobox / Radix select. |
| type | `{type:"text", selector?, nth?, clear?}` | Trusted typing into an element (or the focused one). |
| key | `{key:"Enter", modifiers?}` | Trusted key press. |
| waitFor | `{waitFor:{text\|selector, timeoutMs?}, required?}` | Wait for dynamic UI. `required:true` → stop if it fails. |
| wait | `{wait: ms}` | Hard sleep (≤8000). |
| **read** | `{read:"<js; use return>", as:"key"}` | Run JS in the page, value → `out.reads[key]`. **Subject to page CSP** like executeJs (see troubleshooting). |
| **expectNet** | `{expectNet:"pattern" \| {pattern,status?,method?,timeoutMs?,required?}}` | Assert an API call matching `pattern` (regex on URL) with `status`/`method`. Verdict-by-network. |
| **focusCycle** | `{focusCycle: ms \| true \| {ms}}` | Simulate tab blur→dwell→focus **in-page** (fires visibilitychange/focus = the refetch-on-window-focus trigger). Function-injection → **works under CSP**, no second tab needed. |
| **switchTab** | `{switchTab: ms \| true \| {ms}}` | **Real** focus cycle: activate another tab → dwell → return. Falls back to `focusCycle` if the window has no other tab. |
| assert | `{assert:{text\|selector, absent?, label?, required?}}` | Presence/absence checkpoint → goes into `asserts`. |
| if | `{if:{text\|selector}, then:[...], else:[...]}` | Branch (obstacles/optional flows). |
| repeat | `{repeat:N, steps:[...]}` | Loop a sub-sequence (≤50). |
| dismiss | `{dismiss:true}` | Smart-dismiss a modal/tour/cookie banner. |
| after (modifier) | add `after: ms` to any step | Sleep after that step. |

## Notes on `read`
- Function body: use `return ...`. Return a primitive or **JSON.stringify** an object so the
  calling script can parse it.
- A JS error returns `{__read_error: "..."}`.
- Handy reads:
  - Active tab: `const t=document.querySelector('[role=tab][aria-selected=true]'); return t?t.innerText.trim():null`
  - Input value: `return document.querySelector("input[name='search']")?.value ?? null`
  - Text present on page: `return /Order created/i.test(document.body.innerText)`

## Notes on `expectNet`
- `pattern` = regex matched against the request URL (e.g. `/api/orders`, `rpc/delete_item`).
- `status` = expected code (201 created, 200 ok, 204 no-content…). `method` = GET/POST/…
- `required:true` → if it doesn't match, `do` stops and `completed:false`.
- Network capture accumulates per tab; the macro only considers requests fired **after** `do`
  started.

## One call = one QA case (skeleton)
```
do {
  tabId,
  snapshot:false,
  steps:[
    {waitFor:{text:"Settings"}},
    {click:"Settings"},
    {waitFor:{text:"Profile"}},
    {click:"Profile"},
    {fill:{selector:"input[name='display_name']", value:"Test User"}},
    {read:"const t=document.querySelector('[role=tab][aria-selected=true]');const i=document.querySelector(\"input[name='display_name']\");return JSON.stringify({tab:t?.innerText.trim(),value:i?.value})", as:"baseline"},
    {focusCycle:1200},
    {wait:800},
    {read:"const t=document.querySelector('[role=tab][aria-selected=true]');const i=document.querySelector(\"input[name='display_name']\");return JSON.stringify({tab:t?.innerText.trim(),value:i?.value})", as:"after"}
  ]
}
```
→ compare `reads.baseline` vs `reads.after` to grade PASS/FAIL.
