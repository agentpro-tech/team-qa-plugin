# Exact scanner finding adjudication v1

Gate0 always retains the original scanner JSON, SHA-256, scanner status and applicable
added-line findings. Its private archived raw report is mode0600. A scanner FAIL remains
FAIL in `layers.secret.status` and `raw_scanner.status`; only a verified exact reviewed
decision can add `effective_status: "pass"`. No ignore list or caller-supplied PASS exists. Final verdict aggregation, coverage-baseline
eligibility and failure summaries use the same effective result after independent proof
readback; a failed or stale proof retains blocking raw FAIL.

The only config input is an already completed independent review proof:

```json
{"secret":{"adjudication":{"proof":"/absolute/completed-child-proof.json","runtime":"/absolute/verified-team-qa-package"}}}
```

`runtime` is optional and otherwise uses the existing verified installed TeamQA package.
An absent/unreadable runtime or canonical anchor returns a TEAMQA domain denial with
the original I/O cause; it cannot authorize a review or clear raw scanner FAIL.
Unknown keys or a decision/status supplied in config are invalid. This input grants no
reviewer approval. The existing TeamQA post-proof verifier must reread the canonical package,
approved roster/role, exact repo/base/HEAD and reviewer independence from the coder. Actual
provider execution must match its observed model/effort/session, have tool evidence, and
contain the decision as its final JSON. Supported existing provider routes are unchanged;
this feature adds no native Code dispatch protocol or fabricated role/approval event.

## Reviewer final JSON

Exact root fields:

`schema`, `repo`, `base`, `head`, `report_sha256`, `findings`.

Schema is `qa-code/secret-adjudication/v1`. Repo is the physical repo path; base/head and
raw-report bytes are exact. Every raw reportIndex appears once, including ignored files
and findings outside the added diff. Each row has these exact fields:

`reportIndex`, `fingerprint`, `finding_sha256`, `file`, `blob_oid`, `blob_sha256`, `line`,
`line_sha256`, `classification`, `rationale`, `evidence`, and `oracle` only where needed.

`finding_sha256` hashes the full raw finding with recursively sorted object keys; arrays
retain their order. Raw absolute scanner paths are normalized only inside the exact repo;
traversal/outside paths reject. The raw finding and raw report are never rewritten.

Applicability is calculated from Git's pinned base→HEAD added lines before source lookup.
Every nonapplicable row must be `out_of_scope`, have null blob/line hashes, empty evidence,
and no oracle. The receipt pins the diff hash. This records existing T1 scope without
pretending ignored `.env`/`dist` have Git blobs, or declaring their values benign.

Applicable findings require exact current tracked Git blob OID and SHA-256, source line
SHA-256 and matching raw file/line/fingerprint/finding hash. Source bytes differing from
HEAD reject. Each evidence entry is `{file, blob_sha256, line, line_sha256}` and is reread
against current tracked source. Rationale must be specific and at least20 characters.

Supported classifications:

- `public_deterministic_id`: explicit oracle `{encoding: "utf8-length-prefix-sha256",
  prefix, inputs}`; length-prefixed UTF8 inputs reproduce the exact public p1 ID. Every
  input is a source-backed public string literal, with evidence from a separate source
  file. Private/credential-shaped inputs and assignment as an API credential cannot clear
  the finding. Existing app literal oracles stay unchanged.
- `nonassigned_test_prose`: exact ordinary English phrase inside a test title, with bound
  source evidence; credential assignments do not qualify.
- `nonassigned_prose`: exact ordinary English phrase/word sequence in a Markdown paragraph,
  outside code, inline code and HTML, with bound evidence; assignments do not qualify.
  This covers the real `disabled/missing/wrong` documentation finding without rewriting it.
- `sql_environment_reference`: rollback-only tracked SQL test configuration containing an
  environment variable name, with active scoped-resolver metadata storage and the pinned
  actual imported receiver chain `secret_ref` → environment lookup → decoded signing
  bytes → returned signing scope → HMAC verification. Reference names and generations
  are parameters; unknown field/argument roles, aliases, signing uses, inert declarations
  and an unused correct helper with a different active signing path remain blocking.
- `sql_rollback_replay_nonce`: rollback-only tracked SQL test using the same literal as
  the second argument of two nonce claims with opposite first-accept/replay-reject
  assertions, an independently derived public key ID and an active nonce-ledger consumer.
  Unknown argument roles, missing opposite assertions, signing use, changed ledger
  consumption or missing rollback remain blocking.
- `actual_secret` or `uncertain`: applicable findings remain blocking.
- `out_of_scope`: only machine-derived nonapplicable rows, as above.

Redacted historical reports cannot establish the exact source value required for benign
classification. Obtain a fresh private scanner report bound to the actual current source;
historical classifications and local calibration are not a current independent post proof.

## SQL role and reader compatibility

The two SQL classifications add values to the existing v1 `classification` field; they
add no fields, oracle format, caller approval or proof/dispatch route. Older readers
reject these unknown values; an official review must pin a package containing this
reader and its exact Git/source bytes. It must still complete the independent post proof.

The recognizer deliberately supports a closed source grammar, not arbitrary SQL/TS.
Template interpolation is unsupported and fails closed; DO bodies are recognized without
case sensitivity. Receiver import/helper identifiers must have only the required bound
uses; local shadow declarations cannot stand in for actual HMAC consumption.
Comments, quoted strings, template strings and nonexecuted dollar-quoted SQL cannot
supply active consumer evidence. Complete tracked Git consumers and active argument,
metadata, import and cryptographic call binding are required. Unknown syntax or roles
remain blocking. Quoted SQL execution is limited to the existing fixed local-role
switches and bounded anon/authenticated role loop; other EXECUTE, TS eval and dynamic
Function consumers reject. A whole-consumer hash alone is not a material-role proof. Local fixture
calculations do not clear any current scanner report or create a review approval.

## Reader admission

Gate0 stores calculated safe metadata, decision hash and actual proof/attestation hashes.
The qa-harness entry, verdict validator and release receipt reader independently reread
source, raw report and post proof, then compare the full calculated receipt. Resealing a
caller-edited Gate0 `effective_status`, stale source or altered report cannot admit it.
A previous successful decision is not cached across commits or evidence changes.

`evaluateSecretAdjudication` is only a machine calculation, with no review/approval field.
Only `verifySecretAdjudication` checks actual independent post-proof provenance. Fixture
classification PASS is not an official adjudication, QA grade or Production acceptance.

Local checks:

```sh
node --test test/secret-adjudication.test.mjs
```

Use an actual `QA_CODE_GITLEAKS_FIXTURE_BINARY` to verify raw FAIL preservation. Tests cover
every finding, ignored rows, exact source/report/fingerprint drift, secret misclassification,
Markdown code/HTML negatives, missing/forged proof and all three reader boundaries.
