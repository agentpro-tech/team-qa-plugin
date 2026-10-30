# QA Code in the age of AI agents — research freeze 2026-08-11

## Conclusion

QA for agent-written code is moving from “read the diff and give an opinion” to verifying a system made of code, yardstick, runtime environment, action chain and artifact provenance. The common pattern across the sources is: machines check first; tests must be fail-to-pass and must not break pass-to-pass; security defects must be reproducible; trajectory and runtime must have receipts; input meant for agents is an attack surface; every part that cannot run must stay ungraded.

This round only picks features that can be checked with deterministic tests, keeps the runtime zero-dependency and stays backward compatible with `qa-code-v1.0.0`. It does not change Production on its own, does not merge `main`, does not replace human QA and does not let an LLM confirm its own patch.

## The ten chosen features

### F01 Runtime and toolchain receipts

Gate 0 must record platform, architecture, Node path/version and the path/version of every real checker that ran. The receipt helps tell code defects apart from environment drift; a missing receipt for a required checker is `ungraded`.

Yardstick: a fixture with a real binary/stub that declares a version; the output is stable and must not record a fake `pass` when the version probe breaks.

### F02 Layer time budgets and timing

Every machine layer needs a finite timeout and a `duration_ms`; a timeout returns `ungraded`/exit 20. The total time must also have a receipt so that runs under the same conditions can be compared.

Yardstick: a checker that deliberately hangs past the budget is blocked, the process ends and the JSON stays valid.

### F03 Flaky-test stability gate

One green run is not enough when an agent may accidentally create a nondeterministic test. An opt-in configuration runs 2–5 times, records the outcomes and rejects an inconsistent result series.

Yardstick: a fixture that alternates green/red must not count as pass; a stable fixture keeps the old path.

### F04 Fail-to-pass, pass-to-pass traceability

Acceptance must have a requirement ID and two classes of tests: new behavior must go from red to green; old behavior must stay green. A contract with a missing requirement, a missing file, a duplicate ID or an empty class is rejected before review.

Yardstick: good/incomplete/inconsistently wide-or-narrow contracts get a deterministic verdict; no implementation detail beyond the requirement is forced.

### F05 Repository prompt-injection scan

Markdown, config and instructions in the repo are untrusted input for a coding agent. Scan only added lines on the surface meant for agents, focusing on hidden Unicode/control characters, explicit instruction hijack and requests to exfiltrate secrets; a finding must have `file:line`.

Yardstick: a real payload is red; normal security documentation is not red just because it mentions the terms.

### F06 Change-aware threat-model gate

A diff that touches the existing trigger groups `auth/payment/permission/migration/secret` must point to a threat-model JSON with entry points, trust boundaries, sensitive assets and high-impact sinks. This is a contract that humans can check, not a threat model hidden by an LLM in its reasoning.

Yardstick: a risky diff with a missing/malformed model fails closed; a diff without risk is not blocked unfairly.

### F07 Security product-path acceptance

Machines must enforce rule L9, which for now lives only in prose: a risky diff needs at least one security acceptance test that goes through the product path, runs with the pinned Node and has command/status evidence.

Yardstick: a correct test runs green; a file that does not exist, a skip or a command that does not execute becomes `ungraded`.

### F08 Reachability-aware CVE evidence

OSV v2 has call analysis to tell whether vulnerable code is called, not called or unknown. QA Code must keep every finding but normalize reachability; the default policy does not change, and only an opt-in policy may prioritize reachable findings.

Yardstick: OSV v2 JSON for the three states is parsed correctly; an advisory without call data is not inferred as `false`.

### F09 Agent trajectory audit

A diff only shows the final state. Agentic QA also needs to check the tool sequence, tool failures, writes outside the repo, destructive commands, test execution and terminal completion from the JSONL log.

Yardstick: a zero-dependency CLI returns JSON `pass|fail|ungraded`; a malformed/truncated log never passes.

### F10 Finding evidence anchor

`file:line` can currently be valid by schema but point to the wrong commit or the wrong diff. The validator needs a grounding mode with repo/base: A/B must point to a file and line that really exist at the verdict commit, on an added line or explicitly declared `pre_existing`.

Yardstick: a real anchor passes; a stale SHA, a line outside the file and a line not in the diff reject the whole verdict.

## Sources

1. [Anthropic — Demystifying evals for AI agents](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents): coding-agent evals need a clear task, a stable environment, several graders and several trials.
2. [OpenAI — Separating signal from noise in coding evaluations](https://openai.com/index/separating-signal-from-noise-coding-evaluations/): tests that are too narrow, incomplete prompts, low coverage and failure traces lead to wrong conclusions; evals must be QA'd like a product.
3. [OpenAI — Codex Security](https://help.openai.com/en/articles/20001107): a per-repo threat model, reproduction in an isolated environment, proof and revalidation before surfacing a finding.
4. [GitHub — Risks and mitigations for Copilot cloud agent](https://docs.github.com/en/copilot/concepts/agents/cloud-agent/risks-and-mitigations): branch/credential restriction, security validation, prompt injection filtering, signed commits and session logs.
5. [OWASP — Secure Coding with AI Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Secure_Coding_with_AI_Cheat_Sheet.html): repo prompt injection, supply chain, confused deputy, Unicode/markdown and propagation between agents.
6. [Google — Agents CLI Evaluation Guide](https://google.github.io/agents-cli/guide/evaluation/): code graders, tool-use/trajectory quality, sandboxed execution, baseline comparison and failure clustering.
7. [GitHub — Artifact attestations](https://docs.github.com/en/actions/concepts/security/artifact-attestations): provenance tied to repository, commit, workflow and SBOM; an attestation does not replace a security verdict.
8. [Google — OSV-Scanner output and call analysis](https://google.github.io/osv-scanner/output/): machine-readable JSON, fixed versions and called/uncalled evidence.
9. [Anthropic — Quantifying infrastructure noise in agentic coding evals](https://www.anthropic.com/engineering/infrastructure-noise): resource/time configuration is a first-class experimental variable and can flip benchmark results.
10. [Meta — Mutation-guided LLM test generation](https://engineering.fb.com/2025/02/05/security/revolutionizing-software-testing-llm-powered-bug-catchers-meta-ach/): a surviving mutant must lead to a specific regression test.
11. [OpenAI — Introducing SWE-bench Verified](https://openai.com/index/introducing-swe-bench-verified/): both `FAIL_TO_PASS` and `PASS_TO_PASS` are required to confirm a fix without regression.
12. [NIST — Secure Software Development Framework](https://csrc.nist.gov/projects/ssdf): security practice must be built into the SDLC and address root causes, not be a separate review.

## Not included in this round

- A council of several models from the same vendor, or a third LLM to mediate.
- Automatically applying security fixes from a reviewer.
- Catching style/naming with an LLM.
- Adding a framework, database, queue or runtime dependency.
- Replacing Gate 0 with public benchmarks that are prone to contamination.
