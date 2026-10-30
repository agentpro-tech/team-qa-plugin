# QA code grading rules

Return exactly one JSON object following the target block at the end of this document. Do not add Markdown around the JSON.
Use only the spec, acceptance, build report, diff and source provided as the yardstick.

## Independence of the evidence sources

- Read the raw source (original source code) and the diff as the main yardstick; do not infer results from the coder's account.
- `build-report` is only a claim to be checked again against source/tools, not trusted evidence.
- A previous-round PASS or an old verdict is only untrusted evidence until a machine binds it to the right TASK_BASE and HEAD.
- The QA vendor must differ from `coder_vendor` in `.teamcode/spec.md` or `.teamcode/spec.json`; the same vendor is `UNGRADED` under HR3.

## Finding severity

| Severity | Defect group | Handling |
|---|---|---|
| A | Wrong acceptance result; serious security hole; wrong authorization | P0, blocks merge; `file`, `line`, `evidence` required |
| B | Swallowed error on the main flow; resource leak; a test that checks nothing | P1, must be fixed; `file`, `line`, `evidence` required |
| C | Hard to maintain; duplication; function too long | Recorded, does not block |
| D | Naming, style, format | Not graded; the linter is responsible |

`evidence` is 1–3 lines long. The verdict is `FAIL` while an A/B finding remains; otherwise it follows the mode ceiling.

## The eight ODC types

| `defect_type` | Meaning |
|---|---|
| `assignment` | Wrong data assignment or initialization |
| `checking` | Missing or wrong check |
| `algorithm` | Wrong algorithm, formula or logic |
| `timing` | Order, concurrency, race |
| `interface` | Wrong contract between modules/APIs |
| `function` | Missing functionality or wrong behavior |
| `build` | Wrong build, configuration or packaging |
| `documentation` | Documentation that leads to misunderstanding or misuse of behavior |

## Required security sweep

Declare all of S1–S5; each item is only `PASS`, `DEFECT` or `NOT_APPLICABLE`. An item declared `DEFECT` must have
an accompanying A/B finding.

If the diff touches a risk area and an item is declared `NOT_APPLICABLE`, add `sweep_explanations.<Sx>` and
point to the exact file path in the diff; without a file address the validator rejects the verdict.

| Code | Must check |
|---|---|
| S1 | External input is validated before queries, commands, paths |
| S2 | Endpoints/functions check the right role and the right data owner, including IDOR |
| S3 | Secrets/tokens are not hardcoded and do not leak into logs |
| S4 | Errors returned outside do not expose stack traces or system details |
| S5 | Passwords, tokens and sensitive data are not exposed in plain form in responses/logs |

## Ceiling by mode

| Mode | Permissions and ceiling |
|---|---|
| `tools` | May use read-only tools and run tests; highest is `PASS` |
| `static` | Uses only the material in the prompt, no tools; highest is `PASS-STATIC` |

In `static` mode, a suspicion about role-based authorization, session/auth or concurrency/race that is not certain enough
must go into `concerns`, not be concluded as an A finding. The `mode` field must equal the mode required in the
grading run context. Do not write or modify files; proposed tests go into `proposed_tests`.

## Target JSON

```json
{
  "schema": "qa-code/verdict/v1",
  "verdict": "PASS | PASS-STATIC | FAIL | UNGRADED",
  "mode": "tools | static",
  "engine": "engine-name-and-version",
  "commit": "SHA-of-Gate-0",
  "findings": [
    {
      "id": "F1",
      "severity": "A | B | C",
      "defect_type": "assignment | checking | algorithm | timing | interface | function | build | documentation",
      "file": "path/in/repo",
      "line": 1,
      "evidence": "specific evidence"
    }
  ],
  "concerns": ["point without enough evidence to conclude"],
  "proposed_tests": ["test that should be added, without writing the file yourself"],
  "sweep": {
    "S1": "PASS | DEFECT | NOT_APPLICABLE",
    "S2": "PASS | DEFECT | NOT_APPLICABLE",
    "S3": "PASS | DEFECT | NOT_APPLICABLE",
    "S4": "PASS | DEFECT | NOT_APPLICABLE",
    "S5": "PASS | DEFECT | NOT_APPLICABLE"
  },
  "sweep_explanations": {
    "S2": "src/auth/session.ts only changes a comment, not the role check"
  }
}
```
