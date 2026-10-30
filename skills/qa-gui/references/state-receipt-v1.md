# State receipt v1

Every schema v3+ settled state has exactly one JSON receipt listed in both
`cases[].stateReceipts` and `cases[].evidence`.

For teamwork schemas 4/5/6, the receipt also binds atomic requirements and raw write/readback
evidence used by Release Truth 2.7. Schema 3 keeps its historical assertion keys for compatibility;
schemas 4/5/6 use the keys shown below.

```json
{
  "schema": "qa-gui/state-receipt/v1",
  "caseId": "TC-01",
  "state": "after-submit",
  "capturedAt": "2026-08-11T03:10:00Z",
  "url": "https://test.example/qc",
  "build": "<exact deployed commit/build>",
  "viewport": "1280x800",
  "domHash": "<sha256 of the machine-measured settled DOM>",
  "dragon": {
    "sessionId": "<session>",
    "actionId": "<action/flow>",
    "browserInstanceId": "<browser>",
    "tabId": "<tab>",
    "innerOk": true
  },
  "screenshot": {
    "path": "qa-evidence/<app>/round-1/1280x800/after-submit.png",
    "sha256": "<64 lowercase hex>"
  },
  "function": {
    "verdict": "PASS",
    "assertions": [
      { "requirement_id": "REQ-SAVE-01", "verdict": "PASS", "evidence_ref": "evidence/save-readback.json" }
    ]
  },
  "ui": {
    "verdict": "PASS",
    "uiSanity": { "id": "ui-sanity", "verdict": "PASS", "evidence": "raw sweep output" },
    "a11y": { "id": "a11y", "verdict": "PASS", "evidence": "raw sweep output" },
    "console": { "id": "console", "verdict": "PASS", "evidence": "raw console output" },
    "network": { "id": "network", "verdict": "PASS", "evidence": "raw network output" }
  },
  "preflight": { "id": "preflight", "verdict": "PASS", "evidence": "raw preflight output" },
  "network": [
    { "method": "POST", "url": "https://test.example/api/save", "status": 200 }
  ],
  "readback": {
    "value": { "status": "saved" },
    "evidence_ref": "evidence/save-readback.json"
  },
  "lifecycle": {
    "before": { "verdict": "PASS", "evidence_ref": "evidence/before.json" },
    "action": { "verdict": "PASS", "evidence_ref": "evidence/action.json", "writes_data": true },
    "network": { "verdict": "PASS", "evidence_ref": "evidence/network.json", "expect_net": true },
    "readback": { "verdict": "PASS", "evidence_ref": "evidence/save-readback.json" },
    "refresh": { "verdict": "PASS", "evidence_ref": "evidence/refresh.json" },
    "postcondition": { "verdict": "PASS", "evidence_ref": "evidence/postcondition.json" }
  }
}
```

Behavioral cases require all six lifecycle phases. The gate derives the case kind from mutating
network methods and lifecycle flags, derives Function/UI from the raw assertions, verifies every
`evidence_ref` against the board `evidenceManifest`, and compares board-authored verdicts with the
computed result. Any FAIL wins; any missing/UNGRADED makes the result UNGRADED.

When `equivalentTo` reuses identical screenshot bytes, both receipts must have the same `domHash`
and the later receipt must name the earlier `<caseId>:<state>`. A prose reason without DOM hash
equality is rejected.
