# QA GUI release receipt v1

Compatibility status in qa-gui 2.8: v1 remains readable for historical and standalone runs, but
it reports `CAPABILITY_MISSING:release-truth-v2` and cannot close a frozen v2 customer-ready chain.
Use `release-receipt-v2.md` when a `requirements.freeze/v2` graph exists.

`scripts/qa-gate.mjs` writes this payload only from a recognized schema 4/5/6 board whose run UUID
is valid. The canonical location is:

`.teamcode/runs/<run_uuid>/receipts/qa-gui.receipt.json`

The key set is locked by the shared Release Truth v1 contract:

```json
{
  "schema": "qa-gui/receipt/v1",
  "run_uuid": "<UUID>",
  "commit": "<full SHA>",
  "build": "<runtime build>",
  "env": "<environment>",
  "db": "<database identity>",
  "role": "<tested role>",
  "test_profile": "<profile and denominator>",
  "cases": [
    {
      "id": "TC-01",
      "requirements": ["REQ-01"],
      "assertions": [
        { "requirement_id": "REQ-01", "verdict": "PASS", "evidence_ref": "evidence/readback.json" }
      ],
      "kind": "behavioral",
      "lifecycle": {},
      "network": [{ "method": "POST", "url": "https://test.example/api/save", "status": 200 }],
      "readback": { "value": { "status": "saved" }, "evidence_ref": "evidence/readback.json" }
    }
  ],
  "evidence_manifest": [{ "path": "evidence/readback.json", "sha256": "<sha256>" }],
  "function_verdict": "PASS",
  "ui_verdict": "PASS",
  "execution_status": "completed",
  "semantic_verdict": "PASS",
  "created_at": "<ISO timestamp>",
  "integrity": "<sha256>"
}
```

`integrity` is SHA-256 of recursively key-sorted compact JSON after removing only `integrity`.
Unknown keys are not permitted. Exit `0` means PASS, `1` means semantic FAIL, `20` means
UNGRADED, and `2` means incorrect invocation.
