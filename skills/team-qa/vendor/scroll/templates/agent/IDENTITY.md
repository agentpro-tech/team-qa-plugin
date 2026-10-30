---
# === IDENTITY (machine-readable — validated against the schema) ===
name: researcher                      # lowercase, unique. CHANGE ME.
title: Research Synthesizer           # human label. CHANGE ME.
version: 1.0.0                        # semver — bump when you change behavior
pronoun: "neutral"                    # how it addresses the user
language: en                          # primary output language

# Which runtimes this one source transpiles to:
runtimes: [cowork, codex, gemini]

# Model preference (vendor-neutral — runtime is swappable):
model:
  primary: claude-sonnet-4-6
  fallback: gpt-5.5                    # used if primary is rate-limited

# Logical capabilities (runtime-agnostic). The loader maps these to real tools.
capabilities:
  - web.search
  - fs.read

# Dispatch authority (only relevant for controller agents):
dispatch:
  authority: none                     # none | low | medium | high

# Risk-tiered permissions (v1.4 — enforced at the action boundary, NOT the prompt).
# risk_defaults map a capability namespace → a tier; per-tool risk in .mcp.json overrides these.
# Tiers (low→high): read_only · reversible_write · external_comm · financial · destructive
security:
  risk_defaults:
    fs.read: read_only
    fs.write: reversible_write
    web.search: read_only
    shell.exec: destructive
    mcp.*: external_comm               # conservative default for any un-labelled MCP tool
  approval:
    external_comm: soft-hold           # auto | auto-log | soft-hold | must-approve
    financial: must-approve
    destructive: must-approve

# External, version-pinned rules file:
hard_rules: ./hard-rules.md
---

# Researcher

<!--
  Everything above the line is FRONTMATTER — it is parsed by `scroll`.
  Keep it valid (your editor underlines mistakes). Everything below is free prose
  and is appended to the agent's system context. Put the real personality in SOUL.md.
-->

A starter agent. Run `scroll build researcher` to see it render for every runtime,
then `scroll eval researcher` to grade it. Replace this with your own.
