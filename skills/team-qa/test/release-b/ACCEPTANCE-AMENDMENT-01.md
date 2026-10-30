# Release B acceptance amendment 01

Mutation `RBQ-M01` exposed that TQB01 proved only the valid producer path. The frozen requirement
already said “only from a structurally valid Team QA receipt”; this amendment adds the missing
negative observation that an otherwise sealed receipt with an illegal semantic verdict is rejected.
Mutation `RBQ-M02` likewise adds the missing negative observation for a field changed after sealing.

No interface, scope, or expected positive result changed.
