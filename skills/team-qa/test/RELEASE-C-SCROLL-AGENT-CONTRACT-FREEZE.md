# Release C Team QA SCROLL agent-contract freeze

- Scope: `analyst`, `coverage-gate`, `designer`, `executor-code`, and `executor-gui` only.
- Each role keeps three product-path gold cases with `pass_consistency: 1.0`.
- Every case enforces trusted-source grounding, planted-trap rejection, and a bounded output.
- Role-specific checks grade the role's actual artifact contract instead of one shared generic answer shape.
- Positive probes must pass; five single-fault mutations must turn the frozen acceptance red.
- Implementation may update the five role source contracts, but these evals and acceptance files stay byte-identical after the freeze commit.
