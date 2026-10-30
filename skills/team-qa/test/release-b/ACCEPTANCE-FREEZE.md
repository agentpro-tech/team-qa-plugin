# Release B acceptance freeze — Team QA

Frozen before implementation on 2026-09-02 from the canonical Release B plan.

| ID | Acceptance | Paired mutation |
|---|---|---|
| TQB01 | Create a sealed handoff only from a structurally valid Team QA receipt and bind all six case/source fields. | RBQ-M01 |
| TQB02 | Re-derive the contract and record integrity; no producer prose may alter semantics. | RBQ-M02 |
| TQB03 | Reject exact SHA, requirements, or capsule drift before the consumer can mutate its run directory. | RBQ-M03–M05 |
| TQB04 | Verify a sealed Team-code acknowledgement and enforce handoff latency below 15 seconds. | RBQ-M06 |
| TQB05 | Reject an unknown field even if every known binding still matches. | RBQ-M07 |
| TQB06 | Wire handoff create/verify/ack-verify into the Team QA CLI and release package as version 1.4.0. | RBQ-M08 |

The positive path and every mutation must both be observed. A missing verifier is `UNGRADED`, never PASS.
