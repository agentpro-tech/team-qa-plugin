#!/usr/bin/env node
import { accessSync, constants, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

function die(code, message) {
  console.error(message);
  process.exit(code);
}

function payload() {
  const raw = process.env.TEAMQA_MIRROR_PAYLOAD;
  if (!raw) die(2, 'MIRROR_PAYLOAD_MISSING');
  try {
    return JSON.parse(raw);
  } catch {
    die(2, 'MIRROR_PAYLOAD_INVALID');
  }
}

function safePart(value, name) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(value)) {
    die(2, `MIRROR_${name}_INVALID`);
  }
  return value;
}

function locations(value) {
  const project = resolve(process.env.TEAMQA_PROJECT_ROOT ?? process.cwd());
  const runId = safePart(value.run_id, 'RUN_ID');
  if (!Number.isInteger(value.version) || value.version < 1) die(2, 'MIRROR_VERSION_INVALID');
  const slug = `${value.kind}-v${value.version}`;
  return {
    data: join(project, 'runs', runId, 'mirror', `${slug}.doc-colab.json`),
    html: join(project, 'collab', `team-qa-${runId}`, slug, 'index.html'),
  };
}

function scriptPath() {
  return resolve(process.env.TEAMQA_DOC_COLAB_SCRIPT
    ?? join(homedir(), '.agents', 'skills', 'doc-colab', 'scripts', 'make_doc.py'));
}

function probe() {
  const script = scriptPath();
  try {
    accessSync(script, constants.R_OK);
  } catch {
    die(9, 'DOC_COLAB_UNAVAILABLE');
  }
  const result = spawnSync('python3', [script, '--help'], { encoding: 'utf8', timeout: 10_000 });
  if (result.status !== 0) die(9, 'DOC_COLAB_UNAVAILABLE');
  console.log(JSON.stringify({ available: true }));
}

function publish() {
  const value = payload();
  const paths = locations(value);
  const kind = value.kind === 'plan' ? 'Plan approval' : 'Summary report';
  const data = {
    template: 'doc',
    icon: value.kind === 'plan' ? '🧭' : '📋',
    title: `Team QA · ${kind} · ${value.run_id} · v${value.version}`,
    agent: 'Team QA',
    teamqa_payload: value,
    blocks: [
      { id: 'source', type: 'callout', icon: '🔒', text: `Git source of truth · SHA-256 ${value.content_sha256}` },
      { id: 'artifact', type: 'code', lang: 'markdown', code: value.content },
      ...(value.kind === 'plan'
        ? [{ id: 'signed', type: 'todo', text: 'Signed — after ticking, harden, then run teamqa gate approve', checked: false }]
        : []),
    ],
  };
  mkdirSync(dirname(paths.data), { recursive: true });
  writeFileSync(paths.data, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  JSON.parse(readFileSync(paths.data, 'utf8'));
  const result = spawnSync('python3', [
    scriptPath(), '--template', 'doc', '--data', paths.data, '--out', paths.html,
  ], { encoding: 'utf8', timeout: 30_000 });
  if (result.status !== 0 || result.signal) die(1, result.stderr || result.stdout || 'DOC_COLAB_PUBLISH_FAILED');
  const html = readFileSync(paths.html, 'utf8');
  if (!html.includes('DOC_DATA_START') || !html.includes(value.content_sha256)) die(1, 'DOC_COLAB_WRITE_UNCONFIRMED');
  console.log(JSON.stringify({ published: true, path: paths.html }));
}

function readback() {
  const value = payload();
  const { html } = locations(value);
  let text;
  try {
    text = readFileSync(html, 'utf8');
  } catch {
    die(2, 'DOC_COLAB_READBACK_MISSING');
  }
  const match = text.match(/window\.DOC_DATA = (\{[\s\S]*?\});\s*\n<\/script>/);
  if (!match) die(2, 'DOC_COLAB_READBACK_INVALID');
  let data;
  try {
    data = JSON.parse(match[1].replaceAll('<\\/', '</'));
  } catch {
    die(2, 'DOC_COLAB_READBACK_INVALID');
  }
  if (!data.teamqa_payload) die(2, 'DOC_COLAB_PAYLOAD_MISSING');
  console.log(JSON.stringify(data.teamqa_payload));
}

const operation = process.argv[2];
if (operation === 'probe') probe();
else if (operation === 'publish') publish();
else if (operation === 'readback') readback();
else die(2, `DOC_COLAB_OPERATION_UNKNOWN ${operation ?? ''}`);
