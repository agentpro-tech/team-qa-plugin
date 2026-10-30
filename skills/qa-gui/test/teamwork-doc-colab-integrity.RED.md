# Doc-Colab renderer integrity gate — RED proof

- Baseline: `6958a031b32c7747d324faae4d7259976c4f454a`
- Command: `node --test test/teamwork-doc-colab-integrity.test.mjs`
- Result before implementation: `0 pass / 2 fail`, exit `1`
- Gap: the renderer returned success after generation without calling Doc-Colab's external
  verifier, so a rejected/tampered artifact could not fail the QA render path.

Mutation proof: bypassing the post-render verifier made both frozen tests fail; restoring the
verifier returned `2 pass / 0 fail`.

QA-code fix-loop mutation: restoring the original unanchored `verdict=pass` substring check made
the misleading-diagnostic regression turn red (`4 pass / 1 fail`). Restoring the machine-line
parser returned the integrity suite to green.
