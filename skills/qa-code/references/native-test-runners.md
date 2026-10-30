# Declared native test runners

`test_runners` extends the existing Gate0 test selection, not the acceptance denominator.
Omit it to retain the existing Node path. With it, each selected file must match exactly one
runner; unmapped or multiply mapped files are UNGRADED. Native coverage cannot lower 80 or a
higher frozen threshold. Existing coverage source inclusion, baseline regression, stability,
acceptance and security product-path rules remain in force.

Repo-local configuration example:

```json
{
  "coverage": {"threshold": 80, "testFiles": ["src/test/*.test.ts", "test/deno/*.test.ts"]},
  "test_runners": [
    {"type": "vitest", "testFiles": ["src/test/*.test.ts"], "config": "vitest.config.ts"},
    {"type": "deno", "testFiles": ["test/deno/*.test.ts"], "binary": "/absolute/verified/deno", "config": "deno-test.json", "permissions": ["--allow-env"]}
  ]
}
```

The closed fields are `type`, `testFiles`, `binary`, `config`, `permissions`, and `env`.
No arbitrary command, reporter, filter, pass-with-no-tests flag, threshold or extra argument
is accepted. Machine reports reconcile every selected physical file to executed assertions: Node
uses native events, Vitest JSON and Deno JUnit. Missing or extra files, zero passing assertions,
skips/todos and name-filtered assertions keep the group UNGRADED even if another file passes. Node rejects `config`; it cannot attest a file it does not consume. Configs
must resolve inside the repo. Declared environment values cannot replace PATH, HOME,
CODEX_HOME, NODE_OPTIONS or Node's coverage/test process controls.

Vitest uses the repo's installed Vitest and coverage-v8 with matching exact versions. It
runs the actual CLI under the pinned Node binary, forwarding the config, selected files
and native V8 LCOV options. TypeScript/TSX/JSON are loaded by the project's stack.

Deno requires an explicit existing absolute binary, records its actual version and binary
hash, and forwards the same config/import map and declared permissions to `deno test`.
The config's exact hash is recorded and checked after execution. Its native mapped LCOV
is preferred and retained. If conversion is necessary, the same config is also forwarded
to `deno coverage`; a converter that cannot consume it stays UNGRADED. Deno2.5.4 does not
accept `coverage --config`: the configured native test LCOV path works, but a missing
native report cannot fall back to another import map or a successful empty converter.

Evidence includes actual argv, runtime/config receipts, exit status, stdout/stderr and LCOV
producer/hash and an execution report with actual per-file passing/skipped/failed counts. Missing source rows count as zero patch coverage. Loader errors, zero tests,
contradictory summaries and missing mapped LCOV do not prove PASS or semantic RED.
Acceptance runs the same final assertions against immutable baseline and candidate code;
baseline assertion failure is distinct from inability to load the native stack.

Scratch, scanner reports and snapshots are archived. Vitest's generated cache/config cleanup
uses an archive adapter limited to declared owned generated paths; unexpected removal fails
closed. No product source or dependency is cleaned. Fixture tests require actual binaries
to claim native proof; a skipped runtime test does not establish compatibility.

## Local proof commands

Supply actual fixture runtimes with `QA_CODE_VITEST_FIXTURE_MODULES`,
`QA_CODE_DENO_FIXTURE_BINARY` and `QA_CODE_GITLEAKS_FIXTURE_BINARY`; set
`QA_CODE_ARCHIVE_ROOT` outside owned scratch. Run:

```sh
node --test test/native-stack-runners.test.mjs test/native-gate0-integration.test.mjs
```

These local machine checks are tooling evidence, not app acceptance or an approved current
TeamQA grade. Source/package review and verified reversible runtime cutover remain separate.

Node coverage emits TAP to stdout and LCOV to its existing file in the same test process. Assertion and loader failures remain visible alongside native coverage; the default Gate0 Node path without test_runners remains unchanged. Declared Node runners add TAP and a file identity reporter in both modes.

CI provisions Vitest and coverage-v8 3.2.4, Deno 2.5.4 and Gitleaks 8.30.1 before the
full source suite. The fixture Deno path is the actual executable, not npm's Node launcher;
fixture PATH isolation must not depend on a globally discoverable Node binary.

CI sets QA_CODE_ARCHIVE_ROOT under RUNNER_TEMP outside HOME, so fixture HOME overrides
do not receive scanner/scratch archives. Missing installed TeamQA is an explicit domain
denial; portable negative proof tests do not require installing a reviewer runtime.
