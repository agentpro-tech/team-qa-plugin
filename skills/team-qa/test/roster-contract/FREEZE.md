# Run contract acceptance evidence

Original focused freeze: `af0d0b554a74f1354f4577868aabb06a6b53690014b94dcb1eb2ffb30281e0a3`, preserved in `archive/freeze-af0d0b554a74f1354f4577868aabb06a6b53690014b94dcb1eb2ffb30281e0a3.mjs.txt`.

The root coordinator approved an explicit contract coexistence amendment: absence of a current roster/phase denotes legacy diagnostic utilities; official current runs have the `team-qa/run-contract/v1` marker. The new board/sign negative fixtures now initialize that marker. The old frozen acceptance files were never changed. Intermediate amendment is archived as `amendment-4fce925d03fd4a3437f6ec8c112002b0e40d9476ccabc9959611a2a7cb98a877.mjs.txt`.

Final focused freeze: `36bda0f9174ee547b47d93576db668b912d99a299f784b675f2c24872ff85551`.

Both original and amended fixtures turn RED against the original Git HEAD CLI: 1/4 pass. The amended fixture's baseline copy is retained at `/var/folders/bv/bmms82jj5pl73lyy09d8jw9r0000gn/T/tq-phase-baseline-amended-OFa28P` on the implementation host; it is not portable release evidence.

Commands verified:

- `node --test test/roster-contract/*.test.mjs`: 11/11.
- Combined with `test/phase-b/fix-loop-1.test.mjs` and `test/source-issue-traceability.test.mjs`: 19/19.
- `node test/acceptance/run-acceptance.mjs`: unchanged frozen suite 52/52.
- `node test/roster-contract/run-gates.mutation.mjs`: removing either the current board intake guard or current plan approval guard turns the actual CLI acceptance RED, 3/4 instead of 4/4.

These tests validate software contracts with synthetic diagnostic fixtures. They do not certify a live model run. Real approved roster/role receipts and a full current PLAN to COMPLETE run were not executed in this delegated task, which forbade live LLM calls.

Mutation adapter amendment: preserved prior SHA 5fe0872ff2526c32bd18a627c7b04284ff8c8e8196756a321681276036bd78d3; plan-approval mutation now removes the current-run discriminator so it also disconnects fresh-user approval checks added after the original freeze. Frozen negative acceptance is unchanged.

Public-release amendment: the plan signer label passed to `--signed-by` was renamed from the owner's first name to `owner` in the product and in `run-gates.acceptance.test.mjs` (that one argument; no assertion changed). The final focused freeze above describes the file before this rename; its SHA-256 after the rename is `48a469a64d963d8b93bfd3fdeffa08bb594164df03066bb73ce7c44a154ab67e`. The archived freeze and amendment copies keep the old label byte for byte; they stay in the source repository and are not shipped in the package.
