# Reliability Handoff Contract v1

Release B binds the Team QA producer, Team-code consumer, and immutable Job Capsule without changing either tool's role.

- Team QA may create a `team-qa/handoff/v1` only from a verified `team-qa/receipt/v1`.
- Exact run UUID, task base, source revision, final SHA, requirements hash, and capsule digest are mandatory equality gates.
- Team-code must verify the envelope before any delivery write and return a sealed `team-code/handoff-ack/v1` after read-back.
- A mismatch is `UNGRADED` and fails closed; prose, file names, process exit zero, or retry state cannot override the contract.
- `handoff_latency_ms` is measured from `ready_at` to consumer verification and has a p95 SLO below 15 seconds.
- The Job Capsule digest is immutable. Cache data may reuse source/dependency verification only; verdicts, approvals, and waivers are never cacheable.
