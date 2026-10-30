# Frozen Loop-Up RED checkers

These ten tests encode the approved Team QA dogfood gaps. They are expected to fail on frozen base `b8945e16a23ce3a62b881e4376555e47782c6801`.

- Do not weaken, delete, skip or rewrite them during Loop-Up.
- A checker only turns green by implementing the stated observable contract.
- Product defects are not represented here; these are Team QA harness/integration contracts.
- `ba-mo.md` must deny edits to this directory.

Run:

```bash
node --test test/loop-up-red/teamqa-dogfood-red.mjs
```
