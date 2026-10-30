# Source issue traceability RED proof

Date: 2026-08-28

Command:

```text
/usr/local/bin/node --test test/source-issue-traceability.test.mjs
```

Observed at the locked `team-qa` baseline: exit `1`, `ERR_MODULE_NOT_FOUND` for
`scripts/lib/source-traceability.mjs`. The tracked-plan source registry, migration, RTM/report
projection, and canonical handoff did not exist.

SHA-256 values recorded at RED:

```text
01d795c61edb2beea1a91542d9cbce1006d2161c48ab46ecc2a3ba5a9c709864  test/source-issue-traceability.test.mjs
6e7f47fe13a36ce769661dc393da25e2005b8deb58f1e148ed00fe76767bfbe5  test/fixtures/source-traceability/migration-map.valid.json
7d49a5fc185b72470556cac339c0ab3e1606dd7c3a0a15d61aa02c039d4be209  test/fixtures/source-traceability/tracked-v2.valid.json
627c512c4e31f46424146f23d8c3a2dd8caf59cb3f46eaccbd3e82e058bfe6ec  test/fixtures/source-traceability/unknown-ref.json
```

The new test and fixtures are outside frozen `test/acceptance/`.

After the RED run, the same test received additive GREEN coverage for the executable migration
command and tamper detection in RTM/report. The three contract fixtures above remain byte-identical;
the final GREEN test SHA-256 is
`86073d14a7ad8ce40a78faffd7f035ead3e5936215a00bef34517b5555b79a91`. The machine receipt keeps
the original RED hash and failure instead of relabelling later bytes as RED.
