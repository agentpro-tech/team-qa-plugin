# Source issue traceability RED proof

Date: 2026-08-28

Frozen command:

```text
node --test test/source-issue-traceability.test.mjs
```

Observed before implementation: exit `1` with `ERR_MODULE_NOT_FOUND` for
`scripts/teamwork/source-traceability-migration.mjs`. This proves the approved migration and
traceability contract did not exist at the locked qa-gui baseline.

Fixture/test SHA-256 values recorded at RED:

```text
de1996a4f1562202ba577c75e602887bf2ea94b2b5f4bbc38d36838ae165d3fb  test/source-issue-traceability.test.mjs
1d77b20de1a1691916c8cadba132839f7f649f2b9618cbbbffc310ebc7d258a3  test/fixtures/source-traceability/canonical-v6.unknown-ref.json
cd2d39b5ca3008da7cdd5a7a959969483d78a32ac27e00f792b3b381d5129599  test/fixtures/source-traceability/canonical-v6.valid.json
1dcf6c03c31ad20b269df7ee69c698aec5ae8bf7104e8dec73766f5872d17a90  test/fixtures/source-traceability/migration-map.valid.json
```

The test is additive and does not modify legacy fixtures.

After the RED run, the test harness received a path-only correction and additive GREEN cases for
the seed boundary; the three RED fixtures remained byte-identical. The final GREEN test SHA-256 is
`189c31e4247d393d1b543dcb859a3211a00a980899fb5428fe55738b15220b8c`. The machine-readable RED
receipt below preserves the original failure and hashes instead of presenting the later test bytes
as frozen RED bytes.
