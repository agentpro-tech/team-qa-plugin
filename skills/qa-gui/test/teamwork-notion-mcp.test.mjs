import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  NOTION_COLUMNS, NOTION_TEXT_LIMIT, compareNotionMcp, decodeNotionValue, notionMcpProjection, portablePath, text,
} from '../scripts/teamwork/notion-mcp.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const examplePath = join(root, 'scripts/teamwork/example-canonical.json');
const example = () => JSON.parse(readFileSync(examplePath, 'utf8'));
const SHA = createHash('sha256').update(readFileSync(examplePath)).digest('hex');
const OPTIONS = { version: '1.16.0', runId: 'run-notion-1', boardSha256: SHA };

// What Notion's rows mode returns for a value written as plain text (seen on a live data source, 04/11/2026).
function notionRowsEncode(value) {
  if (typeof value !== 'string') return value;
  return value.replace(/([.<\\])/g, (m) => (m === '.' ? '\\.' : m === '<' ? '\\<' : '\\\\')).replace(/\n/g, '<br />');
}
function readbackFrom(projection, mode) {
  const out = {};
  for (const db of ['cases', 'defects']) {
    out[db] = { mode, results: projection.rows[db].map((row) => {
      const values = Object.fromEntries(Object.entries(row.properties).map(([k, v]) => {
        if (mode === 'sql') return [k, v === '' ? null : v];
        return [k, notionRowsEncode(v)];
      }));
      return { ...values, url: `https://app.notion.com/p/${row.externalId}` };
    }) };
  }
  return out;
}

test('projection: two databases with fixed English columns, provenance and one row per case and defect', () => {
  const data = example();
  const p = notionMcpProjection(data, OPTIONS);
  assert.equal(p.protocol, 'qa-gui/notion-mcp/v1');
  assert.equal(p.databases.cases.title, `${data.title} · Cases`);
  assert.equal(p.databases.defects.title, `${data.title} · Defects`);
  assert.equal(p.provenance, `Team QA 1.16.0 · run run-notion-1 · qa-board ${SHA.slice(0, 12)} · rev ${data.rev}`);
  assert.equal(p.databases.cases.description, p.provenance);
  for (const db of ['cases', 'defects']) {
    for (const [name] of NOTION_COLUMNS[db]) assert.ok(p.databases[db].schema.includes(`"${name}"`), `${db} schema lacks ${name}`);
    assert.ok(p.databases[db].schema.startsWith('CREATE TABLE ('));
  }
  assert.equal(p.rows.cases.length, data.cases.length);
  assert.equal(p.rows.defects.length, data.defects.length);
  assert.equal(p.rows.cases[0].properties['External ID'], data.cases[0].id);
  assert.equal(p.rows.cases[0].properties.Order, 1);
  assert.match(p.rows.cases[0].properties['Row SHA'], /^[a-f0-9]{16}$/);
  assert.equal(p.rows.defects[0].properties['Retest case'], data.defects[0].caseId);
});

test('projection refuses a board without version, run or sha', () => {
  assert.throws(() => notionMcpProjection(example(), { ...OPTIONS, version: '' }), /version/);
  assert.throws(() => notionMcpProjection(example(), { ...OPTIONS, boardSha256: 'abc' }), /sha256/);
});

test('compare: a readback in sql mode and in rows mode (Notion-escaped) both match 100%', () => {
  const data = example();
  const p = notionMcpProjection(data, OPTIONS);
  for (const mode of ['sql', 'rows']) {
    const r = compareNotionMcp(data, readbackFrom(p, mode), OPTIONS);
    assert.equal(r.ok, true, `${mode}: ${JSON.stringify(r.mismatches).slice(0, 400)}`);
    assert.equal(r.matchPercent, 100);
  }
});

test('compare: one changed cell, a missing row, an extra row and a duplicate row each fail and say where', () => {
  const data = example();
  const p = notionMcpProjection(data, OPTIONS);
  const changed = readbackFrom(p, 'sql');
  changed.cases.results[0].Expected = 'something else';
  let r = compareNotionMcp(data, changed, OPTIONS);
  assert.equal(r.ok, false);
  assert.deepEqual(r.mismatches.map((m) => [m.database, m.externalId, m.field]), [['cases', data.cases[0].id, 'Expected']]);

  const missing = readbackFrom(p, 'sql'); missing.defects.results = [];
  r = compareNotionMcp(data, missing, OPTIONS);
  assert.equal(r.ok, false);
  assert.ok(r.mismatches.some((m) => m.database === 'defects' && m.reason === 'missing row'));

  const extra = readbackFrom(p, 'sql'); extra.cases.results.push({ ...extra.cases.results[0], 'External ID': 'TC-HAND-MADE' });
  r = compareNotionMcp(data, extra, OPTIONS);
  assert.ok(r.mismatches.some((m) => m.externalId === 'TC-HAND-MADE' && m.reason === 'unexpected row'));

  const dup = readbackFrom(p, 'sql'); dup.cases.results.push({ ...dup.cases.results[0] });
  r = compareNotionMcp(data, dup, OPTIONS);
  assert.ok(r.mismatches.some((m) => m.reason === 'duplicate row'));

  r = compareNotionMcp(data, { cases: readbackFrom(p, 'sql').cases }, OPTIONS);
  assert.ok(r.mismatches.some((m) => m.database === 'defects' && m.reason === 'missing readback'));
});

test('compare: a readback taken from another revision of the board does not match', () => {
  const data = example();
  const p = notionMcpProjection(data, OPTIONS);
  const next = structuredClone(data); next.cases[0].title = '\u0110\u1ed5i t\u00ean sau khi \u0111\u1ea9y l\u00ean';
  const r = compareNotionMcp(next, readbackFrom(p, 'sql'), OPTIONS);
  assert.equal(r.ok, false);
  assert.ok(r.mismatches.some((m) => m.field === 'Case'));
});

test('decode: line breaks and escaped punctuation from rows mode; sql values unchanged; empty is empty', () => {
  assert.equal(decodeNotionValue('1\\. M\u1edf<br />2. B\u1ea5m \\<b>', 'rows'), '1. M\u1edf\n2. B\u1ea5m <b>');
  assert.equal(decodeNotionValue('1. M\u1edf\n2.', 'sql'), '1. M\u1edf\n2.');
  assert.equal(decodeNotionValue(null, 'sql'), '');
  assert.equal(decodeNotionValue(undefined, 'rows'), '');
});

test('portable paths and the text limit', () => {
  assert.equal(portablePath('/Users/someone/qa/evidence/after.png'), 'after.png');
  assert.equal(portablePath('C:\\Users\\someone\\after.png'), 'after.png');
  assert.equal(portablePath('evidence/TC-01/after.png'), 'evidence/TC-01/after.png');
  const long = 'x'.repeat(NOTION_TEXT_LIMIT + 50);
  assert.equal(text(long).length, NOTION_TEXT_LIMIT + 1);
  assert.ok(text(long).endsWith('…'));
});

test('cli: export-notion-mcp then compare-notion-mcp; a changed readback exits 1 with the mismatch receipt', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qa-gui-notion-mcp-'));
  const cli = join(root, 'scripts/teamwork/cli.mjs');
  const out = join(dir, 'projection.json');
  let run = spawnSync(process.execPath, [cli, 'export-notion-mcp', '--file', examplePath, '--out', out, '--version', '1.16.0', '--run', 'run-notion-1'], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  const exported = JSON.parse(run.stdout);
  assert.equal(exported.board_sha256, SHA);
  const projection = JSON.parse(readFileSync(out, 'utf8'));
  const readback = join(dir, 'readback.json');
  writeFileSync(readback, JSON.stringify(readbackFrom(projection, 'rows')));
  run = spawnSync(process.execPath, [cli, 'compare-notion-mcp', '--file', examplePath, '--readback', readback, '--version', '1.16.0', '--run', 'run-notion-1'], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(JSON.parse(run.stdout).ok, true);
  const bad = readbackFrom(projection, 'rows'); bad.cases.results[0].Status = 'PASS-by-hand';
  writeFileSync(readback + '.bad', JSON.stringify(bad));
  run = spawnSync(process.execPath, [cli, 'compare-notion-mcp', '--file', examplePath, '--readback', readback + '.bad', '--version', '1.16.0', '--run', 'run-notion-1'], { encoding: 'utf8' });
  assert.equal(run.status, 1);
  assert.equal(JSON.parse(run.stderr).mismatches[0].field, 'Status');
});
