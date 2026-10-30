# QA Code release receipt v2

Schema: `qa-code/receipt/v2` from frozen contract SHA-256
`77433f4c204e7f32848976b585cfb901152f97b775726467a0a5128eb3ec362c`.

V2 is emitted only when Gate 0 receives a locked `requirements.freeze/v2` graph. Standalone
runs without that graph retain the v1 receipt unchanged. A structurally valid v1 receipt is
legacy-readable and reports `CAPABILITY_MISSING:release-truth-v2`; it cannot close a v2
customer-ready decision.

## Required bindings

The receipt binds the contract, `run_uuid`, physical repo, frozen `task_base`,
`source_revision`, current `head`, canonical requirements hash, and verification lane `code`.
Every code/multi requirement must have an atomic row with its own `requirement_id`,
`assertion_id`, executed check, evidence path, evidence SHA-256, and result.

Normal behavior changes use `fail_to_pass[]` plus `pass_to_pass[]`. A frozen non-change
invariant may instead use `mode:"preservation"`, `preservation[]`, and `pass_to_pass[]`, but only
when that requirement's frozen `evidence_contract.allowed_types` includes `diff-proof`.
Preservation evidence must pass on both TASK_BASE and HEAD; a changed or already-broken invariant
cannot be counted as covered.

`receipt-verify.mjs` requires the matching Gate 0 file plus the current repo/base. It reads the
graph and sibling `LOCK.json` again, verifies evidence bytes, and returns `RECEIPT_STALE` when
the current HEAD no longer equals the receipt head.

```bash
bash scripts/gate0.sh --repo <repo> --base <TASK_BASE_SHA> \
  --requirements <repo>/brief/REQUIREMENTS.json \
  --config <repo>/qa-code.config.json --json gate0.json

bash scripts/qa-run.sh --repo <repo> --base <TASK_BASE_SHA> --mode tools \
  --gate0 gate0.json --json verdict.json --receipt qa-code.receipt.json

node scripts/receipt-verify.mjs --receipt qa-code.receipt.json \
  --gate0 gate0.json --repo <repo> --base <TASK_BASE_SHA>
```

Any missing atomic row, evidence hash mismatch, source/graph/LOCK mismatch, unlocked skipped
layer, or tampering is fail-closed. Once tampering is observed, the run UUID is sealed by a
marker beside Gate 0 and cannot later emit PASS from the same run.
