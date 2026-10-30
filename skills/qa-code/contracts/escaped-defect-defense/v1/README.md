# Escaped-defect defense v1

The registry is immutable input. It names the incident, root cause, affected layers, exact
regression bytes and release-gate wiring. Runtime receipts bind to the registry SHA-256; they do
not rewrite the registry or turn prose into PASS.

`escaped-defect.root-map` supplies independently verified local roots for the four standalone
skills. Every referenced path is relative to one root and must resolve to a regular non-symlink
file inside that root.
