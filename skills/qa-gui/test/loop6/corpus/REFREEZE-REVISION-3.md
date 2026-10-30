# Loop 6 corpus refreeze revision 3

Revision 2 is preserved at Git commit `f7b4fb8b3fd32f1c2219f5e3604cf52f503b9e31`; its manifest
(sha256 `b6ded29af0c5bab1f77ad4384e8bc8b3f79407435bbe30d5f132e1787b8739a5`) is the one this revision supersedes.

Revision 2 named a real client project in fixture app names, preview URLs, CLI names and evidence paths of
V6.2, V6.3, V6.5, V6.6 and V6.7. Revision 3 replaces that name with the neutral `SampleShop` (and its lowercase
form `sampleshop`) everywhere it appeared, as one consistent substitution in every input and every oracle output.

Nothing else changed: case ids, case counts, totals, the BA source hash, the live-target pin and every other
byte are identical. V6.1, V6.4 and V6.8 did not contain the name and keep their revision-2 hashes. The four
frozen compatibility tables in `scripts/loop6/*-frozen.mjs` carry the same substitution and the new corpus
hashes in their headers; no other product file changed. The revision-3 hashes are recorded in
`CORPUS-MANIFEST.json`.
