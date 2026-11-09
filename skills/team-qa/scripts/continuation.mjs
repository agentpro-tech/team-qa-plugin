import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fail, parseFlags, safeRunId, stableJson, writeConfirmed, sha256 } from './lib/core.mjs';
import { registerContinuation, readContinuation, unregisterContinuation } from './lib/continuation.mjs';
import { pluginInfo, pluginRegistryDir } from './lib/install-layout.mjs';

const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
// Homebrew keeps Node under <prefix>/Cellar/<formula>/<version>/bin/node, and `brew upgrade` removes that folder: a
// staged hook that named it stopped silently. A Cellar path is replaced by the formula's opt link
// (<prefix>/opt/<formula>/bin/node), which follows upgrades, or else by <prefix>/bin/node; any other path stays.
export function stableNodePath(nodePath, { exists = existsSync } = {}) {
  const match = /^(.+)\/Cellar\/([^/]+)\/[^/]+\/bin\/node$/.exec(String(nodePath));
  if (!match) return nodePath;
  for (const candidate of [join(match[1], 'opt', match[2], 'bin', 'node'), join(match[1], 'bin', 'node')]) if (exists(candidate)) return candidate;
  return nodePath;
}
export function hookDefinition({ registryDir, nodePath = process.execPath, hookPath = join(dirname(fileURLToPath(import.meta.url)), 'hooks/qa-lifecycle.mjs'),
  qaGuiRoot = process.env.TEAMQA_QA_GUI_ROOT, allowLocalCandidate = process.env.TEAMQA_ALLOW_LOCAL_CANDIDATE === 'yes', host = 'codex' }) {
  if (!['codex', 'claude'].includes(host)) fail(2, 'HOOK_HOST_UNSUPPORTED', 'codex|claude');
  if (![registryDir, nodePath, hookPath, ...(qaGuiRoot ? [qaGuiRoot] : [])].every(v => typeof v === 'string' && isAbsolute(v) && !/[\n\r\0]/.test(v))) fail(2, 'HOOK_ABSOLUTE_PATH_REQUIRED');
  nodePath = stableNodePath(nodePath);
  const env = [qaGuiRoot ? `TEAMQA_QA_GUI_ROOT=${quote(qaGuiRoot)}` : '', allowLocalCandidate ? 'TEAMQA_ALLOW_LOCAL_CANDIDATE=yes' : ''].filter(Boolean).join(' ');
  const command = `${env ? '/usr/bin/env ' + env + ' ' : ''}${quote(nodePath)} ${quote(hookPath)} --registry ${quote(registryDir)}`;
  const handler = timeout => ({ type: 'command', command, timeout });
  if (host === 'claude') {
    // Claude Code settings fragment (merge into .claude/settings.json `hooks`). Claude has no
    // Interrupt hook; tool hooks are limited to the shell and MCP tools the adapter inspects.
    const matcher = 'Bash|mcp__.*';
    return { hooks: {
      PreToolUse: [{ matcher, hooks: [handler(30)] }], PostToolUse: [{ matcher, hooks: [handler(30)] }],
      Stop: [{ hooks: [handler(30)] }], SubagentStop: [{ hooks: [handler(3)] }],
    } };
  }
  return { description: 'Team QA continuation, Dragon admission, and sealed board-write admission for explicitly registered runs only. User review/trust is required.', hooks: {
    PreToolUse: [{ hooks: [handler(30)] }], PostToolUse: [{ hooks: [handler(30)] }],
    Stop: [{ hooks: [handler(30)] }], SubagentStop: [{ hooks: [handler(3)] }], Interrupt: [{ hooks: [handler(3)] }],
  } };
}
export async function continuationCommand(action, args, { plugin = pluginInfo(), registryDir = pluginRegistryDir() } = {}) {
  if (action === 'stage-hooks') {
    // The plugin's hooks/hooks.json already runs these hooks for registered runs; a staged copy beside them would
    // refuse every tool call of the run as a duplicate (BA plugin C2, C4).
    if (plugin) fail(2, 'PLUGIN_HOOKS_ACTIVE', `the ${plugin.id} plugin runs the Team QA hooks already; nothing to stage`);
    const o = parseFlags(args, { '--registry': { key: 'registry', required: true }, '--out': { key: 'out', required: true }, '--host': { key: 'host' } });
    const definition = hookDefinition({ registryDir: resolve(o.registry), host: o.host || 'codex' }), bytes = stableJson(definition);
    await writeConfirmed(resolve(o.out), bytes, 'teamqa.hook.stage', { exclusive: true });
    console.log(stableJson({ path: resolve(o.out), sha256: sha256(bytes), activation: 'NOT_ACTIVATED', trust: 'USER_REVIEW_REQUIRED' }));
    return;
  }
  if (action === 'inspect') {
    const o = parseFlags(args, { '--run': { key: 'run', required: true } });
    console.log(stableJson(readContinuation({ runDir: join(process.cwd(), 'runs', safeRunId(o.run)) })));
    return;
  }
  if (action === 'register') {
    // In the plugin the registry is one fixed folder, the one its hooks read (C4).
    const o = parseFlags(args, { '--run': { key: 'run', required: true }, '--session': { key: 'session', required: true }, '--registry': { key: 'registry', required: !plugin } });
    if (plugin && o.registry && resolve(o.registry) !== resolve(registryDir)) fail(2, 'PLUGIN_REGISTRY_FIXED', `the plugin's hooks read ${registryDir}; leave out --registry`);
    const registry = plugin ? registryDir : o.registry;
    if (plugin) {
      mkdirSync(registry, { recursive: true, mode: 0o700 });
      // The hook wrapper (scripts/plugin/plugin-gate.sh) runs this Node first: Claude Code's hooks may not have the PATH
      // of the shell that found it.
      writeFileSync(join(registry, '.node'), stableNodePath(process.execPath) + '\n', { mode: 0o600 });
    }
    console.log(stableJson(await registerContinuation({ runDir: join(process.cwd(), 'runs', safeRunId(o.run)), sessionId: o.session, registryDir: registry })));
    return;
  }
  if (action === 'unregister') {
    // Ends a session's binding (a finished or drifted run): the binding file moves to <registry>/archive.
    const o = parseFlags(args, { '--session': { key: 'session', required: true }, '--registry': { key: 'registry', required: !plugin } });
    if (plugin && o.registry && resolve(o.registry) !== resolve(registryDir)) fail(2, 'PLUGIN_REGISTRY_FIXED', `the plugin's hooks read ${registryDir}; leave out --registry`);
    console.log(stableJson(unregisterContinuation({ registryDir: plugin ? registryDir : resolve(o.registry), sessionId: o.session })));
    return;
  }
  fail(2, 'CONTINUATION_COMMAND', 'register|unregister|inspect|stage-hooks');
}
