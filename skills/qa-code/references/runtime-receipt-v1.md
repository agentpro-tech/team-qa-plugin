# Runtime receipt v1

`PASS` for auth, permission, or migration changes requires a live readback receipt bound to the
same final commit and immutable task baseline as Gate 0.

```json
{
  "schema": "qa-code/runtime-receipt/v1",
  "commit": "<gate0.commit>",
  "task_base": "<gate0.base>",
  "environment": "TEST",
  "target": "<exact deployment/database ref>",
  "capturedAt": "2026-08-11T03:10:00Z",
  "checks": {
    "legacy_identifier_audit": {
      "source": "tracked-source scan command/receipt",
      "forbidden": ["quality_control.manage", "quality_control.execute"],
      "matches": []
    },
    "migration_readback": {
      "source": "live migration ledger query",
      "expected": ["<migration id>"],
      "actual": ["<migration id>"]
    },
    "permission_readback": {
      "source": "live permission table/RPC query",
      "expected": { "staff": ["qc.record.view"] },
      "actual": { "staff": ["qc.record.view"] }
    },
    "rls_readback": {
      "source": "live policy catalog plus own-token probe",
      "expected": ["<policy/result contract>"],
      "actual": ["<policy/result contract>"]
    }
  }
}
```

The validator compares expected and actual structurally with sorted object keys. Permission/auth
requires legacy identifier, permission, and RLS checks; migration additionally requires migration
ledger and RLS checks. Any missing check, legacy match, binding mismatch, or expected/actual drift
rejects the verdict.
