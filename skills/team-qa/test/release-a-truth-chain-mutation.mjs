import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SUITE = 'test/release-a-truth-chain.test.mjs';
const roots = [];

test.after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const mutations = [
  {
    id: 'M01-M02-NOT-APPLICABLE',
    file: 'scripts/teamqa.mjs',
    from: "function coveragePercent(covered, total) { return total === 0 ? 'N/A' : Math.round((covered / total) * 100); }",
    to: 'function coveragePercent(covered, total) { return total === 0 ? 100 : Math.round((covered / total) * 100); }',
    pattern: 'M01/M02',
  },
  {
    id: 'M04-UNGOVERNED',
    file: 'scripts/teamqa.mjs',
    from: "if (!existsSync(rolesPath)) fail(5, 'UNGOVERNED', 'roles.json', 'ungraded');",
    to: "if (false) fail(5, 'UNGOVERNED', 'roles.json', 'ungraded');",
    pattern: 'M04',
  },
  {
    id: 'M03-COMPUTED-GO',
    file: 'scripts/lib/release-truth.mjs',
    from: "const releaseVerdict = computedDecision === 'GO' && missingIds.length === 0 && rtm.filled === rtm.total ? 'GO' : 'NO-GO';",
    to: "const releaseVerdict = /Decision:\\s*\\*\\*GO\\*\\*/.test(summary) && missingIds.length === 0 && rtm.filled === rtm.total ? 'GO' : 'NO-GO';",
    pattern: 'M03',
  },
  {
    id: 'M05-EXACT-SCHEMA',
    file: 'scripts/lib/child-verdict.mjs',
    from: "if (claim.schema !== expectedSchema) return 'CHILD_RECEIPT_SCHEMA';",
    to: "if (!claim.schema.startsWith(`${bound.skill}/`)) return 'CHILD_RECEIPT_SCHEMA';",
    pattern: 'M05',
  },
  {
    id: 'M06-CASE-MEMBERSHIP',
    file: 'scripts/lib/child-verdict.mjs',
    from: "if (caseRows.length === 0) return 'CHILD_RECEIPT_CASE_MISSING';",
    to: "if (false) return 'CHILD_RECEIPT_CASE_MISSING';",
    pattern: 'M06',
  },
  {
    id: 'M16-SCHEMA-ALIGNMENT',
    file: 'scripts/teamqa.mjs',
    from: 'if (receiptDeclarations) verifyDeclaredReceiptSchemas(config, cwd);',
    to: 'if (receiptDeclarations) void config;',
    pattern: 'M16',
  },
];

test('Release A Team QA mutation registry kills every truth-chain bypass', () => {
  for (const mutation of mutations) {
    const sandbox = mkdtempSync(path.join(os.tmpdir(), `team-qa-release-a-mutant-${mutation.id}-`));
    roots.push(sandbox);
    cpSync(ROOT, sandbox, {
      recursive: true,
      filter: (source) => !source.includes(`${path.sep}.git${path.sep}`)
        && !source.includes(`${path.sep}dist${path.sep}`),
    });
    const target = path.join(sandbox, mutation.file);
    const source = readFileSync(target, 'utf8');
    assert.ok(source.includes(mutation.from), `${mutation.id}: mutation anchor missing`);
    writeFileSync(target, source.replace(mutation.from, mutation.to));
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const result = spawnSync(process.execPath, [
      '--test', '--test-name-pattern', mutation.pattern, SUITE,
    ], {
      cwd: sandbox,
      env,
      encoding: 'utf8',
      timeout: 120_000,
      maxBuffer: 32 * 1024 * 1024,
    });
    assert.equal(result.error, undefined, `${mutation.id}: ${result.error?.message}`);
    assert.notEqual(result.status, 0, `${mutation.id}: survived\n${result.stdout}\n${result.stderr}`);
  }
});
