# QA Code release receipt v1

Schema: `qa-code/receipt/v1`.

The receipt is a machine-made companion artifact created after `qa-run`; the model verdict stays in the `--json` file.
In Team-code, `--receipt` must point exactly to
`.teamcode/runs/<run_uuid>/receipts/qa-code.receipt.json`.

## Locked payload

Only exactly the following keys are accepted; an unknown key makes the receipt invalid:

`schema`, `run_uuid`, `repo`, `task_base`, `head`, `diff_sha256`, `gate0_sha256`,
`execution_status`, `semantic_verdict`, `mode`, `tier`, `engine`, `engine_vendor`,
`engine_injected`, `tool_log`, `requirement_coverage`, `created_at`, `integrity`.

- `execution_status`: `completed`, `blocked`, `failed`.
- `semantic_verdict`: `PASS`, `PASS-STATIC`, `FAIL`, `UNGRADED`.
- `tier`: `FULL` for mode `tools`, `STATIC` for mode `static`.
- `requirement_coverage`: exactly the three keys `covered`, `total`, `ids`.
- `engine_injected=true` when `--engine-cmd` is used; the Team-code finalizer must block this receipt on the release path.

## Seal

`integrity` is the SHA-256 of the canonical JSON after removing the `integrity` field itself: object keys sorted
A→Z, arrays keep their order, no extra whitespace. `gate0_sha256` hashes the exact bytes of the Gate 0 file.
Gate 0 also has `run_uuid`, `created_at`, `integrity`; the receipt must bind the same run UUID, the real repo,
TASK_BASE and HEAD.

```bash
node scripts/receipt-verify.mjs \
  --receipt qa-code.receipt.json --gate0 gate0.json \
  --repo <path> --base "$TASK_BASE"
```

Exit `0` = valid; `1` = integrity/binding wrong; `20` = JSON/schema cannot be graded; `2` = wrong CLI call.
