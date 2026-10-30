# Release C C3 acceptance freeze

Frozen before implementation on 2026-09-02.

- One immutable escaped-defect source item is compiled per incident.
- One tracked case is compiled per explicit regression binding; no title or ID inference is allowed.
- Every case keeps exactly one incident source reference and all four binding paths in machine data.
- The sealed compile receipt must report source to case edge coverage of 100%.
- Missing layer bindings, duplicate cases, trace drift, byte drift and output overwrite fail closed.
- Mutation registry: `test/release-c-escaped-defect-compile.mutations.json`.
