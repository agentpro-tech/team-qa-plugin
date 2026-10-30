# QA GUI release receipt v2

The v2 receipt is issued only by a schema-5 run bound to the exact frozen requirement graph,
tracked plan, Git checkout, and evidence root:

```bash
node scripts/qa-gate.mjs <board.json> \
  --plan <tracked-plan.json> \
  --requirements <REQUIREMENTS.json> \
  --repo <git-checkout> \
  --evidence-root <run-root>
```

Canonical output:

`.teamcode/runs/<run_uuid>/receipts/qa-gui.receipt.json`

The payload schema is the byte-frozen
`contracts/release-truth-contract/v2/qa-gui.receipt.schema.json`. It binds:

- contract digest, frozen task base, source revision, current exact Git SHA, requirements hash,
  and the fixed `gui` lane;
- one atomic row per requirement assertion, including evidence path, hash, type, and result;
- the complete evidence manifest with run/task/commit/case/state/time metadata;
- execution status and semantic verdict as separate values;
- an integrity digest over canonical key-sorted JSON with only `integrity` removed.

Every manifest path must be canonical and relative to the supplied run root. Traversal, symlinks,
missing or non-regular files, hash drift, or metadata drift prevents receipt issuance. A semantic
FAIL or UNGRADED may still produce a v2 receipt when the physical evidence chain itself is valid.

Verify before finalization:

```bash
node scripts/receipt-verify.mjs \
  --receipt <qa-gui.receipt.json> \
  --repo <git-checkout> \
  --requirements <REQUIREMENTS.json> \
  --evidence-root <run-root>
```

The verifier reads back the contract and sibling `LOCK.json`, checks current HEAD, re-hashes all
evidence, and recomputes the GUI/multi-lane denominator. A moved HEAD returns `RECEIPT_STALE`.
Legacy `qa-gui/receipt/v1` remains readable but reports
`CAPABILITY_MISSING:release-truth-v2`; it cannot close a v2 customer-ready chain.
