# Working in Team QA

This repository is a SCROLL skill. Follow `~/Dev/scroll/SPEC.md` and these repository rules.

1. Create agent folders only with `scroll new <name>`; edit source files, never generated renderings.
2. Keep persona and behavior in each agent's `SOUL.md`; keep tool implementations in `scripts/`.
3. Keep logical capabilities in `IDENTITY.md` and runtime bindings in `TOOLS.md` consistent.
4. Declare risk as machine data in IDENTITY or MCP config, never as prompt-only prose.
5. Keep at least three gold evals with fixture provenance and a planted trap per agent.
6. Use `control/approvals/` for signed plan gates and SCROLL ledger for tracked outputs.
7. Treat every verdict as `pass`, `fail`, or `ungraded`; never coerce ungraded to pass.
8. Confirm every write with a separate readback. Reject unknown fields fail-closed.
9. Do not modify or copy logic from qa-gui, qa-code, doc-colab, SCROLL, or MIXER.
10. Before handoff run check, build, eval, audit, `audit --verify`, Node 24/26 tests, and verify `test/acceptance/` is unchanged from the freeze tag.
