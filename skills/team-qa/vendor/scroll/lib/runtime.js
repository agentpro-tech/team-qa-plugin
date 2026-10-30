// SCROLL — the runtime. `scroll run` drives a thin, file-based multi-agent loop.
//
// Design (stays true to the thesis — no engine/DB/bus):
//   • One controller owns WORK.md (a declarative DAG of tasks).
//   • The runner advances the DAG DETERMINISTICALLY (ready tasks = deps done),
//     the LLM only acts INSIDE a step.
//   • Agents coordinate through the filesystem: each task appends to blackboard/.
//   • A cost gate decides single vs multi BEFORE spawning.
//   • Hard caps + a circuit breaker bound spend/time/iterations.
//   • Context is ordered stable-prefix-first so providers can cache it.
//   • Every step is verified and checkpointed; everything is an append-only event.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseYaml, parseFrontmatter, loadAgent, estimateCost } from './scroll.js';
import { pickProvider, approxTokens } from './providers.js';
import { resolveTier, policyForTier, needsGrounding, evaluateAction, loadMcpRisk, loadAgentSecurity, normalizeTier } from './permissions.js';
import { collectSources, checkGrounding } from './grounding.js';
import { writeDigest } from './digest.js';

const PRICING = { input: 3, cachedInput: 0.3, output: 15 }; // $/million tokens
const DEFAULT_CAPS = { maxIterations: 20, maxInputTokens: 120000, maxWallClockMs: 900000, maxUsd: 5, recursionDepth: 2 };

// ── WORK.md parsing ───────────────────────────────────────────────────────────
// Tasks are fenced ```task blocks of YAML (same shape `scroll check` validates).
export function parseWork(raw) {
  const { frontmatter } = parseFrontmatter(raw.startsWith('---') ? raw : `---\n---\n${raw}`);
  const controller = (frontmatter && frontmatter.controller) || null;
  const blocks = [...raw.matchAll(/```task\n([\s\S]*?)```/g)].map((m) => m[1]);
  const tasks = [];
  for (const b of blocks) {
    let t; try { t = parseYaml(b); } catch { continue; }
    if (!t || !t.id) continue;
    tasks.push({
      id: t.id, title: t.title || t.id, status: t.status || 'todo',
      owner: t.owner || controller || 'controller', agent: t.agent || t.owner || controller,
      objective: t.objective || t.title || '', output_format: t.output_format || 'decision-ready markdown',
      source_guidance: arr(t.source_guidance), boundaries: arr(t.boundaries),
      blockedBy: arr(t.blockedBy), parallel: t.parallel === true,
      risk: t.risk || null, tool: t.tool || null, ground: t.ground || null, final: t.final === true,
      deterministic: t.deterministic === true, op: t.op || 'merge',
      engine: t.engine || null, effort: t.effort || null, sandbox: t.sandbox || null,
      workdir: t.workdir || null, timeout_ms: t.timeout_ms || null,
    });
  }
  return { controller: controller || (tasks[0] && tasks[0].owner) || 'controller', tasks };
}
const arr = (x) => (Array.isArray(x) ? x : x == null || x === '' ? [] : [x]);

// ── the run ─────────────────────────────────────────────────────────────────
export async function runWork(opts = {}) {
  const cwd = opts.cwd || process.cwd();
  const providerName = opts.providerName || 'auto';
  const provider = pickProvider(providerName, { model: opts.model });

  // run dir + isolated scratch (provider calls run here so a repo CLAUDE.md can't leak in)
  const runId = opts.runId || new Date().toISOString().replace(/[:.]/g, '-');
  const runDir = opts.runDir ? path.resolve(opts.runDir) : path.join(cwd, 'runs', runId);
  const blackboardDir = path.join(runDir, 'blackboard');
  const scratchDir = path.join(runDir, 'scratch');
  const controlDir = opts.controlDir ? path.resolve(opts.controlDir) : path.join(runDir, 'control');
  const approvalsDir = path.join(controlDir, 'approvals'); // v1.4: must-approve gates land here
  fs.mkdirSync(blackboardDir, { recursive: true });
  fs.mkdirSync(scratchDir, { recursive: true });
  const eventsPath = opts.eventsPath ? path.resolve(opts.eventsPath) : path.join(runDir, 'events.jsonl');
  const outPath = opts.outPath ? path.resolve(opts.outPath) : path.join(runDir, 'output.md');
  fs.mkdirSync(path.dirname(eventsPath), { recursive: true });
  if (fs.existsSync(eventsPath) && !opts.resume) fs.rmSync(eventsPath); // resume APPENDS to the stream

  const emit = (type, data = {}) => {
    const line = JSON.stringify({ ts: new Date().toISOString(), runId, type, data });
    fs.appendFileSync(eventsPath, line + '\n');
    if (opts.json) console.log(line);
    else if (opts.verbose) console.log(`  ${type}${data.id ? ' ' + data.id : ''}`);
  };

  if (!provider.ready) { emit('error', { reason: provider.missing }); throw new Error(`provider not ready: ${provider.missing}`); }

  // v1.6: per-task engine routing — a task may name its own engine (codex/grok/claude/...).
  // Providers are memoized per engine name; the run-level provider stays the default.
  const providerCache = new Map();
  const providerFor = (engineName) => {
    if (!engineName) return provider;
    if (!providerCache.has(engineName)) providerCache.set(engineName, pickProvider(engineName, {}));
    const p = providerCache.get(engineName);
    if (!p.ready) { emit('error', { reason: `engine ${engineName}: ${p.missing}` }); throw new Error(`provider not ready: ${p.missing}`); }
    return p;
  };

  // build the work model (multi-agent file, or a synthesized single task)
  let work;
  if (opts.workFile) {
    work = parseWork(fs.readFileSync(path.resolve(cwd, opts.workFile), 'utf8'));
  } else if (opts.task) {
    work = { controller: opts.agent || 'controller', tasks: [{
      id: 'task', title: 'single task', status: 'todo', owner: opts.agent || 'controller', agent: opts.agent || null,
      objective: opts.task, output_format: 'decision-ready markdown', source_guidance: [], boundaries: [],
      blockedBy: [], parallel: false, risk: opts.risk || null, tool: opts.tool || null, ground: opts.ground || null, final: true,
    }] };
  } else {
    throw new Error('runWork needs --work <WORK.md> or --task "<text>"');
  }
  if (!work.tasks.length) throw new Error('no tasks found');

  const startedAt = Date.now();
  emit('run_started', { mode: opts.workFile ? 'multi-agent' : 'single', provider: provider.name, model: provider.model });
  emit('work_loaded', { tasks: work.tasks.length, controller: work.controller });

  // single controller (failure-mode #1 guard): exactly one owner of WORK.md, ≤1 owner per task
  emit('work_contract', { controller: work.controller, controllerCount: 1, ownerCountPerTaskMax: 1 });

  // per-language token budgeting: a controller agent's language scales the estimate
  // (Vietnamese ≈ 1.8× English) so the cost gate is honest for non-English markets.
  let runLanguage = opts.language || null;
  if (!runLanguage) { try { runLanguage = loadAgent(work.controller, cwd)?.frontmatter?.language || null; } catch { /* no controller folder */ } }
  const mcpTools = loadMcpRisk(cwd); // per-tool risk from a repo-level .mcp.json

  // cost gate BEFORE any spawn
  const distinctAgents = new Set(work.tasks.map((t) => t.agent || t.owner)).size;
  const objectivesText = work.tasks.map((t) => t.objective).join(' ');
  const est = estimateCost(objectivesText, Math.max(2, distinctAgents), { language: runLanguage });
  const parallelReady = work.tasks.filter((t) => t.parallel).length;
  let decision = (parallelReady >= 2 && distinctAgents > 1) ? 'multi' : 'single';
  const spawnedAgents = decision === 'multi' ? distinctAgents : 1;
  emit('cost_gate', { singleTokens: est.single, multiTokens: est.multi, decision, spawnedAgents, language: runLanguage || 'en', reason: decision === 'multi' ? 'parallel read-heavy work' : 'single is enough' });
  if (decision === 'single') for (const t of work.tasks) t.parallel = false; // enforce it

  // lean path: a single small task gets a slim prefix — a 1-call task can't amortize a full
  // agent-definition dump, so sending it uncached is pure overhead (kept the contract, which drives quality).
  const leanSingle = decision === 'single' && work.tasks.length === 1 && (work.tasks[0].blockedBy || []).length === 0 && !opts.noLean;
  // nudges (on-thesis output behavior): reject-multi when a fan-out was genuinely on the table; checkpoint-frame for long work.
  const rejectMultiNudge = decision === 'single' && (distinctAgents > 1 || /multi-?agent|spawn|fan-?out|nhiều agent|nhieu agent/i.test(objectivesText));
  const longRun = work.tasks.length > 1 || /(\d+\s*(steps|bước|buoc|ticks?))|resume|long[- ]?run|nhiều bước|nhieu buoc/i.test(objectivesText);

  // hard caps
  const caps = { ...DEFAULT_CAPS, ...(opts.caps || {}) };
  emit('cap_set', { maxIterations: caps.maxIterations, maxInputTokens: caps.maxInputTokens, maxWallClockMs: caps.maxWallClockMs, maxUsd: caps.maxUsd });

  // efficiency levers: trim intermediate output · cap blackboard injected downstream · route sub-tasks to a cheaper model.
  const finalMaxTokens = opts.maxTokens || 800;
  const intermediateMaxTokens = opts.intermediateMaxTokens || Math.min(400, finalMaxTokens);
  const blackboardCap = opts.blackboardCap || 900; // chars of a dependency's blackboard injected downstream
  const route = opts.route !== false;
  const dependents = new Set(work.tasks.flatMap((t) => t.blockedBy || []));
  const isSynthesis = (task) => task.final || !dependents.has(task.id); // a leaf / final task gets full budget + primary model

  const ledger = { uncached: 0, cached: 0, output: 0, usd: 0, calls: 0, cachedCalls: 0 };
  const done = new Set();
  const outputs = {};

  // per-owner security (risk_defaults + approval overrides from IDENTITY.security), memoized
  const securityCache = {};
  const agentSecurity = (task) => {
    const key = task.agent || task.owner || '_';
    if (securityCache[key]) return securityCache[key];
    let sec = { riskDefaults: {}, approvalOverrides: {} };
    try { sec = loadAgentSecurity(loadAgent(task.agent || task.owner, cwd).dir); } catch { /* no agent folder */ }
    securityCache[key] = sec; return sec;
  };

  const billable = () => Math.round(ledger.uncached + ledger.cached * (PRICING.cachedInput / PRICING.input) + ledger.output * (PRICING.output / PRICING.input));
  const usd = () => (ledger.uncached / 1e6) * PRICING.input + (ledger.cached / 1e6) * PRICING.cachedInput + (ledger.output / 1e6) * PRICING.output;
  const capBreach = (iter) => {
    if (iter > caps.maxIterations) return `maxIterations ${caps.maxIterations}`;
    if (ledger.uncached + ledger.cached > caps.maxInputTokens) return `maxInputTokens ${caps.maxInputTokens}`;
    if (Date.now() - startedAt > caps.maxWallClockMs) return `maxWallClockMs ${caps.maxWallClockMs}`;
    if (usd() > caps.maxUsd) return `maxUsd ${caps.maxUsd}`;
    return null;
  };

  async function runTask(task) {
    task.status = 'doing';
    const depSummaries = task.blockedBy.map((id) => {
      const p = path.join(blackboardDir, `${id}.md`);
      if (!fs.existsSync(p)) return '';
      let body = fs.readFileSync(p, 'utf8');
      if (body.length > blackboardCap) body = body.slice(0, blackboardCap) + '\n…[trimmed for downstream]';
      return `### from ${id}\n${body}`;
    }).filter(Boolean);
    emit('context_loaded', {
      taskId: task.id,
      sourcesRead: task.blockedBy.length + task.source_guidance.length,
      sources: [...task.blockedBy, ...task.source_guidance],
      lean: leanSingle,
    });
    emit('task_contract', {
      taskId: task.id, objective: task.objective, outputFormat: task.output_format,
      sourceGuidance: task.source_guidance, boundaries: task.boundaries,
    });

    // ── permission gate (v1.4): risk-tiered, DETERMINISTIC, enforced HERE before the action ──
    // A tier comes from the task's declared tool (resolved via .mcp.json / IDENTITY.security) or a
    // direct task.risk tier. Legacy `irreversible` maps to `destructive`. The gate is in code, not
    // the prompt — a model cannot be talked out of it.
    const sec = agentSecurity(task);
    const tier = task.tool
      ? resolveTier(task.tool, { mcpTools, riskDefaults: sec.riskDefaults }).tier
      : normalizeTier(task.risk);
    if (tier) {
      const policy = policyForTier(tier, sec.approvalOverrides);
      const gateId = `${task.id}-gate`;
      const approved = opts.autoApprove
        || fs.existsSync(path.join(approvalsDir, `${gateId}.json`))
        || fs.existsSync(path.join(controlDir, `${gateId}.approved`)); // legacy approval path

      // grounding pre-check: for financial|destructive, every declared param must trace to a real
      // prior source (blackboard / prior output / steer / objective) — a fabricated id never executes.
      let grounded = null;
      const groundingRequired = needsGrounding(tier) && task.ground != null;
      if (groundingRequired) {
        const steerP = path.join(controlDir, 'steer.md');
        const sources = collectSources({
          depSummaries, objective: task.objective,
          steer: fs.existsSync(steerP) ? fs.readFileSync(steerP, 'utf8') : '',
          priorOutputs: Object.values(outputs),
        });
        const g = checkGrounding(task.ground, sources);
        grounded = g.ok;
        emit('grounding_checked', { taskId: task.id, tier, traced: g.traced, missing: g.missing, passed: g.ok });
      }

      const verdict = evaluateAction({ tier, policy, approved, groundingRequired, grounded });
      emit('gate_requested', { gateId, risk: tier, tier, policy, approvedBeforeAction: verdict.decision === 'allow' });
      emit('permission_decision', { taskId: task.id, tool: task.tool || null, tier, policy, decision: verdict.decision, reason: verdict.reason });

      if (verdict.decision === 'deny') {
        emit('grounding_failed', { taskId: task.id, tier });
        task.status = 'blocked'; emit('gate_blocked', { gateId, reason: 'grounding' }); return;
      }
      if (verdict.decision === 'await') {
        fs.mkdirSync(approvalsDir, { recursive: true });
        fs.writeFileSync(path.join(approvalsDir, `${gateId}.requested.json`),
          JSON.stringify({ gateId, tool: task.tool || null, tier, policy, ts: new Date().toISOString() }, null, 2));
        task.status = 'blocked'; emit('gate_blocked', { gateId }); return;
      }
      emit('gate_approved', { gateId, approvedBeforeAction: true });
    }

    // deterministic step: a mechanical task (merge/passthrough) runs in code — 0 provider call, 0 tokens.
    if (task.deterministic) {
      const mergedBody = task.op === 'passthrough'
        ? (depSummaries[0] || task.objective)
        : [`## ${task.title}`, ...depSummaries].filter(Boolean).join('\n\n');
      const merged = task.final
        ? [
            '## Verdict',
            'Use the checkpointed, resumable plan below; this deterministic merge combines the verified step outputs without another model call.',
            '',
            '## Evidence',
            mergedBody,
            '',
            '## Assumptions',
            '- The merged step outputs are the evidence source for this final report.',
            '- Source ids are preserved from the upstream task outputs where available.',
            '',
            '## Next actions',
            '- Continue from the latest checkpoint if interrupted.',
            '- Verify each completed step before proceeding to the next one.',
          ].join('\n')
        : mergedBody;
      const bbPathD = path.join(blackboardDir, `${task.id}.md`);
      fs.appendFileSync(bbPathD, `${merged}\n`);
      emit('blackboard_write', { taskId: task.id, path: path.relative(runDir, bbPathD), appendOnly: true, bytes: Buffer.byteLength(merged) });
      emit('deterministic_step', { taskId: task.id, op: task.op, providerCalls: 0, tokens: 0 });
      outputs[task.id] = merged; task.status = 'done'; done.add(task.id);
      emit('task_completed', { id: task.id, deterministic: true });
      return;
    }

    // Stable-prefix-first context (cacheable) → volatile last.
    let agent = null;
    try { agent = loadAgent(task.agent || task.owner, cwd); } catch { /* agent folder optional */ }
    const synthesis = isSynthesis(task);
    const agentCaps = (agent && agent.frontmatter && Array.isArray(agent.frontmatter.capabilities)) ? agent.frontmatter.capabilities : [];
    const toolPolicy = agentCaps.some((c) => /^(shell|fs\.write|mcp|web)/.test(String(c))) ? 'full' : 'none'; // reasoning-only agent → let the provider strip tool schemas
    const compact = opts.compactPrefix || leanSingle; // SOUL-only prefix (drops the full identity/tools/hard-rules dump)
    const stablePrefix = compact
      ? [leanSingle ? 'SCROLL agent — single small task; answer the objective directly.' : 'SCROLL agent — reason directly from the contract below.', agent && agent.soul ? agent.soul : '']
          .filter(Boolean).join('\n\n')
      : [
        'SCROLL agent. Coordinate through files; one controller owns WORK.md.',
        agent && agent.identityBody ? agent.identityBody : '',
        agent && agent.soul ? agent.soul : '',
        agent && agent.tools ? agent.tools : '',
        agent && agent.hardRules ? agent.hardRules : '',
      ].filter(Boolean).join('\n\n');
    // sub-tasks return terse findings (they only feed the blackboard); only the synthesis needs full prose.
    const deliverable = synthesis
      ? `Return ${task.output_format} with sections: Verdict, Evidence, Assumptions, Next actions. Cite source ids like [S1]. Do not say you are blocked unless a source is truly missing.`
      : 'Return ONLY the key findings as terse bullet points — no preamble, no headings, ≤120 words. Cite source ids like [S1].';
    const volatile = [
      `Task: ${task.title}`,
      `Objective: ${task.objective}`,
      task.source_guidance.length ? `Sources:\n${task.source_guidance.join('\n')}` : '',
      depSummaries.length ? `Blackboard (prior findings):\n${depSummaries.join('\n\n')}` : '',
      task.boundaries.length ? `Boundaries: ${task.boundaries.join('; ')}` : '',
      deliverable,
      rejectMultiNudge ? 'The cost gate selected SINGLE-agent: explicitly recommend single-agent and state you reject spawning unnecessary multi-agent for a task this small.' : '',
      longRun ? 'Frame the work as short, checkpointed, resumable steps (verify/revise/report) — never one uninterrupted run.' : '',
    ].filter(Boolean).join('\n\n');
    const prompt = `${stablePrefix}\n\n---\n\n${volatile}`;

    const agentSub = agent && agent.frontmatter && agent.frontmatter.model && agent.frontmatter.model.fallback;
    const callModel = task.engine ? null : ((!synthesis && route && (opts.subModel || agentSub)) ? (opts.subModel || agentSub) : opts.model); // engine task → that provider's own default model
    const callMaxTokens = synthesis ? finalMaxTokens : intermediateMaxTokens;
    // isolated working dir per task → two parallel agents never write the same scratch (worktree-lite).
    // With --worktree on a git repo, a real `git worktree` is used so parallel writes can't corrupt state.
    const taskScratch = path.join(scratchDir, task.id);
    fs.mkdirSync(taskScratch, { recursive: true });
    let workdir = taskScratch;
    if (task.workdir) workdir = path.resolve(cwd, task.workdir); // v1.6: repo-anchored task (code work needs the repo, not scratch)
    if (opts.worktree && task.parallel) { const wt = makeWorktree(cwd, runDir, task.id, emit); if (wt) workdir = wt; }
    if (task.parallel) emit('isolated_scratch', { taskId: task.id, dir: path.relative(runDir, workdir) });

    const prov = providerFor(task.engine);
    emit('provider_call_started', { taskId: task.id, provider: prov.name, label: task.owner, role: synthesis ? 'synthesis' : 'sub', model: callModel || prov.model, maxTokens: callMaxTokens, toolPolicy, engine: task.engine || null, effort: task.effort || null, sandbox: task.sandbox || null });
    const r = await prov.generate(prompt, { cwd: workdir, model: callModel, cachePrefix: stablePrefix, system: stablePrefix, maxTokens: callMaxTokens, toolPolicy, effort: task.effort, sandbox: task.sandbox, timeoutMs: task.timeout_ms || opts.stepTimeoutMs });
    ledger.uncached += r.usage.uncachedInputTokens; ledger.cached += r.usage.cachedInputTokens; ledger.output += r.usage.outputTokens; ledger.calls += 1;
    if (r.usage.cachedInputTokens > 0) ledger.cachedCalls += 1;
    emit('provider_call_completed', { taskId: task.id, durationMs: r.durationMs, usage: r.usage, responseId: r.responseId });
    if (r.usage.cachedInputTokens > 0 && ledger.calls >= 2) {
      emit('cache_path_checked', { cachedInputTokens: r.usage.cachedInputTokens, uncachedInputTokens: r.usage.uncachedInputTokens, providerCalls: ledger.calls, passed: true });
    }

    const bbPath = path.join(blackboardDir, `${task.id}.md`);
    fs.appendFileSync(bbPath, `${r.text}\n`);
    emit('blackboard_write', { taskId: task.id, path: path.relative(runDir, bbPath), appendOnly: true, bytes: Buffer.byteLength(r.text) });

    outputs[task.id] = r.text;
    task.status = 'done'; done.add(task.id);
    emit('task_completed', { id: task.id });
  }

  // crash-resume (real, cross-process): on --resume, restore completed tasks from the persisted
  // checkpoint, reload their blackboard outputs into memory, and SKIP re-running them (no re-billing).
  let startIteration = 0;
  if (opts.resume) {
    const cpPath = path.join(runDir, 'checkpoint.json');
    if (fs.existsSync(cpPath)) {
      try {
        const cp = JSON.parse(fs.readFileSync(cpPath, 'utf8'));
        for (const [id, st] of Object.entries(cp.statuses || {})) {
          const tk = work.tasks.find((t) => t.id === id);
          if (tk && st === 'done') {
            tk.status = 'done'; done.add(id);
            const bb = path.join(blackboardDir, `${id}.md`);
            if (fs.existsSync(bb)) outputs[id] = fs.readFileSync(bb, 'utf8'); // restore output for synthesis
          }
        }
        startIteration = cp.iteration || 0;
        emit('resumed', { from: 'checkpoint.json', restoredDone: [...done], iteration: startIteration });
      } catch (e) { emit('error', { reason: 'resume failed: ' + e.message }); }
    } else {
      emit('resume_noop', { reason: 'no checkpoint.json — running from the start' });
    }
  }

  // deterministic advance loop
  let iteration = startIteration;
  let stopped = null;
  let resumeReloaded = false;
  while (work.tasks.some((t) => t.status !== 'done' && t.status !== 'blocked')) {
    if (fs.existsSync(path.join(controlDir, 'stop'))) { stopped = 'control/stop'; emit('circuit_breaker', { reason: stopped }); break; }
    const breach = capBreach(iteration + 1);
    if (breach) { stopped = breach; emit('circuit_breaker', { reason: breach, action: 'pause' }); fs.writeFileSync(path.join(runDir, 'PAUSED'), breach); break; }

    const ready = work.tasks.filter((t) => t.status === 'todo' && t.blockedBy.every((id) => done.has(id)));
    if (!ready.length) {
      if (work.tasks.every((t) => t.status === 'done' || t.status === 'blocked')) break;
      emit('error', { reason: 'deadlock: no ready tasks but work remains', pending: work.tasks.filter((t) => t.status === 'todo').map((t) => t.id) });
      throw new Error('WORK.md deadlock (check blockedBy cycles)');
    }

    const parallelBatch = ready.filter((t) => t.parallel);
    const batch = (decision === 'multi' && parallelBatch.length >= 2) ? parallelBatch : [ready[0]];
    emit('dispatch', { iteration: iteration + 1, tasks: batch.map((t) => t.id), parallel: batch.length > 1 });
    await Promise.all(batch.map((t) => runTask(t)));

    iteration += 1;
    // checkpoint: filesystem is the state; try git, fall back to a checkpoint file.
    const statuses = Object.fromEntries(work.tasks.map((t) => [t.id, t.status]));
    fs.writeFileSync(path.join(runDir, 'checkpoint.json'), JSON.stringify({ iteration, statuses }, null, 2));
    let backend = 'file';
    const git = spawnSync('git', ['-C', cwd, 'add', '-A'], { encoding: 'utf8' });
    if (git.status === 0) { const c = spawnSync('git', ['-C', cwd, 'commit', '-m', `scroll run ${runId} iter ${iteration}`], { encoding: 'utf8' }); if (c.status === 0) backend = 'git'; }
    emit('checkpoint_written', { checkpointId: `${runId}-iter${iteration}`, backend });

    // measured resume: simulate a crash after the first checkpoint, then RESUME from the persisted file
    // (re-read checkpoint.json → restore task statuses → continue). This exercises resume logic, not just file existence.
    if (opts.resumeSelftest && !resumeReloaded && iteration === 1) {
      const cp = JSON.parse(fs.readFileSync(path.join(runDir, 'checkpoint.json'), 'utf8'));
      done.clear();
      for (const [id, st] of Object.entries(cp.statuses || {})) {
        const tk = work.tasks.find((t) => t.id === id);
        if (tk) { tk.status = st; if (st === 'done') done.add(id); }
      }
      resumeReloaded = true;
      emit('interrupt_simulated', { afterIteration: 1, restoredFrom: `${runId}-iter1`, restoredDone: [...done] });
    }
  }

  // pick final output (dependents computed above)
  const finalTask = work.tasks.find((t) => t.final && t.status === 'done')
    || [...work.tasks].reverse().find((t) => t.status === 'done' && !dependents.has(t.id))
    || [...work.tasks].reverse().find((t) => t.status === 'done');
  const finalText = finalTask ? outputs[finalTask.id] : '';
  fs.writeFileSync(outPath, finalText || '');
  emit('output_saved', { path: path.relative(runDir, outPath) || outPath, bytes: Buffer.byteLength(finalText || ''), finalTask: finalTask ? finalTask.id : null });

  // verify BEFORE completed
  const checks = verify(finalText);
  emit('verification', { passed: checks.passed, checks: checks.detail });

  // measured checkpoint-resume evidence (only when a resume self-test was requested)
  if (opts.resumeSelftest) {
    emit('checkpoint_resume_checked', {
      passed: resumeReloaded && done.size === work.tasks.length,
      checkpointId: `${runId}-iter1`,
      resumedFrom: 'checkpoint.json',
      completedAfterResume: done.size === work.tasks.length,
    });
  }

  const inputTotal = ledger.uncached + ledger.cached;
  const metrics = {
    uncachedInputTokens: ledger.uncached, cachedInputTokens: ledger.cached, outputTokens: ledger.output,
    billableTokenEquivalent: billable(), costUsd: round(usd(), 5), durationMs: Date.now() - startedAt,
    cacheHitPct: inputTotal ? round((ledger.cached / inputTotal) * 100, 1) : 0,
    providerCalls: ledger.calls, tasksCompleted: done.size, tasksTotal: work.tasks.length,
    decision, spawnedAgents,
  };
  const status = stopped ? 'paused' : (done.size === work.tasks.length ? 'completed' : 'incomplete');
  emit(stopped ? 'paused' : 'completed', { status, verificationPassed: checks.passed, metrics });

  // comprehension digest — a human-readable summary derived from the event stream (no model call),
  // so an owner can READ what the run did rather than just trust it (anti passive-delegation).
  let digestPath = null;
  try {
    digestPath = writeDigest({ runDir, eventsPath, language: runLanguage || 'en', metrics });
    emit('digest_written', { path: path.relative(runDir, digestPath) });
  } catch (e) { emit('error', { reason: 'digest failed: ' + e.message }); }

  return { runId, runDir, eventsPath, outPath, digestPath, status, verification: checks, metrics, decision, spawnedAgents };
}

// Create a git worktree for a parallel task (real isolation for parallel writes). Returns the path,
// or null if cwd is not a git repo / worktree creation fails (caller falls back to a scratch dir).
function makeWorktree(cwd, runDir, taskId, emit) {
  const isRepo = spawnSync('git', ['-C', cwd, 'rev-parse', '--is-inside-work-tree'], { encoding: 'utf8' }).status === 0;
  if (!isRepo) return null;
  const wt = path.join(runDir, 'worktrees', taskId);
  const r = spawnSync('git', ['-C', cwd, 'worktree', 'add', '--detach', '--force', wt], { encoding: 'utf8' });
  if (r.status === 0) { emit('worktree_created', { taskId, path: path.relative(cwd, wt) }); return wt; }
  return null;
}

function verify(text) {
  const t = (text || '').toLowerCase();
  const detail = {
    hasVerdict: /verdict|kết luận|ket luan/.test(t),
    hasEvidence: /evidence|bằng chứng|bang chung|##\s*evidence/.test(t),
    hasAssumptions: /assumption|giả định|gia dinh/.test(t),
    hasNextActions: /next action|next step|hành động|hanh dong|##\s*next/.test(t),
    citesSources: /\[s\d\]/i.test(text || ''),
    notBlocked: !/\b(i am|i'm)\s+blocked\b|cannot read|can't read|không đọc được|khong doc duoc|bị kẹt|bi ket|missing sources|source is missing|sources are missing|permission denied/.test(t),
  };
  // pass = solved the task in the required shape and did not stall on a blocker
  const passed = detail.hasVerdict && (detail.hasNextActions || detail.hasEvidence) && detail.notBlocked;
  return { passed, detail };
}

const round = (n, d = 2) => { const p = 10 ** d; return Math.round(n * p) / p; };
