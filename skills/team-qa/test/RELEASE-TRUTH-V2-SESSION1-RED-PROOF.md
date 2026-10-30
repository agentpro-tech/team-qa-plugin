# Release Truth v2 Session 1 — Team QA RED proof

- Baseline: `f1790f0e3a9ed684e9c74d9d395baa69e9ca4738`
- Shared contract owner commit: `28a52aac65fe5a5b21468b054ff95e7dc85b560a`
- Contract digest: `949033749b2d10a4fd101500e7521ebeb3c7b5433ad845e7ddd5deb9e1604114`
- Command: `node --test test/release-truth-v2-session1.test.mjs`
- Result before implementation: exit `1`, tests `6`, pass `0`, fail `6`.

Observed RED causes:

- I4: report verification stops at a missing summary instead of naming 29 blank RTM verdicts.
- I16: `receipt create|verify` does not exist.
- I17: `board seed` does not exist, so the first planned verdict path cannot run.
- TQa: there is no pre-execution completeness gate tied to tracked-plan.
- TQd: schema omits `pending` and `blocked` while the handwritten validator accepts `blocked`.
- TQe: requirement-lane coverage verification does not exist.

The incident fixture is scrubbed and contains no credential, customer data, or Product implementation logic.

## Isolated package install RED

- Command: `node --test test/release/package-install-compat-root.test.mjs`
- Expected result before fix: **FAIL**
- Cause: compatibility links were fixed under the official user runtime, so a local package install
  could not be rehearsed without mutating that runtime.

## Verifier dependency RED

- Package rehearsal: `/private/tmp/team-qa-session123-package.JeIQzP`
- Result before fix: package build succeeded, install failed.
- Exact error: `ERR_MODULE_NOT_FOUND` for envelope file `release-policy.mjs` imported by
  `release-truth-gate.mjs`.

The package copied the canonical verifier but omitted its required adjacent policy module, so the
release-truth check could not start during install.
