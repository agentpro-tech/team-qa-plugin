# Session 3 release-truth v2 GREEN proof

- Captured at: `2026-08-25T06:07:13Z`
- Canonical source baseline: `06f94e9964a95186073a9f905d18c02c78279887`
- Local branch: `codex/release-truth-v2-session3-local-20260825`
- Frozen contract digest: `949033749b2d10a4fd101500e7521ebeb3c7b5433ad845e7ddd5deb9e1604114`
- Frozen `CONTRACT.json` byte SHA-256: `7437ec1d365fb43ce5f61b270caf191a75ccc5dece05ead32f62c5f7c91dca36`
- Release status: `LOCAL_ONLY / UNGRADED_RELEASE`

## GREEN gates

1. `node --test --test-concurrency=1 test/session3-release-truth-v2.test.mjs`
   — **11/11 PASS**.
2. `node --test --test-concurrency=1 test/session3-mutation.test.mjs`
   — **1/1 PASS**, killing five live bypasses: GUI denominator, physical evidence,
   evidence type, vision/risk, and dwell.
3. `npm run test:release-truth`
   — **28/28 PASS** from the clean package mirror.
4. `npm test`
   — **115/115 PASS** outside the filesystem/network sandbox. The first sandboxed run had nine
   localhost-only `listen EPERM 127.0.0.1` failures; the identical suite passed when localhost was
   permitted.
5. `git diff --check`
   — PASS.
6. Package manifest verification
   — PASS before this proof was added; the manifest must be regenerated once more before the final
   local package is considered current.

## Covered incident fixtures

- I3 — frozen plan plus exact GUI/multi denominator and exact missing IDs.
- I5 — exhaustive missing evidence list and no receipt issuance.
- I6 — display PASS cannot use `db-readback`.
- I11 — `applicationLoginNotReached` forces aggregate UNGRADED.
- I13 — C10-C16 plus requirement-specific hidden-identity/ordered-projection assertions.
- I14 — task base, source revision, and lane bindings.
- I19 — traversal, symlink escape, and forged metadata commit.
- I20 — risk-scoped 120-second dwell, repeated GET failures, and synchronous exemption.
- QGg — v2 issuance/verification/stale rejection plus v1 compatibility-read.

No source commit, push, PR, merge, official runtime install, product app change, DB write, or
Production action was performed.
