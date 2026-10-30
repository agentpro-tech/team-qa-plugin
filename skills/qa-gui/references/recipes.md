# QA recipes — reusable E2E GUI patterns

Each recipe is a common bug/feature class plus a reliable way to grade it. These are general
patterns for any web app — swap in the app's real text/selectors/endpoints.

## 1. Display / aggregate (correct fields shown)
**Case:** a summary must HIDE fields A,B and SHOW field C (e.g. an order summary drops "Tax"
and "Shipping" and shows "Total").
**How:** navigate to the screen → one `read` step reads presence flags for each field.
```
{read:"const b=document.body.innerText; return JSON.stringify({tax:/Tax/i.test(b), shipping:/Shipping/i.test(b), total:/Total/i.test(b)})", as:"agg"}
```
PASS if `{tax:false, shipping:false, total:true}`.

## 2. CRUD + delete (verdict-by-network)
**Case:** creating/deleting a record must call the right API with the right status.
**How:** act like a user → `expectNet`.
```
{click:"Delete"}, {click:"Confirm"},
{expectNet:{pattern:"/api/items/.*", method:"DELETE", status:200, required:true}}
```
Example statuses: create → POST 201; delete → DELETE 200/204; soft-delete via RPC → POST 200.
**UX nit to note:** a list may not auto-refresh after delete (needs reload) — that's a nit, not
a failure; record it in notes.

## 3. State retained on tab refocus
**Case:** select a sub-tab + set a filter, switch to another tab and back → state must be
RETAINED (not reset).
**How:** set baseline → `focusCycle` (or `switchTab`) → re-read.
```
{click:"Active"}, {fill:{selector:"input[name='q']", value:"test"}},
{read:"...", as:"baseline"}, {focusCycle:1200}, {wait:800}, {read:"...", as:"after"}
```
PASS if `after == baseline`. (`focusCycle` works under CSP and needs no second tab; `switchTab`
is a stronger real-world check — run one extra cycle to be sure.)

## 4. Internationalization / currency / locale
**Case:** a value renders with the correct symbol/format per the selected locale or org.
**How:** `read` the rendered symbol/format, then (if needed) switch locale and re-read.
```
{read:"const b=document.body.innerText; return JSON.stringify({usd:/\\$/.test(b), eur:/€/.test(b)})", as:"cur"}
```
PASS if the symbol matches the active locale.

## 5. Form validation
**Case:** submitting with a required field missing → shows an error and does NOT call the API.
**How:** `fill` partially → `click` submit → `assert` the error shows + confirm no successful
write fired (omit `expectNet`, or assert the call is absent). Use `readForm {scope}` to capture
a dialog's fields/values/validation compactly.

## Selector / text tips
- Prefer `click` by the visible text users see (more robust than CSS). Radix triggers → `click`
  climbs to the trigger automatically.
- A filter input may change its placeholder per tab → re-read the placeholder after switching
  tabs before you `fill`.
- CSS attribute-substring `*=` is **case-sensitive** → match exact case ('item code' ≠ 'Item
  Code').
- Grade writes by network status whenever possible — it's more reliable than scraping a toast
  or waiting for a list to update.
