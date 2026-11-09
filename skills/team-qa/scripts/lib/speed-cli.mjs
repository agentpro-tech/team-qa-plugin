// `teamqa speed <action>` (upgrade R3). Each action prints one JSON document.
//   speed show --run <id>                 the run's speed policy, read from its signed plan, with what each flag skips and keeps
//   speed compare --off <id> --on <id>    the same cases both ways: misses, and the time receipts side by side (exit 1 on a miss)
//   speed cache-store --run <id> --case <case>   store a passed case's action steps in the run's output action cache
import { join } from 'node:path';
import { speedShow } from './speed.mjs';

export async function speedCommand(action, args, { parseFlags, fail, safeRunId }) {
  if (action === 'show') {
    const o = parseFlags(args, { '--run': { key: 'run', required: true } });
    const runDir = join(process.cwd(), 'runs', safeRunId(o.run));
    let shown;
    try { shown = speedShow(runDir); } catch (error) { fail(2, error.code ?? 'SPEED_POLICY_UNREADABLE', String(error.message)); }
    console.log(JSON.stringify(shown, null, 2));
    return;
  }
  if (action === 'compare') {
    const o = parseFlags(args, { '--off': { key: 'off', required: true }, '--on': { key: 'on', required: true } });
    const { compareSpeedRuns, readRunForCompare } = await import('./speed-compare.mjs');
    const at = (id) => join(process.cwd(), 'runs', safeRunId(id));
    const result = compareSpeedRuns({ off: readRunForCompare(at(o.off)), on: readRunForCompare(at(o.on)) });
    console.log(JSON.stringify({ off: o.off, on: o.on, ...result }, null, 2));
    if (result.verdict !== 'no-miss') process.exitCode = 1;
    return;
  }
  if (action === 'cache-store') {
    const o = parseFlags(args, { '--run': { key: 'run', required: true }, '--case': { key: 'caseId', required: true } });
    const runDir = join(process.cwd(), 'runs', safeRunId(o.run));
    const { qaGuiSpeedTools } = await import('./speed-collect.mjs');
    const tools = await qaGuiSpeedTools();
    if (!tools) fail(5, 'SPEED_QA_GUI_TOOLS_UNAVAILABLE', 'install the QA GUI that has the R3 speed tools next to Team QA, or set TEAMQA_QA_GUI_ROOT', 'ungraded');
    const { streamCalls } = await import('./web-collect.mjs');
    const { collectRunSecrets } = await import('./test-secrets.mjs');
    let stored;
    try { stored = await (await import('./speed-cache.mjs')).cacheStore({ runDir, caseId: o.caseId, tools, streamCalls, secrets: collectRunSecrets(runDir).secrets ?? [] }); }
    catch (error) { fail(error.code === 'ACTION_CACHE_SOURCE_NOT_PASS' ? 3 : 2, error.code ?? 'SPEED_CACHE_FAILED', String(error.message)); }
    console.log(JSON.stringify({ run: o.run, case: o.caseId, output: stored.output, sha256: stored.sha256, steps: stored.entry.steps.length, stripped: stored.stripped, expires_at: stored.entry.expires_at }, null, 2));
    return;
  }
  fail(2, 'COMMAND_UNKNOWN', `speed ${action ?? ''}`.trim());
}
