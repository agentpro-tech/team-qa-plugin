# SCROLL Specification

**Version:** 1.6 · **Status:** Draft (runtime built; §28–30 implemented) · **Date:** 2026-07-15 · **Reference impl:** `@agentpro/scroll` 0.11.0

> **v1.4 (the harness + loop-engineering layer):** §21 risk-tiered permission matrix (5 tiers, enforced at the action boundary) · §22 grounding pre-check · §23 `LOOP.md` outer loop. Plus record corrections: `scroll eval` is **built** (not roadmap); the approval file lives under `control/approvals/<id>` (§18.3).

This document is the normative reference for SCROLL agents. A tool is **SCROLL-conformant** if it reads and writes agent folders exactly as defined here.

The key words **MUST**, **MUST NOT**, **REQUIRED**, **SHOULD**, **SHOULD NOT**, **RECOMMENDED**, **MAY**, and **OPTIONAL** are to be interpreted as in RFC 2119.

---

## 1 · Overview & terminology

- **Agent** — a directory containing the files defined in §2. The directory name is the agent's local id.
- **Source** — the canonical agent files a human/AI authors (`IDENTITY.md`, `SOUL.md`, etc.). The single source of truth.
- **Rendering** — a runtime-specific artifact produced from the source by a transpiler (§15). Renderings are generated; they MUST NOT be hand-edited.
- **Loader** — a SCROLL-conformant program that reads an agent folder and assembles its context.
- **Controller** — the single agent that owns a `WORK.md` in a multi-agent run (§9).
- **Conformant tool** — a program (CLI, library, plugin) implementing this spec.

A SCROLL **repository** MAY contain many agents under `agents/` and SHOULD contain a root `AGENTS.md` (§17) and a `scroll.config.*` (§16).

---

## 2 · The agent folder

```
agents/<name>/
├── IDENTITY.md      REQUIRED   identity + machine-readable frontmatter (§3)
├── SOUL.md          REQUIRED   persona prose (§4)
├── TOOLS.md         OPTIONAL   capability → tool wiring (§5)
├── hard-rules.md    OPTIONAL   inviolable rules (§6)
├── memory/          OPTIONAL   recall, archival, layered (§7)
└── evals/           RECOMMENDED gold test cases (§8)
```

- `<name>` **MUST** match `^[a-z][a-z0-9-]*$` and be unique within its `agents/` directory.
- An agent **MUST** contain `IDENTITY.md` and `SOUL.md`. All other files are OPTIONAL but a conformant loader MUST honor them when present.
- Unknown files in the folder **MUST** be ignored by loaders (forward compatibility).

---

## 3 · `IDENTITY.md`

`IDENTITY.md` consists of YAML frontmatter (between `---` fences) followed by free-form body prose.

### 3.1 Frontmatter (normative)

| Field | Req | Type | Notes |
|---|---|---|---|
| `name` | MUST | string | `^[a-z][a-z0-9-]*$`, equals folder name |
| `title` | MUST | string | human-readable label |
| `version` | MUST | string | semver `MAJOR.MINOR.PATCH` |
| `pronoun` | SHOULD | string | how the agent addresses the user |
| `language` | SHOULD | string | BCP-47 (e.g. `en`, `vi-VN`) |
| `runtimes` | MUST | string[] | non-empty; values from the runtime registry (§15) |
| `model` | MUST | object | `{ primary, fallback?, voice?, voice_id? }`; `primary` REQUIRED |
| `capabilities` | MUST | string[] | logical capabilities (§5.1); MAY be empty |
| `dispatch` | OPTIONAL | object | `{ authority, can_dispatch?, spawn_template? }` |
| `position` | OPTIONAL | enum | `c-suite \| above-c-suite \| outside-org \| runtime` |
| `reports_to` | OPTIONAL | string | another agent's name or `user` |
| `hard_rules` | OPTIONAL | path | relative path to a rules file (§6) |
| `memory` | OPTIONAL | object | overrides default memory layout (§7) |
| `a2a` | OPTIONAL | object | A2A Agent Card export hints (§15) |

- `dispatch.authority` **MUST** be one of `none | low | medium | high`. Default `none`.
- Fields not listed here are **OPTIONAL extensions**; a conformant validator MUST treat unknown fields as a **warning**, never an error.
- The full JSON Schema is **Appendix A**.

### 3.2 Body

Everything after the closing `---` is appended to the agent's assembled context (§13) after `SOUL.md`. It MAY be empty. It MUST NOT contain secrets; secret references use `${vault:KEY}` syntax, resolved at load time.

---

## 4 · `SOUL.md`

Free-form prose defining voice, values, and behavior. There is **no required structure** — this is the human-authored heart of the agent. A loader **MUST** include the full contents of `SOUL.md` in the assembled context (§13). Tools **MUST NOT** auto-generate `SOUL.md` from frontmatter.

---

## 5 · `TOOLS.md`

### 5.1 Capabilities (logical, runtime-agnostic)
Capabilities are dot-namespaced verbs. Reserved roots: `fs`, `web`, `shell`, `mcp`, `vision`, `voice`, `dispatch`. Example: `web.search`, `fs.read`, `shell.exec`, `dispatch.agents`.

The `capabilities` array in `IDENTITY.md` is the source of truth; `TOOLS.md` **MUST NOT** declare a capability absent from `IDENTITY.md`. A validator MUST flag the mismatch.

### 5.2 Tool bindings (per runtime)
`TOOLS.md` MAY contain a YAML block mapping each capability to a runtime-specific tool name:
```yaml
web.search:
  cowork: WebSearch
  codex:  web_search
  gemini: google_search
```
Tool **implementations** live in application code, never in the agent folder. Only the **wiring** is specified here.

---

## 6 · `hard-rules.md`
A list of rules the agent **MUST NOT** violate, in prose or bullets. Referenced by `IDENTITY.md:hard_rules` (which MAY be a shared file used by multiple agents). A conformant loader **MUST** place `hard-rules` in the cached prefix (§13) so they are always present, and **SHOULD** support an automated rule-check.

---

## 7 · `memory/`

| Path | Role | Notes |
|---|---|---|
| `memory/lessons.md` | recall | scanned at session start; append-only |
| `memory/log/` | archival | one file per session, **race-safe** |
| `memory/private/` | private | visible only to this agent |
| `memory/team/` | team | visible to agents sharing a `team_id` |
| `memory/global/` | global | visible to all agents |

- Archival log files **MUST** be named `YYYY-MM-DD-<topic>.md` and **MUST NOT** be appended to concurrently by two processes (race-safe rule: one file per session).
- Visibility is determined by **folder**, not metadata. Promotion between layers is a file **move**.
- A loader **MUST** only surface memory an agent is permitted to read (its own `private`, its `team`, and `global`).

---

## 8 · `evals/`

An agent SHOULD ship at least three **gold cases**. Each gold case is a markdown file with frontmatter:

```yaml
---
id: case-01-...
runs: 10          # times to execute (consistency measurement)
---
```
The body **MUST** contain: an **Input**, a **checklist** of programmatically-verifiable requirements (including at least one **planted trap** the agent must not fall for), an OPTIONAL **rubric** for LLM-judging, and **pass thresholds**.

`evals/rubric.md` MAY hold a shared rubric. A conformant `eval` runner (§ tooling) **MUST**:
1. run each case `runs` times,
2. apply programmatic checks and (if present) an LLM-judge,
3. grade the **end state / output**, never the execution path,
4. report a score per case plus a **diff against the previous run**,
5. compute a consistency metric (pass^k) for customer-facing reliability.

---

## 9 · Multi-agent — `WORK.md`

`WORK.md` is the work-chain for a multi-agent run, expressed as a **declarative DAG**.

### 9.1 Task record
Each task **MUST** declare:

| Field | Req | Notes |
|---|---|---|
| `id` | MUST | unique within the file |
| `title` | MUST | short imperative |
| `status` | MUST | `todo \| doing \| done \| blocked` |
| `owner` | MUST | exactly one agent name |
| `blockedBy` | OPTIONAL | list of task ids (dependencies) |
| `objective` | MUST | what "done" means |
| `output_format` | MUST | expected shape of the result |
| `tool_guidance` | SHOULD | which tools/sources to use |
| `boundaries` | MUST | what NOT to do / scope limits |

The last four fields are the **four-part task contract**. Omitting any of `objective`, `output_format`, `boundaries` **MUST** be a validation error (under-specified tasks cause agent drift).

### 9.2 Ownership & advancement (normative)
- A `WORK.md` **MUST** have exactly one **controller**; only the controller writes `WORK.md`. Sub-agents **MUST NOT** reassign tasks to each other (this prevents infinite handoff loops).
- Advancement **MUST** be deterministic: a runner reads dependencies and dispatches every task whose `blockedBy` is satisfied. An LLM **MUST NOT** freely decide task ordering; LLM autonomy is confined to *within a step* and to explicitly open-ended routing tasks.
- Independent tasks **MAY** be dispatched in parallel (fork-join). Each parallel task **MUST** write to its own files (race-safe); no two tasks write the same file.

---

## 10 · `blackboard/`

A shared information space. Each entry is **one append-only file**:
```
blackboard/<YYYY-MM-DD>-<author>-<slug>.md
```
with frontmatter `type` (`discovery | decision | request | progress | warning`), `author`, `visibility` (`team | global`), and OPTIONAL `expires_at`.

- Writers **MUST NOT** modify another agent's entry (append-only).
- On task start, a loader **SHOULD** surface entries relevant to the task (entity/keyword match), placed in the **volatile** context region (§13).
- Entries without `expires_at` default to a 7-day lifetime; `scroll prune` removes expired entries.

---

## 11 · `registry.md`

A generated table of agent track-record, used for capability-aware dispatch:
`agent · task_type · runs · success_rate · avg_tokens · avg_duration`.

It is **derived** from `memory/log/` by a conformant tool and **MUST NOT** be hand-maintained as the source of truth. Dispatch logic MAY weight by success rate, recency, and token efficiency.

---

## 12 · Token governance

A SCROLL repo **MUST** support hard caps, configured in `scroll.config.*`:

```yaml
budget:
  per_run_usd: 25
  per_iteration_tokens: 4000
  max_iterations: 50
  recursion_depth: 2
  wall_clock_minutes: 60
  on_exceed: pause   # pause | downgrade | abort
```

- A conformant runner **MUST** enforce these as **hard** limits with a circuit breaker. On breach it **MUST** take `on_exceed` action and **SHOULD** notify a human.
- A token **ledger** (running tally) **SHOULD** be written to `ledger.md` (or the storage backend) and is the basis for cost reporting.
- Before spawning multiple agents, a runner **SHOULD** estimate single-vs-multi cost and prefer single-agent unless the task is parallel and read-heavy.

---

## 13 · Context assembly & caching (normative)

A loader **MUST** assemble an agent's context in two regions, in this order:

```
[ STABLE PREFIX ]                          → cache breakpoint →   [ VOLATILE SUFFIX ]
  tool/MCP definitions                                             current task (WORK.md)
  hard-rules                                                       fresh blackboard entries
  IDENTITY (frontmatter + body)                                    timestamps, prior step output
  SOUL                                                             retrieved memory
  pinned skill indexes
```

- The stable prefix **MUST** be byte-identical across ticks of the same agent so provider prompt-caching hits. Tools **MUST NOT** interleave volatile content into the prefix.
- Where a provider's default cache lifetime is short, loaders **MUST** set an explicit cache TTL; cached reads are typically billed at a small fraction of fresh input. Consult the provider's caching documentation — this spec fixes no vendor's numbers.
- Skills are referenced by **index** (name + one-line description) in the prefix; full skill bodies load **on demand** (progressive disclosure). Skill *content* is out of scope for this spec — SCROLL specifies only the cheap-load mechanism.

---

## 14 · The Runner

A conformant runner drives one heartbeat loop:
```
wake → load context → pick ready task(s) → dispatch → write result + checkpoint → stop-check → sleep|halt
```

- **Checkpoint:** after each tick the runner **MUST** persist state durably (a git commit locally, or a write to the storage backend) such that a crashed run resumes from the last checkpoint.
- **Decomposition:** long objectives **MUST** be split into short, individually-verifiable units; the runner **SHOULD** verify per step and track per-step success.
- **Human gates:** any irreversible external action (send, pay, delete, post) **MUST** halt and await an approval file under `gates/`.
- **Stop conditions:** the runner **MUST** halt on objective-complete, budget breach (§12), or a watchdog timeout.

---

## 15 · Transpilation

`scroll build` renders the source to one artifact per declared runtime. Runtime registry (extensible): `cowork`, `codex`, `gemini`, `claude-subagent`, `voice`, `a2a`.

- Transpilers **MUST** be deterministic: identical source ⇒ identical output.
- Renderings **MUST** carry a generated-file marker and **MUST NOT** be edited by hand; a conformant tool **SHOULD** warn on drift between source and rendering.
- A2A export produces a static Agent Card JSON from frontmatter; it does not require a running endpoint.

---

## 16 · Storage adapters

State access is abstracted behind a path-addressed read/write interface. A conformant loader **MUST** support at least `local-fs` and **SHOULD** support an object-store driver.

```yaml
# scroll.config.yaml
storage:
  driver: s3          # local-fs | s3 | gcs | repo
  bucket: my-agents
  prefix: ${TENANT}   # multi-tenant isolation
```

- Agent **definitions** are read-only config shipped with the deployment.
- Runtime **state** (`WORK.md`, `blackboard/`, `memory/`, `ledger`) is addressed by path and stored via the driver. Agent code **MUST NOT** assume a local filesystem.
- Multi-tenant deployments **MUST** namespace state by tenant/run prefix.

---

## 17 · Conformance levels & validation

`scroll check` reports against three levels:

| Level | Requires |
|---|---|
| **L0 — Valid agent** | `IDENTITY.md` frontmatter valid; `SOUL.md` present; capabilities consistent with `TOOLS.md` |
| **L1 — Gradeable** | L0 + ≥3 gold cases in `evals/`; `hard-rules` present |
| **L2 — Multi-agent ready** | L1 + any `WORK.md` satisfies the four-part contract and single-controller rule |

- Validation is **linter-style**: structural violations are **errors**; style/extension issues are **warnings**. A conformant tool SHOULD run `check` in pre-commit and CI.
- The repo root SHOULD contain `AGENTS.md` instructing AI tools to follow this spec.

---

## 18 · Observability & control

A conformant runner **MUST** emit an event stream and **MUST** honor control files. This is the surface through which users observe and steer a run.

### 18.1 Event stream
Events are written append-only to `runs/<run-id>/events.jsonl`, one JSON object per line:
```json
{ "ts": "<iso8601>", "run": "<run-id>", "agent": "<name>", "type": "<type>", "data": { } }
```
`type` **MUST** be one of: `run_started`, `step_started`, `thought`, `tool_call`, `tool_result`, `message`, `state_update`, `gate_request`, `cost_update`, `run_completed`, `error`. Events **MUST** be append-only. Consumers tail the file (local) or subscribe via an SSE/WebSocket gateway (cloud). Event types **SHOULD** map to the **AG-UI** protocol so standard frontends can render them.

### 18.2 State polling
Current run state **MUST** be derivable by reading `WORK.md` (task statuses) plus the ledger (tokens/cost) — without replaying the event stream. Polling is a cheap file read.

### 18.3 Control
A runner **MUST** check `control/` at the start of every tick and honor:
- `control/pause`, `control/resume`, `control/stop` — presence-based signals
- `control/steer.md` — guidance injected into the next step's context
- `control/approvals/<gate-id>` — approval for a pending must-approve gate (§21). (The v1.3 draft wrote this as `gates/<id>.approved`; `control/approvals/` is normative from v1.4. A conformant runner SHOULD also accept the legacy `control/<id>.approved` for back-compat.)

`thought` (chain-of-thought) events are **advisory transparency**, not authoritative; consumers **MUST NOT** treat them as ground truth.

### 18.4 Backend tracing
A runner **SHOULD** emit **OpenTelemetry GenAI** spans (LLM client, agent, tool) for backend observability, independently of the user-facing event stream.

---

## 19 · Tools, MCP, connectors, skills & plugins

SCROLL specifies how capabilities **attach** to an agent; it does not ship their implementations. It is **MCP-first** and reuses standard formats. The wiring is installed by `scroll mcp add` / `scroll skill add` / `scroll plugin add` (implemented in impl 0.8.0) — they only edit `.mcp.json`, `skills/`, and `agents/`; the runtime reads those files.

### 19.1 Tools & MCP
- An agent declares logical `capabilities` in `IDENTITY.md` and per-runtime `tool_bindings` in `TOOLS.md` (§5).
- MCP servers are declared in a standard **`.mcp.json`** (repo-level or under `agents/<name>/.mcp.json`). A loader **MUST** connect to declared servers and expose their tools to the agent when the agent has the `mcp.client` capability. Tool *implementations* come from the MCP server, not the agent folder.

### 19.2 Connectors
A connector (Gmail, Slack, Notion, …) is an MCP server plus credentials. Credentials **MUST** be referenced via `${vault:KEY}` and resolved at load time; they **MUST NOT** appear in any agent file. A conformant tool **SHOULD** integrate an MCP/connector registry for discovery (`scroll mcp add`).

### 19.3 Skills
- A skill is a directory containing **`SKILL.md`** with frontmatter `name`, `description`, and `triggers`, plus a body.
- An agent references skills by name (`skills: [...]`). A loader **MUST** resolve them along a search path: `agents/<name>/skills/` → repo `skills/` → a shared library.
- Skills **MUST** be loaded with progressive disclosure: the index (name + description) sits in the cached prefix (§13); the body loads on trigger. Skill *content* is out of scope for this spec.

### 19.4 Plugins
A plugin is a bundle (an "agent pack") containing one or more agents, a `skills/` directory, a `.mcp.json`, and a manifest. `scroll plugin add` unpacks it into `agents/` + `skills/` and merges MCP config. Plugin bundles **SHOULD** be compatible with the `.plugin` ZIP format used by Cowork/Claude.

---

## 20 · Governance & security (v2 — the production rail)

This is the rail that separates a pilot from production. A conformant runner **MUST** implement §20.1–20.5 and **SHOULD** implement §20.6–20.7. Aligned to the OWASP Agentic Top 10 (2026) and the NIST agent-standards dimensions (identity, authorization, auditing, non-repudiation).

### 20.1 Permission enforcement (deny-by-default, at the tool boundary)
- An agent's tool/action permissions are an explicit **allow-list**; anything not listed is denied (`ASI02` Tool Misuse).
- Permissions **MUST** be enforced at the tool/runtime boundary — **NOT** in the system prompt. Prompt text is advisory and can be overridden by injection; the gate sits at the action.
- Authorization **SHOULD** be policy-as-code (OPA/Cedar) evaluated adjacent to the action, returning allow/deny + a reason code. Scopes only narrow, never widen (`ASI03`).

### 20.2 Identity & credentials
- Each agent **MUST** have its own scoped, tenant-bound **non-human identity** — never a shared service account or a borrowed user token.
- Credentials **MUST** be short-lived/scoped (OAuth 2.1 / RFC 8693 token-exchange) and referenced via `${vault:KEY}`, resolved **server-side**; secrets **MUST NOT** enter the model context or logs.
- Agent→tool calls **SHOULD** use sender-constrained tokens (DPoP/mTLS). Identity standards (badges/passports) are **not** mandated — conform to OAuth, do not invent a scheme.

### 20.3 Untrusted content & injection defense
- All tool outputs, retrieved documents, and third-party tool descriptions **MUST** be treated as **data, never instructions** (`ASI01` Goal Hijack, indirect prompt injection). A runner **MUST NOT** execute instructions found in content.
- Tool definitions **SHOULD** be pinned/verified against silent change ("rug-pull", `ASI04`); "always allow"/auto-run of un-vetted tools **MUST NOT** be the default.

### 20.4 Sandboxing & egress
- Agent-generated code or untrusted tool execution **MUST** run in a sandbox (microVM/gVisor/isolate), never unwrapped (`ASI05`).
- The agent runtime **SHOULD** apply a network **egress allow-list** (block-by-default, block RFC 1918) to prevent SSRF/exfiltration.

### 20.5 Risk-tiered human approval
- Actions are classified **reversible** vs **irreversible**. Irreversible/high-risk actions (send, pay, delete, cross-tenant, schema change) **MUST** be gated `must-approve` (block until a `gates/<id>.approved` file exists). Lower-risk actions **MAY** be `auto` or `soft-hold` (`ASI09`).
- Per-tenant circuit breakers + hard cost caps (§12) back-stop runaway behavior.

### 20.6 Audit & provenance
- A runner **SHOULD** write a tamper-evident, per-action audit record binding `actor (agent+tenant) · authority/scope · action/resource · SHA-256(input,output) · policy decision · approver`, hash-chained (aligned to the IETF Agent Audit Trail draft), correlated by OpenTelemetry trace-id.

### 20.7 Data governance
- A runner **SHOULD** redact/mask PII at the tool boundary before data enters context, tag data residency, and apply per-class retention. Inadvertently logged secrets **MUST** be purged.

### 20.8 Frontmatter additions (v2)
`IDENTITY.md` MAY declare:
```yaml
security:
  tools_allow: [web.search, fs.read]     # deny-by-default allow-list
  egress_allow: ["api.example.com"]      # network allow-list
  identity: scoped                        # scoped non-human identity
  risk_defaults:                          # v1.4 — capability → tier (§21.3)
    fs.read: read_only
    shell.exec: destructive
    mcp.*: external_comm
  approval:                               # v1.4 — tier → policy (§21.2)
    external_comm: soft-hold              # auto | auto-log | soft-hold | must-approve
    financial: must-approve
    destructive: must-approve
```

---

## 21 · Risk-tiered permission matrix (v1.4)

This refines §20.5 from a binary (reversible/irreversible) into a five-tier matrix, and fixes the **enforcement point at the action boundary** — a conformant runner evaluates it in code, immediately before an action, **never** by asking the model to self-restrain.

### 21.1 Tiers
Every action **MUST** be classified into exactly one tier (lowest → highest consequence):
`read_only` · `reversible_write` · `external_comm` · `financial` · `destructive`.
An action whose tier cannot be determined **MUST** be treated as `destructive` (fail-safe / deny-by-default).

### 21.2 Matrix (default policies, overridable)
| tier | default policy |
|---|---|
| `read_only` | `auto` |
| `reversible_write` | `auto-log` (execute + audit record §20.6) |
| `external_comm` | `soft-hold` |
| `financial` | `must-approve` **+ grounding (§22)** |
| `destructive` | `must-approve` **+ grounding (§22)** |

- `must-approve` **MUST** block until an approval file exists at `control/approvals/<gate-id>` (§18.3).
- `soft-hold` **MAY** execute after a configurable hold; `auto`/`auto-log` execute immediately.
- A `financial` policy **MAY** carry a `threshold` so amounts below it are `soft-hold` and above it `must-approve`.

### 21.3 Where risk is declared (data, not prose)
Risk is **machine-readable** and resolved by the runner, in precedence order: (1) a per-tool `risk` in `.mcp.json`; (2) `IDENTITY.security.risk_defaults` keyed by capability (exact, then namespace glob like `mcp.*`); (3) the `destructive` fallback. A risk label **MUST NOT** be taken from a markdown body — prompt text is advisory and injectable (§20.1).

### 21.4 Decision & events
The runner emits `permission_decision { tool, tier, policy, decision: allow|await|deny, reason }`. `deny` (e.g. grounding failure) **MUST** take precedence over an approval — an approved-but-ungrounded action still does not run. Legacy `gate_requested`/`gate_approved`/`gate_blocked` events remain for back-compat; the v1.3 task risk `irreversible` is an alias for `destructive`.

---

## 22 · Grounding pre-check (v1.4)

Before any `financial` or `destructive` action, a runner **SHOULD** verify that every **critical parameter** declared for it (e.g. a product code, an amount, a customer id) traces to a real source already present in the run — the `blackboard/`, a prior `tool_result`, `control/steer.md`, or the task objective.

- The check is **deterministic**: it matches parameters by exact/regex token (codes, ids) or digits (amounts). It **MUST NOT** rely on an LLM judgment of "semantic" grounding — that would re-introduce model trust.
- Parameters to ground are declared per-tool in `.mcp.json` (`{ "issue_invoice": { "risk": "financial", "ground": ["code","amount"] } }`) or on a `WORK.md` task (`ground:`).
- On a missing trace the runner **MUST** emit `grounding_failed` and **MUST NOT** execute the action. A passing check emits `grounding_checked { traced, missing, passed }`.

---

## 23 · `LOOP.md` — the outer loop (v1.4)

`scroll run` is the **inner loop** (one harnessed execution). `LOOP.md` defines the **outer loop**: when to start an inner loop, where it finds work, and when to stop. A conformant `scroll loop` rides the host scheduler; it introduces **no engine, DB, or daemon runtime**.

### 23.1 Frontmatter (normative)
| Field | Req | Notes |
|---|---|---|
| `id` | MUST | unique loop id |
| `controller` | MUST | exactly one owner |
| `work_source` | MUST | `{ type: work_file \| inline \| glob, query }` — where each iteration's work comes from |
| `stop_conditions` | MUST | at least one of `max_runs`, `max_runs_per_day`, `budget_usd_per_day`, `until`, or a non-empty `halt_on[]` |
| `schedule` | SHOULD | `{ cron }` or `{ interval_ms }` or `{ on_event }` |
| `budget` | SHOULD | per-loop and per-run caps |
| `digest` | SHOULD | `required` to write a digest (§18) after each inner run |

### 23.2 Rules
- A `LOOP.md` with **no** stop condition **MUST** be refused (a loop that can't stop is unsafe).
- The outer loop **MUST NOT** escalate privilege: every action in each inner run is still subject to §21.
- Loop state (runs today, spend today) **MUST** persist (e.g. `runs/loop-<id>/state.json`) so stop conditions hold across process restarts.

---

## Appendix A · `IDENTITY.md` frontmatter JSON Schema

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://agentpro.dev/scroll/identity-1.2.json",
  "title": "SCROLL IDENTITY frontmatter",
  "type": "object",
  "required": ["name", "title", "version", "runtimes", "model", "capabilities"],
  "additionalProperties": true,
  "properties": {
    "name":    { "type": "string", "pattern": "^[a-z][a-z0-9-]*$" },
    "title":   { "type": "string", "minLength": 1 },
    "version": { "type": "string", "pattern": "^\\d+\\.\\d+\\.\\d+$" },
    "pronoun": { "type": "string" },
    "language":{ "type": "string" },
    "position":{ "enum": ["c-suite", "above-c-suite", "outside-org", "runtime"] },
    "reports_to": { "type": "string" },
    "runtimes": {
      "type": "array", "minItems": 1,
      "items": { "enum": ["cowork", "codex", "gemini", "claude-subagent", "voice", "a2a"] }
    },
    "model": {
      "type": "object",
      "required": ["primary"],
      "properties": {
        "primary":  { "type": "string" },
        "fallback": { "type": "string" },
        "voice":    { "type": "string" },
        "voice_id": { "type": "string" }
      }
    },
    "capabilities": {
      "type": "array",
      "items": { "type": "string", "pattern": "^(fs|web|shell|mcp|vision|voice|dispatch)\\.[a-z_]+$" }
    },
    "dispatch": {
      "type": "object",
      "properties": {
        "authority":     { "enum": ["none", "low", "medium", "high"] },
        "can_dispatch":  { "type": "array", "items": { "type": "string" } },
        "spawn_template":{ "type": "string" }
      }
    },
    "hard_rules": { "type": "string" },
    "memory":     { "type": "object" },
    "a2a":        { "type": "object" }
  }
}
```

---

## Appendix B · Minimal valid agent (L0)

```
agents/echo/
├── IDENTITY.md
└── SOUL.md
```
`IDENTITY.md`:
```yaml
---
name: echo
title: Echo
version: 0.1.0
runtimes: [cowork]
model: { primary: claude-haiku-4-5 }
capabilities: []
---
```
`SOUL.md`:
```
You repeat the user's message back, clearly and briefly.
```

---

## Versioning

This spec is versioned with semver. Renderings and validators declare the spec version they target. Backward-incompatible changes increment MAJOR. Agents declare their own `version` independently of the spec version.

*SCROLL Specification v1.6 · reference implementation `@agentpro/scroll` 0.11.0 — Agent Pro. Companion: `README.md`, `AGENTS.md`, `templates/agent/`, `templates/work/LOOP.md`.*

---

## §24–27 — v1.5 · Trackable · Self-Driving · Honest-on-Failure

New `LOOP.md` fields (all OPTIONAL — backward compatible; `validateLoop` type-checks them only when present):

- **§24 `ledger:`** — a human-readable tracking table that spans runs. `local://path.csv|md` (core, zero-dep), or an external URI scheme resolved by an **app-layer adapter** reading `runs/loop-<id>/ledger.jsonl` (the core ships no third-party client). After **every** output — pass or fail — a runner **MUST** append one row: `ts · loop · iteration · task · status · tries · proof · digest`. If `ledger` is unset and the loop is driven through an agent or skill, the runner **MUST** ask the operator where to store it and **MUST NOT** silently default to a remote store. A bare CLI defaults to `local://runs/ledger.csv`.
- **§25 `planner:`** — a command executed **once, before** the loop, that **generates** the backlog (self-planning: study a reference → enumerate outstanding work → emit `WORK`). It is a plain command, deterministic, outside the model. Absent → v1.4 behaviour (consume pre-existing work).
- **§26 `max_tries_per_task:`** (default 3) — each task gets N tries of its own; pass → stop early. Exhausted and still failing → record ledger `status: failed` + proof, then **CONTINUE to the next task**. Halt only on `gate_denied` (immediately, no retry) or when `verify_fail ∈ halt_on` (after exhausting N — backward compat). A try-budget is **per task**, never global.
- **§27 Proof-pack** — `result.proof` (a path/URI to inspectable evidence) is recorded in the ledger. A **failure MUST carry proof** of what was attempted; silent failure is non-conformant. Rendering visual evidence is app-layer; the core mandates only that proof **exists** and is **recorded**.

Reference impl: `lib/loop.js` (`validateLoop` + `runLoop`) + `lib/ledger.js`.

---

## §28 — Effect confirmation (v1.6)

> Reference impl: `lib/effects.js` (`confirmEffect` · `evalExpect` · `rejectUnknownFields`), audited by `scroll audit`.

A write that *reports* success is not evidence that the write *happened*.

- A runner **MUST** classify an action as a WRITE when it mutates state outside the run's own memory (tiers `reversible_write | external_comm | financial | destructive`, §21).
- A WRITE **MUST NOT** be considered successful merely because the call returned a non-error status. Self-reported success is not evidence.
- The runner **MUST** confirm the effect with an **independent read-back**. The read-back **MUST** be a separate read operation; the write's own response **MUST NOT** be used as its confirmation.
- If the write reports success but the read-back does not satisfy `expect`, the runner **MUST** emit `effect_unconfirmed` and mark the step **failed**. This is a failure, not a warning.
- A WRITE at tier `financial | destructive` with no declared `confirm` **MUST** be flagged by `scroll audit`; a conformant runner blocks by default (fail-closed).

Declared as data, alongside `risk`/`ground` (§21.3, §22) — never in prose:

```json
"issue_invoice": {
  "risk": "financial",
  "ground": ["product_code", "amount"],
  "confirm": { "probe": "lookup_invoice", "expect": "$.status == 'issued'" }
}
```

Events: `effect_confirmed { tool, probe, ok, observed }` · `effect_unconfirmed { tool, expected, observed }`.

**Corollary — fail-closed on unknown input.** An interface that receives a field it does not understand **MUST** reject the request (a 4xx-equivalent carrying `rejected[]`) and **MUST NOT** ignore it silently. Silently dropping input is how a system comes to report success for work it never did; an agent reading that success will then report it onward in perfect good faith. The agent is not lying — the interface is.

---

## §29 — Ungraded is not pass (v1.6)

> Reference impl: `lib/eval.js` — `case.verdict` is `'pass' | 'fail' | 'ungraded'`; `report.ungraded` counts them; `ok` requires ≥1 graded case and every graded case passing.

A verdict is **ternary**, never boolean:

| verdict | meaning |
|---|---|
| `pass` | graded — at least one check actually ran, and every check passed |
| `fail` | graded — a check ran and failed |
| `ungraded` | **no check ran** — no rubric declared, tooling absent, or the checker itself errored |

- `ungraded` **MUST NOT** be coerced to `pass` anywhere: API, UI, ledger (§24), digest, or gate.
- A UI **MUST** render `ungraded` distinctly from `pass` — a neutral marker, never a check-mark.
- A `must-approve` gate (§21) treats `ungraded` as `fail` (fail-closed).
- Ledger `status` accepts `ungraded`; a digest (§18) **MUST** count it separately. "3 done" where two were never graded is a false report.
- When a checker cannot run (missing dependency, unavailable tool), its result is `ungraded` — **never** `pass`.

Rationale: a harness in which "not measured" and "measured and good" are indistinguishable renders every green number it emits meaningless — and makes §27 proof worthless.

---

## §30 — Fixture provenance (v1.6)

> Reference impl: `lib/eval.js` (`parseFixture`) prints provenance beside every verdict; `scroll audit` warns on a missing/invalid provenance and on a suite that is entirely `synthetic`. The shipped scaffold declares its own provenance.

§8 requires grading the end state rather than the execution path. It is silent on **where the precondition came from** — and that silence lets a green suite prove nothing.

If a case's precondition was created **by hand** rather than by the product's own path, the case says nothing about that path. Every gold case (§8) **MUST** declare its fixture's provenance:

```yaml
---
id: case-01-...
fixture:
  provenance: product-path | recorded | synthetic   # REQUIRED
  setup: <command/path that creates the precondition>   # REQUIRED when provenance = product-path
---
```

- `product-path` — the precondition is produced by the product's own path, the one an operator takes. **Default.**
- `recorded` — captured from a real environment; carries a hash and a source.
- `synthetic` — hand-constructed. **MUST** carry a `justification`, and **MUST NOT** count as evidence for the path that would otherwise have created that precondition.
- Any capability that carries state (a schedule, an account, a permission, a subscription) **MUST** have at least one `product-path` case covering its **arm/setup** path — not only its **execute** path. Exercising `execute` against a hand-made precondition leaves `arm` completely unverified while the suite stays green.
- `scroll eval` **MUST** print provenance beside every verdict; `scroll audit` **MUST** warn when a capability is covered only by `synthetic` cases.

**Never hand-mutate the state of the system you are grading.** If a fixture must be hand-patched before a case will run, the case has just found a defect — not an inconvenience.

---

## Design note — §28–30 and the failure they answer

§21 (risk), §22 (grounding) and §1.4 (enforce at the tool boundary) compensate for weaknesses of the *model*: it does not understand consequences, it hallucinates identifiers, it will not stop on its own.

§28–30 compensate for weaknesses of the *engineers and operators*:

| mechanism | compensates for |
|---|---|
| §28 effect confirmation | a system that reports success for work it never performed — which an agent then relays in good faith |
| §29 ungraded ≠ pass | "no yardstick" being indistinguishable from "measured and good" |
| §30 fixture provenance | hand-patching a precondition and calling the result acceptance |

A harness that only guards against the model is half a harness.
