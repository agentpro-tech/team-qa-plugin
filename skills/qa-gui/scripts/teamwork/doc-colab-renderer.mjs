import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isDirectExecution } from '../lib/is-direct-execution.mjs';

import { validateCanonical } from './canonical.mjs';

// Doc-Colab: DOC_COLAB_SKILL_ROOT, else the Doc-Colab installed next to this QA GUI (a suite install into another root
// and the Team QA plugin keep skills side by side), else ~/.agents/skills/doc-colab (L1).
const QA_GUI_ROOT = fileURLToPath(new URL('../../', import.meta.url));
export function defaultDocColabRoot(env = process.env) {
  if (env.DOC_COLAB_SKILL_ROOT) return env.DOC_COLAB_SKILL_ROOT;
  let own = path.resolve(QA_GUI_ROOT);
  try { own = realpathSync(own); } catch { /* keep the path as it is */ }
  const sibling = path.join(path.dirname(own), 'doc-colab');
  if (existsSync(path.join(sibling, 'scripts', 'make_doc.py'))) return sibling;
  return path.join(homedir(), '.agents', 'skills', 'doc-colab');
}

function loadCanonical(source) {
  let canonical;
  try {
    canonical = JSON.parse(readFileSync(source, 'utf8'));
  } catch (error) {
    throw new Error(`cannot read canonical: ${error.message}`);
  }
  const validation = validateCanonical(canonical);
  if (!validation.ok) {
    const details = validation.errors.map((entry) => `${entry.path}: ${entry.message}`).join('\n');
    throw new Error(`canonical gate failed before Doc-Colab render\n${details}`);
  }
  return canonical;
}

function generatorPath(docColabRoot) {
  const generator = path.join(path.resolve(docColabRoot), 'scripts', 'make_doc.py');
  if (!existsSync(generator)) throw new Error(`Doc-Colab generator not found: ${generator}`);
  return generator;
}

function runGenerator(python, generator, args, label) {
  const run = spawnSync(python, [generator, ...args], { encoding: 'utf8', shell: false });
  if (run.error) throw new Error(`${label}: ${run.error.message}`);
  if (run.status !== 0) throw new Error(`${label}: ${(run.stderr || run.stdout || `exit ${run.status}`).trim()}`);
  const verdicts = String(run.stdout || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^verdict=(pass|fail|ungraded)(?:\s|$)/.test(line));
  if (verdicts.length !== 1 || !/^verdict=pass(?:\s|$)/.test(verdicts[0])) {
    throw new Error(`${label}: verifier must emit exactly one machine verdict=pass line`);
  }
  return run.stdout.trim();
}

export function verifyDocColabBoard({ input, output, docColabRoot = defaultDocColabRoot(), python = process.env.PYTHON || 'python3' }) {
  const source = path.resolve(String(input || ''));
  const destination = path.resolve(String(output || ''));
  loadCanonical(source);
  if (!existsSync(destination)) throw new Error(`Doc-Colab board not found: ${destination}`);
  const generator = generatorPath(docColabRoot);
  const verification = runGenerator(
    python,
    generator,
    ['--verify', destination, '--data', source, '--template', 'task-board'],
    'Doc-Colab integrity gate failed',
  );
  return { ok: true, output: destination, generator, verification };
}

export function renderDocColabBoard({ input, output, docColabRoot = defaultDocColabRoot(), python = process.env.PYTHON || 'python3' }) {
  const source = path.resolve(String(input || ''));
  const destination = path.resolve(String(output || ''));
  loadCanonical(source);
  const generator = generatorPath(docColabRoot);
  const stdout = runGenerator(
    python,
    generator,
    ['--template', 'task-board', '--data', source, '--out', destination],
    'Doc-Colab render failed',
  );
  if (!existsSync(destination)) throw new Error(`Doc-Colab render produced no output: ${destination}`);
  const verified = verifyDocColabBoard({ input: source, output: destination, docColabRoot, python });
  return { ok: true, output: destination, generator, stdout, verification: verified.verification };
}

function cli() {
  const args = process.argv.slice(2);
  const valuedFlags = new Set(['--out', '--verify-existing', '--doc-colab-root']);
  let input;
  for (let index = 0; index < args.length; index += 1) {
    if (valuedFlags.has(args[index])) {
      index += 1;
      continue;
    }
    if (!args[index].startsWith('--')) {
      input = args[index];
      break;
    }
  }
  const outIndex = args.indexOf('--out');
  const verifyIndex = args.indexOf('--verify-existing');
  const rootIndex = args.indexOf('--doc-colab-root');
  const output = verifyIndex >= 0 ? args[verifyIndex + 1] : args[outIndex + 1];
  if (!input || !output || (verifyIndex < 0 && outIndex < 0)) {
    process.stderr.write('usage: node scripts/teamwork/doc-colab-renderer.mjs <canonical.json> (--out <board.html> | --verify-existing <board.html>) [--doc-colab-root <skill-root>]\n');
    process.exit(2);
  }
  try {
    const params = {
      input,
      output,
      docColabRoot: rootIndex >= 0 ? args[rootIndex + 1] : undefined,
    };
    const result = verifyIndex >= 0 ? verifyDocColabBoard(params) : renderDocColabBoard(params);
    process.stdout.write(`${verifyIndex >= 0 ? 'Verified' : 'Doc-Colab QA board'}: ${result.output}\n${result.verification}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  }
}

if (isDirectExecution(import.meta.url)) cli();
