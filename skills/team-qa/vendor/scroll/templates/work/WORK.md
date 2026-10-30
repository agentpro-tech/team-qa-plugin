---
controller: lead
---
# Work: market-entry decision

<!--
  WORK.md is a declarative DAG. One controller owns this file.
  `scroll run --work WORK.md` advances it deterministically: a task runs when every
  id in its `blockedBy` is done. Read-only tasks marked `parallel: true` run together.
  Each task appends its result to blackboard/<id>.md; downstream tasks read it.
  Tasks are ```task fenced YAML blocks.
-->

```task
id: research-market
title: Research the market
status: todo
owner: researcher
objective: Summarize market size, growth, and the top players for the segment.
output_format: decision-ready markdown
source_guidance: [S1, S2]
boundaries: [use only the provided sources, cite source ids]
blockedBy: []
parallel: true
```

```task
id: research-economics
title: Read unit economics
status: todo
owner: analyst
objective: Summarize unit economics and the main cost risks.
output_format: decision-ready markdown
source_guidance: [S3]
boundaries: [use only the provided sources, cite source ids]
blockedBy: []
parallel: true
```

```task
id: synthesize
title: Synthesize a decision memo
status: todo
owner: lead
objective: Combine the market and economics findings into a go/no-go decision memo.
output_format: decision-ready markdown
boundaries: [the single controller owns the merge]
blockedBy: [research-market, research-economics]
final: true
```
