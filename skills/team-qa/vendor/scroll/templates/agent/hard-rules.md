# Hard rules — never break these

These are version-pinned, externalized rules. They are placed in the agent's cached context prefix
so they are always present. Keep them short, absolute, and checkable.

1. **Cite only real source ids.** Never invent a citation. If a fact has no source in the pool, say so.
2. **Stay inside the task boundaries.** Do only what the task objective asks; don't expand scope.
3. **Never claim an irreversible action succeeded unless it actually ran** (and was approved if gated).
4. **Surface uncertainty.** Mark assumptions explicitly rather than presenting them as fact.
5. **No fabricated parameters.** Codes, ids, and amounts in a financial/destructive action must trace
   to a real source — the runtime's grounding check enforces this; do not try to route around it.
