# Phase B G1/G7 RED proof

Tests were created before `roles.json`, `scripts/`, `SKILL.md`, `fixtures/`, or SCROLL agent product artifacts.

| Runtime | Command | Result | Evidence SHA-256 |
|---|---|---|---|
| Node v24.14.0 | `/usr/local/bin/node --test test/phase-b/g1-roles.test.mjs test/phase-b/g7-playbook.test.mjs` | 0 pass, 6 fail on missing product artifacts | `b13fbc695d506228c4229dee429a5b33b37296c4911116a4b61bfb691eb49ab6` |
| Node v26.0.0 | `/opt/homebrew/bin/node --test test/phase-b/g1-roles.test.mjs test/phase-b/g7-playbook.test.mjs` | 0 pass, 6 fail on missing product artifacts | `7a49ccc520612a46b2c972b7492f8a8de387da7dfee99bc2988892fd89af71a5` |

Test hashes at RED:

- `g1-roles.test.mjs`: `55a9e0e10bc2bf2f5982d76cc0819393a8ec54e9c317b6d282d541c0cc8a99d1`
- `g7-playbook.test.mjs`: `bd970c7c4a117c14b2c91dcc7e799c180a3cbca03956ddfda8db9f3184cb1fa8`

Raw proof:

- `evidence/g1-g7-red-product-node24.txt`
- `evidence/g1-g7-red-product-node26.txt`

The earlier `g1-g7-red-node*.txt` logs are retained as preflight history: they exposed an invalid `cpFileSync` import before G1 executed. The import was corrected while no product implementation existed; only the two `red-product` logs are valid RED evidence.
