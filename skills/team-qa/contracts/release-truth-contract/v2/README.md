# Release Truth Contract v2

Owner: Team-code.

The contract digest is the SHA-256 of the canonical JSON map from schema name to schema SHA-256. Artifact validators must compare each artifact's `contract_sha256` with that digest; a schema's own pattern check is not a substitute for this comparison.

Every v2 atomic coverage row binds `requirement_id`, `case_id`, `assertion_id`, and the exact evidence bytes. The case must belong to the frozen requirement acceptance registry.

Migration rules:

- `requirements.freeze/v1` must be regenerated as v2; a v1 graph is compatibility-readable only and cannot contribute to customer-ready.
- `qa-code/receipt/v1` and `qa-gui/receipt/v1` are compatibility-readable only; they report missing v2 capability and cannot contribute to customer-ready.
- `team-qa/receipt/v1` is introduced by this contract and must seal plan, tracked plan, board ledger, RTM, and summary.
- `team-code/release-receipt/v1` remains readable for historical releases; only v2 may create `CUSTOMER_RETEST_READY`.
- `team-code/customer-ready-receipt/v1` has no handwritten migration path; it can only be emitted from a verified release receipt v2.

The file `CONTRACT.json` is generated after hashing all six schemas and freezes their exact names, versions, allowed migration paths, and SHA-256 values.
