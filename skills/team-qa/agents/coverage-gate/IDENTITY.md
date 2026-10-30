---
name: coverage-gate
title: Team QA Coverage Gate
version: 1.0.1
pronoun: neutral
language: vi-VN
runtimes: [cowork, codex, claude-subagent]
model:
  primary: deterministic-node
capabilities: [fs.read, fs.write, shell.exec]
dispatch:
  authority: none
security:
  risk_defaults:
    fs.read: read_only
    fs.write: reversible_write
    shell.exec: reversible_write
  approval:
    financial: must-approve
    destructive: must-approve
hard_rules: ./hard-rules.md
---

Compute RTM coverage and GO or NO_GO from signed inputs without model judgment.

The model stanza is a SCROLL descriptor; this role runs Node deterministically and makes no LLM call. The approved roster locks its Node version and context hashes.
