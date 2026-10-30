# Troubleshooting & pitfalls

## CSP blocks eval (`read` / `executeJs`)
**Symptom:** `read` returns `{__cabinet_js_error: "...unsafe-eval...script-src..."}`.
**Cause:** the page enforces a Content-Security-Policy that forbids `new Function`/eval (common
in some builder/editor UIs).
**Fix:**
- On a CSP-locked page, use **function-injection** actions (no eval): `perceive`, `click`,
  `fill`, `type`, `focusCycle`. They run via `chrome.scripting.executeScript({func})`, which
  doesn't violate CSP.
- If you need to READ state with JS (`read`), do it on a page that allows eval (e.g. the
  deployed/preview build) rather than the locked editor.

## Synthetic-DOM reads denied (`SYNTHETIC_FORBIDDEN` → `CIRCUIT_OPEN`)
**Symptom:** the first `{read:"<js>"}` step comes back denied; from then on **every** call to that
session returns `CIRCUIT_OPEN`. If your client only checks the outer envelope you see none of
that — instead you get `SWEEP: null` (and, on a fail-open client, a PASS), or a misleading
`setViewport: Either tab id or extension id must be specified` from an `openTab` that never
returned a `tabId`.
**Cause:** Dragon's default session policy is `forbidSyntheticDOM:true`. Every ui-sanity / a11y
sweep in this skill is a synthetic-DOM read, so the default policy denies all of them, and the
first denial latches the session circuit breaker.
**Fix:**
- Create the session yourself and verify the answer:
  `session.create {sessionId:"qa-<case>", forbidSyntheticDOM:false}` — then assert
  `forbidSyntheticDOM === false` on the reply rather than assuming it was honoured.
- Send `nonce` **and** `browserInstanceId` together on **every** call. `nonce` alone ⇒
  `explicitBinding` + `browserMismatch` ⇒ `SESSION_MISMATCH`.
- To clear an already-latched breaker: `session.acknowledge` with the **exact** violating
  `actionId`; nothing else reopens it.
- Treat a denial as **FAIL**, not UNGRADED. UNGRADED is only for "no Dragon at all" (transport
  unreachable). Reference harnesses: `.teamcode/dragon-e2e.mjs`, `.teamcode/p5/p5-dragon-e2e.mjs`.

## 🚨 Reloading the extension orphans chrome.debugger
**Symptom:** after reloading the Dragon extension (to pick up new code), `Input.dispatchMouseEvent
timed out 5000ms` — every `click`/trusted-mouse hangs, but `read`/`focusCycle`/`perceive`
(executeScript func) still work.
**Cause:** the reload drops the `chrome.debugger` attach session; the mouse domain is orphaned.
**Recovery:** open a **NEW tab** (`openTab`) **+ `setActiveTab` to it** → clean debugger attach.
- `reloadTab` is NOT enough.
- Opening a new tab without making it active can still time out → remember to set it active.
**Avoid:** don't reload the extension repeatedly in one session; reload only when you truly need
new extension code, then open a fresh tab to continue.

## RPC call escaping (from a sandboxed environment)
If the assistant's sandbox can't reach the host's `localhost:9233`, route the call through the
host-shell bridge. Nested JSON quoting through such a bridge breaks easily:
- **One host-shell statement per call** where the bridge compiles a script (e.g. AppleScript via
  osascript): multiple statements in one compile can fail to compile and run nothing. Keep it to
  one statement, or separate calls.
- **Most robust for complex `do`:** write the payload + logic into a **Node script run on the
  host** (`scripts/qa_do.mjs`) and invoke that — Node parses JSON natively and avoids escaping.
  Invoke with whatever `node` is on the host's PATH.
- **`Dragon bearer token is missing`:** `qa_do.mjs` checks `DRAGON_RPC_TOKEN`, then
  `DRAGON_RPC_TOKEN_FILE`, then `~/.dragon-browser/auth/service-token`, then the legacy
  `~/.dragon-browser/auth/token`. Configure one of those locations and retry; never paste the
  token into a payload or diagnostic output. The command fails before contacting Dragon when no
  token is available.
- If you must inline JSON, consider writing the payload to a temp file and `curl -d @file`.

## perceive doesn't see contenteditable contents
**Symptom:** you type into a rich-text/contenteditable field, then `perceive`, but the element's
name doesn't contain the text.
**Cause:** `perceive` uses aria-label/innerText for NAME; it doesn't reflect contenteditable
value.
**Fix:** verify with a **screenshot** (`captureTab`) before pressing Send/Submit.

## Sandbox filesystem ≠ host filesystem
Files created in the assistant's sandbox (`/tmp`, outputs) don't exist on the host. Any script
that needs the Dragon RPC must run ON the host. Keep the bundled `scripts/` with the skill and
run them from there on the host.

## listTabs / openTab shapes
`listTabs` returns `{result:{tabs:[{tabId,url,...}]}}` (the id key may be `tabId` or `id`
depending on the build) — parse for both. `openTab` returns `{result:{tabId}}`.

## Login / permissions
- Never type passwords or submit an auth form on the user's behalf — ask them to log in.
- Test app + the user's permission → creating/editing/deleting test data is fine. Production app
  → ask before any irreversible write/delete.
