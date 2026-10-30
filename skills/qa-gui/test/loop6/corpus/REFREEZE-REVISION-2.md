# Loop 6 corpus refreeze revision 2

Revision 1 is preserved at Git commit `f6bb39abed7d0f8cbf9a0d44d7fcc011e35165c5` and in the rejected proof repositories.

It was rejected before V6.2 or V6.3 product acceptance because a machine determinism audit found identical exported-function inputs paired with different expected outputs:

- V6.2 omitted `envPin` from the checker call for five HR2 cases.
- V6.2 contained two additional duplicate-input pairs with different oracle text.
- V6.3 contained one duplicate-input pair with different oracle text.

Revision 2 passes `envPin` to `generateProperties`, makes the three remaining fixture inputs distinct without reducing case count or changing the BA source hash, and adds a fail-closed determinism check to `validateCorpus`.

No product file was changed while creating this refreeze. The revision-2 hashes are frozen before the next Coder run.
