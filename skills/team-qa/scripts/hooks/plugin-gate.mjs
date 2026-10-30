// Hook entry of the Team QA plugin for Claude Code (BA plugin C4). While the plugin is enabled, Claude Code runs it on
// every Bash and MCP tool call, every Stop and every SubagentStop of every session. Team QA acts only on a session that
// `teamqa continuation register` bound to a run, in the plugin's fixed registry (~/.agentpro/teamqa/continuation). For
// any other session, the workers Team QA starts included, it prints {} and exits without loading the rest of Team QA,
// writing a file or using the network. A registered session goes to the same handler as the staged hooks
// (qa-lifecycle.mjs): continuation, Dragon admission and board-write admission.
import { existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pluginRegistryDir } from '../lib/install-layout.mjs';

const SAFE_SESSION = /^[A-Za-z0-9_-]{1,128}$/;

// 'none' only when the session id is well formed and has no binding; anything else goes to the full handler, which
// refuses what it cannot verify.
export function sessionBinding(input, registry = pluginRegistryDir()) {
  const id = input?.session_id;
  if (typeof id !== 'string' || !SAFE_SESSION.test(id)) return 'unknown';
  return existsSync(join(registry, `${id}.json`)) ? 'registered' : 'none';
}

export async function pluginHook(input, { registry = pluginRegistryDir(), handle = null } = {}) {
  if (sessionBinding(input, registry) === 'none') return {};
  const handler = handle ?? (await import('./qa-lifecycle.mjs')).handleQaHook;
  return handler(input, { registryDir: registry });
}

async function errorOutput(input, error) {
  const code = error?.code || error?.message || 'QA_HOOK_FAILED';
  if (input?.hook_event_name === 'PreToolUse') return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: code } };
  const { WAIT_MARKER } = await import('../lib/report-tokens.mjs');
  return { systemMessage: `QA ${WAIT_MARKER}: hook error ${code}` };
}

// Compared through realpath: Node gives import.meta.url its real path, and the plugin may sit under a symlink (macOS
// /tmp, a linked home). A plain path compare there made the script exit 0 without printing anything.
const isMain = () => { try { return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } };
if (isMain()) {
  let raw = '', input = null, output = {};
  try {
    for await (const chunk of process.stdin) { raw += chunk; if (Buffer.byteLength(raw) > 4 * 1024 * 1024) throw new Error('HOOK_INPUT_TOO_LARGE'); }
    input = JSON.parse(raw);
  } catch {
    // Claude Code always sends one JSON object. Input that is not one cannot name a registered run.
    input = null;
  }
  if (input) {
    try { output = await pluginHook(input); } catch (error) { output = await errorOutput(input, error); }
  }
  process.stdout.write(JSON.stringify(output) + '\n');
}
