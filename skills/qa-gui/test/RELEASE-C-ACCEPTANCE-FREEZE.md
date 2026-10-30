# Release C C2 acceptance freeze

Frozen before implementation on 2026-09-02.

- The state-machine definition supplies the denominator; every declared transition must have one run.
- Every state has one exact case/build-bound `qa-gui/state-receipt/v1` receipt.
- Every state receipt carries all six lifecycle phases and machine evidence references.
- Missing transitions, foreign cases, lifecycle gaps, transition drift and unexplained screenshot reuse fail closed.
- Mutation registry: `test/release-c-transition-corpus.mutations.json`.
