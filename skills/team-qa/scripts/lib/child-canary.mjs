import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fail, runAdapter } from './core.mjs';

// The commands used as a child skill's canary, in order of priority. When a separate
// `canary` is declared, use it; otherwise use the declared gate itself.
const CANARY_COMMANDS = ['canary', 'gate', 'gate0'];
const DEFAULT_TIMEOUT_MS = 15_000;

function firstLine(value) {
  return String(value ?? '').split('\n')[0].slice(0, 200);
}

function timeoutMs() {
  const raw = Number(process.env.TEAMQA_CANARY_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TIMEOUT_MS;
}

// The canary input is a deliberately wrong file: not a board, no verdict. A real gate
// must reject it.
export function canaryInputPath(repoRoot) {
  return join(repoRoot, 'fixtures', 'canary', 'child-gate-canary.html');
}

export function pickCanaryCommand(declared) {
  const commands = declared?.commands;
  if (!commands || typeof commands !== 'object' || Array.isArray(commands)) return null;
  for (const name of CANARY_COMMANDS) {
    if (Object.hasOwn(commands, name)) return { name, command: commands[name] };
  }
  return null;
}

// Really run the declared child gate with the canary input, then classify the result. It counts as
// measured only when the process finished, did NOT accept the wrong input, and gave a reason. Every
// other branch is ungraded, not pass.
export function runChildCanary({ skill, declared, cwd, repoRoot }) {
  const picked = pickCanaryCommand(declared);
  if (!picked) return `${skill} canary=undeclared`;
  const label = `${skill} command=${picked.name}`;
  const { command } = picked;
  if (!Array.isArray(command) || command.length === 0
    || command.some((part) => typeof part !== 'string' || part.length === 0)) {
    fail(2, 'SKILL_COMMAND_INVALID', label);
  }
  const input = canaryInputPath(repoRoot);
  if (!existsSync(input)) fail(5, 'CHILD_CANARY_INPUT_MISSING', `${label} input=${input}`, 'ungraded');
  const result = runAdapter([...command, input], {
    cwd,
    timeout: timeoutMs(),
    env: { TEAMQA_CHILD_CANARY: '1' },
  });
  if (result.error) fail(5, 'CHILD_CANARY_UNINVOKABLE', `${label} ${firstLine(result.error)}`, 'ungraded');
  if (result.signal) fail(5, 'CHILD_CANARY_UNINVOKABLE', `${label} signal=${result.signal}`, 'ungraded');
  if (result.status === 0) fail(5, 'CHILD_CANARY_ACCEPTED_BAD_INPUT', `${label} exit=0`, 'ungraded');
  const output = `${result.stdout}${result.stderr}`.trim();
  if (output.length === 0) fail(5, 'CHILD_CANARY_SILENT', `${label} exit=${result.status}`, 'ungraded');
  return `${skill} canary=${picked.name} rejected exit=${result.status}`;
}
