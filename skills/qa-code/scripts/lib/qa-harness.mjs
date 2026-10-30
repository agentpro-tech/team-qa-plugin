#!/usr/bin/env node

import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  mkdirSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createQaReceipt,
  parseGrokToolLog,
  resolveCommit,
  verifyObjectIntegrity,
} from './release-receipt.mjs';

import {providerCommand, parseProviderExecution, validateProviderExecution} from './provider-execution.mjs';
import {verifyTeamQaReviewProof} from './teamqa-review-proof.mjs';
import {verifyGate0SecretAdjudication} from './secret-adjudication.mjs';
import {engineVendor} from './release-receipt.mjs';
import {prepareNativeQa, loadNativeQaExecution} from './native-qa.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const PROMPT_PATH = join(ROOT, 'references', 'qa-prompt.md');
const VALIDATOR_PATH = join(ROOT, 'scripts', 'verdict-validate.mjs');
const DEFAULT_ENGINE = JSON.parse(readFileSync(join(ROOT, 'references', 'provider-defaults.json'), 'utf8')).standalone.model;
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
const MAX_BUFFER = 32 * 1024 * 1024;
const AUTH_RISK = /auth|login|session|jwt|oauth|password|credential/i;
const PERMISSION_RISK = /permission|acl|role|rbac|policy/i;
const TIMING_RISK = /concurrency|race|mutex|lock/i;

class UsageError extends Error {}
class UngradedUsageError extends Error {}

function usage(message = null, stream = process.stderr) {
  stream.write('Usage: bash scripts/qa-run.sh --repo <path> --mode tools|static --gate0 <gate0.json> --base <TASK_BASE> --receipt <qa-code.receipt.json> [--json <verdict.json>] [--engine-cmd <cmd>] [--engine codex|codex-native|claude|<grok-model>] [--provider-model <exact-id>] [--reasoning <effort>] [--teamqa-proof <proof.json>] [--teamqa-runtime <verified-package>] [--native-prepare <intent>] [--native-execution <evidence>]\n');
  if (message) stream.write(`${message}\n`);
}

function parseArgs(argv) {
  const options = {
    repo: null,
    mode: null,
    gate0: null,
    base: null,
    json: null,
    receipt: null,
    engineCmd: null,
    engine: null,
    help: false,
  };
  const valueFlags = new Map([
    ['--repo', 'repo'],
    ['--mode', 'mode'],
    ['--gate0', 'gate0'],
    ['--base', 'base'],
    ['--json', 'json'],
    ['--receipt', 'receipt'],
    ['--engine-cmd', 'engineCmd'],
    ['--engine', 'engine'],
    ['--provider-model','providerModel'],
    ['--reasoning','reasoning'],
    ['--teamqa-proof','teamqaProof'],
    ['--teamqa-runtime','teamqaRuntime'],
    ['--native-prepare','nativePrepare'],
    ['--native-execution','nativeExecution'],
  ]);
  const seen = new Set();

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '-h' || flag === '--help') {
      if (argv.length !== 1) throw new UsageError(`${flag} does not go with other flags`);
      options.help = true;
      continue;
    }
    const key = valueFlags.get(flag);
    if (!key) throw new UsageError(`invalid flag: ${flag}`);
    if (seen.has(flag)) throw new UsageError(`repeated flag: ${flag}`);
    if (index + 1 >= argv.length) throw new UsageError(`missing value for ${flag}`);
    seen.add(flag);
    options[key] = argv[index + 1];
    index += 1;
  }

  if (options.help) return options;
  if (!options.repo) throw new UsageError('missing --repo <path>');
  if (!['tools', 'static'].includes(options.mode)) {
    throw new UsageError('--mode must be tools or static');
  }
  if (!options.gate0) throw new UsageError('missing --gate0 <gate0.json>');
  if (!options.base) throw new UngradedUsageError('UNGRADED — missing --base; TASK_BASE is required');
  if (!options.receipt) throw new UsageError('missing --receipt <qa-code.receipt.json>');
  if (options.engine !== null && !String(options.engine).trim()) {
    throw new UsageError('--engine must not be empty');
  }
  if (options.engineCmd !== null && !String(options.engineCmd).trim()) {
    throw new UsageError('--engine-cmd must not be empty');
  }
  options.native = options.engine === 'codex-native';
  if(options.native && (!options.teamqaProof || !options.teamqaRuntime || Boolean(options.nativePrepare)===Boolean(options.nativeExecution) || options.mode!=='static'))throw new UngradedUsageError('native requires verified TeamQA proof/runtime, exactly one prepare/execution, and static mode');
  if(!options.native && (options.nativePrepare || options.nativeExecution))throw new UngradedUsageError('native flags require codex-native route');
  options.provider = options.engine === 'codex' || options.native ? 'openai' : options.engine === 'claude' ? 'anthropic' : null;
  if(options.provider && (!options.providerModel || !options.reasoning)) throw new UngradedUsageError('explicit --provider-model and --reasoning required');
  if(options.provider && options.engineCmd) throw new UngradedUsageError('official provider routes cannot use --engine-cmd');
  if(!options.provider && options.engine && !options.engineCmd && engineVendor(options.engine)!=='xai') throw new UngradedUsageError('unsupported engine route; use codex or claude');
  if(options.provider) options.engine = options.providerModel;
  return options;
}

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    encoding: 'utf8',
    maxBuffer: MAX_BUFFER,
    ...options,
  });
}

function git(repo, args, options = {}) {
  return run('git', args, { cwd: repo, ...options });
}

function readJson(path, label) {
  try {
    return { value: JSON.parse(readFileSync(path, 'utf8')), error: null };
  } catch (error) {
    return { value: null, error: `${label}: ${error.message}` };
  }
}

function resolveRepo(path) {
  let repo;
  try {
    repo = realpathSync(path);
    if (!lstatSync(repo).isDirectory()) throw new Error('not a directory');
  } catch (error) {
    throw new UsageError(`cannot read --repo: ${error.message}`);
  }
  const check = git(repo, ['rev-parse', '--is-inside-work-tree']);
  if (check.status !== 0 || check.stdout.trim() !== 'true') {
    throw new UsageError(`--repo must be a git repo: ${repo}`);
  }
  return repo;
}

function resolveOutput(path, repo) {
  if (!path) return null;
  let parent;
  try {
    parent = realpathSync(dirname(resolve(path)));
  } catch (error) {
    throw new UsageError(`cannot read the parent folder of --json: ${error.message}`);
  }
  const output = join(parent, basename(path));
  const rel = relative(repo, output);
  if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) {
    throw new UsageError('--json must be outside the repo under review so that L5 keeps the repo clean');
  }
  return output;
}

export function gate0IsUsable(gate0) {
  try {verifyGate0SecretAdjudication(gate0);} catch {return false;}
  return gate0 !== null
    && typeof gate0 === 'object'
    && !Array.isArray(gate0)
    && gate0.schema === 'qa-code/gate0/v1'
    && gate0.status === 'pass'
    && typeof gate0.repo === 'string'
    && typeof gate0.base === 'string'
    && typeof gate0.commit === 'string'
    && /^[0-9a-fA-F]{40}$/.test(gate0.commit)
    && typeof gate0.run_uuid === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(gate0.run_uuid)
    && typeof gate0.created_at === 'string'
    && !Number.isNaN(Date.parse(gate0.created_at))
    && verifyObjectIntegrity(gate0);
}

function resolveCommits(repo, base) {
  const headResult = git(repo, ['rev-parse', '--verify', 'HEAD^{commit}']);
  if (headResult.status !== 0) throw new UsageError('--repo has no HEAD commit yet');
  const head = headResult.stdout.trim();

  const baseResult = git(repo, ['rev-parse', '--verify', `${base}^{commit}`]);
  if (baseResult.status === 0) return { base: baseResult.stdout.trim(), head };

  const emptyTree = git(repo, ['hash-object', '-t', 'tree', '/dev/null']);
  if (emptyTree.status !== 0 || base !== emptyTree.stdout.trim()) {
    throw new Error(`cannot resolve --base to TASK_BASE: ${base}`);
  }
  return { base: emptyTree.stdout.trim(), head };
}

function readOptional(path, missingText) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return missingText;
  }
}

function gitText(repo, args, label) {
  const result = git(repo, args);
  if (result.status !== 0) {
    throw new Error(`${label}: ${result.stderr.trim() || `git exit ${String(result.status)}`}`);
  }
  return result.stdout;
}

function staticSources(repo, base, head) {
  const names = git(repo, [
    '-c', 'core.quotePath=false', 'diff', '--name-only', '--diff-filter=ACMRT', '-z',
    base, head, '--',
  ], { encoding: 'buffer', maxBuffer: MAX_BUFFER });
  if (names.status !== 0) throw new Error('cannot list the source for static mode');

  const paths = names.stdout.toString('utf8').split('\0').filter(Boolean);
  const blocks = [];
  for (const path of paths) {
    const shown = git(repo, ['show', `${head}:${path}`], { encoding: 'buffer', maxBuffer: MAX_BUFFER });
    if (shown.status !== 0) {
      blocks.push(`### ${path}\n\n(cannot read the content at HEAD)`);
      continue;
    }
    if (shown.stdout.includes(0)) {
      blocks.push(`### ${path}\n\n(binary file, see the diff above)`);
      continue;
    }
    blocks.push(`### ${path}\n\n\`\`\`text\n${shown.stdout.toString('utf8')}\n\`\`\``);
  }
  return blocks.length > 0 ? blocks.join('\n\n') : '(no file added or modified at HEAD)';
}

export function buildPrompt(repo, mode, gate0, commits) {
  const rules = readFileSync(PROMPT_PATH, 'utf8');
  const spec = readOptional(
    join(repo, '.teamcode', 'spec.md'),
    '(the repo has no .teamcode/spec.md)',
  );
  const report = readOptional(
    join(repo, '.teamcode', 'build-report.md'),
    '(the repo has no .teamcode/build-report.md)',
  );
  const diff = gitText(repo, [
    '-c', 'core.quotePath=false', 'diff', '--no-color', '--no-ext-diff',
    commits.base, commits.head, '--',
  ], 'cannot read git diff');
  const source = mode === 'static'
    ? staticSources(repo, commits.base, commits.head)
    : '(tools mode: use read-only tools to open the source and run tests in the repo)';

  return `${rules.trim()}\n\n`
    + `# Grading run context\n\n`
    + `- required mode: ${mode}\n`
    + `- Gate 0 commit: ${gate0.commit}\n`
    + `- HEAD to grade: ${commits.head}\n`
    + `- repo: ${repo}\n\n`
    + `## Spec acceptance\n\n${spec}\n\n`
    + `## Build report\n\n${report}\n\n`
    + `## Diff\n\n\`\`\`diff\n${diff}\n\`\`\`\n\n`
    + `## Source to grade\n\n${source}\n`;
}

function timeoutMs() {
  const raw = process.env.QA_CODE_ENGINE_TIMEOUT_MS;
  if (raw === undefined) return DEFAULT_TIMEOUT_MS;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new UsageError('QA_CODE_ENGINE_TIMEOUT_MS must be a positive integer');
  }
  return value;
}

function invokeInjected(command, prompt, repo, timeout) {
  // Acceptance joins `bash ${path}` into one string. If the path itself has spaces and is not
  // quoted, the shell cannot tell which part is the path. Recognize the single-script case
  // so that argv stays correct; complex commands still go through /bin/sh -c.
  const direct = command.match(/^(bash|sh|node)\s+(.+)$/s);
  if (direct && existsSync(direct[2])) {
    return run(direct[1], [direct[2]], {
      cwd: repo,
      input: prompt,
      timeout,
    });
  }
  return run('/bin/sh', ['-c', command], {
    cwd: repo,
    input: prompt,
    timeout,
  });
}

function invokeGrok({ mode, engine, promptPath, repo, timeout, sessionId }) {
  const args = [
    '--prompt-file', promptPath,
    '--cwd', repo,
    '--model', engine,
    '--output-format', 'plain',
    '--no-subagents',
    '--no-memory',
    '--disable-web-search',
    '--verbatim',
    '--permission-mode', 'dontAsk',
    '--session-id', sessionId,
  ];
  if (mode === 'static') args.push('--tools', '');
  return run('grok', args, { cwd: repo, timeout });
}

function grokUpdatesPath(repo, sessionId) {
  const grokHome = process.env.GROK_HOME || join(homedir(), '.grok');
  return join(grokHome, 'sessions', encodeURIComponent(repo), sessionId, 'updates.jsonl');
}

function toolLogFromGrok(repo, sessionId) {
  const path = grokUpdatesPath(repo, sessionId);
  let lines;
  try { lines = readFileSync(path, 'utf8').split(/\r?\n/).filter(Boolean); }
  catch { return []; }
  return parseGrokToolLog(lines.join('\n'));
}

function hashBuffer(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function repoState(repo) {
  const status = git(repo, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], {
    encoding: 'buffer',
    maxBuffer: MAX_BUFFER,
  });
  if (status.status !== 0) return { error: 'cannot capture git status' };

  const worktreeDiff = git(repo, ['diff', '--no-ext-diff', '--'], {
    encoding: 'buffer',
    maxBuffer: MAX_BUFFER,
  });
  if (worktreeDiff.status !== 0) return { error: 'cannot capture git diff' };

  const indexDiff = git(repo, ['diff', '--cached', '--no-ext-diff', '--'], {
    encoding: 'buffer',
    maxBuffer: MAX_BUFFER,
  });
  if (indexDiff.status !== 0) return { error: 'cannot capture git diff --cached' };

  return {
    error: null,
    status: status.stdout,
    worktreeHash: hashBuffer(worktreeDiff.stdout),
    indexHash: hashBuffer(indexDiff.stdout),
  };
}

function tampering(before, after) {
  if (before.error) return before.error;
  if (after.error) return after.error;
  if (!before.status.equals(after.status)) return 'git status changed after the engine ran';
  if (before.worktreeHash !== after.worktreeHash) return 'git diff changed after the engine ran';
  if (before.indexHash !== after.indexHash) return 'git diff --cached changed after the engine ran';
  return null;
}

function tamperingMarkerPath(gate0Path, runUuid) {
  return join(dirname(resolve(gate0Path)), `.qa-code-tampering-${runUuid}.json`);
}

function recordTampering(gate0Path, gate0, reason) {
  const marker = tamperingMarkerPath(gate0Path, gate0.run_uuid);
  if (!existsSync(marker)) {
    writeFileSync(marker, `${JSON.stringify({
      schema: 'qa-code/tampering-marker/v1',
      run_uuid: gate0.run_uuid,
      gate0_integrity: gate0.integrity,
      reason,
      detected_at: new Date().toISOString(),
    }, null, 2)}\n`, 'utf8');
  }
  return marker;
}

function blindReason(finding) {
  const haystack = `${String(finding?.file ?? '')}\n${String(finding?.evidence ?? '')}`;
  if (AUTH_RISK.test(haystack) || PERMISSION_RISK.test(haystack)) {
    return 'authentication or authorization area, static mode cannot conclude';
  }
  if (TIMING_RISK.test(haystack)) {
    return 'concurrency or timing area, static mode cannot conclude';
  }
  return null;
}

function concernFromFinding(finding) {
  const at = finding.file
    ? `${finding.file}${Number.isInteger(finding.line) ? `:${finding.line}` : ''}`
    : 'unknown file';
  const evidence = typeof finding.evidence === 'string' ? finding.evidence : 'not enough evidence';
  return `${finding.id || '?'} @ ${at}: ${evidence}`;
}

function enforceHarness(raw, options, gate0, retries) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  const verdict = structuredClone(raw);
  const capped = [];
  const moved = [];

  // Engine identity is execution provenance owned by the harness, never a model claim.
  verdict.engine = options.engine || DEFAULT_ENGINE;
  verdict.mode = options.mode;
  if (options.mode === 'static' && verdict.verdict === 'PASS') {
    verdict.verdict = 'PASS-STATIC';
    capped.push({ rule: 'R-CAP', from: 'PASS', to: 'PASS-STATIC' });
  }

  if (options.mode === 'static' && Array.isArray(verdict.findings)) {
    const kept = [];
    const concerns = verdict.concerns === undefined ? [] : verdict.concerns;
    for (const finding of verdict.findings) {
      const why = finding?.severity === 'A' ? blindReason(finding) : null;
      if (!why) {
        kept.push(finding);
        continue;
      }
      if (!Array.isArray(concerns)) return verdict;
      concerns.push(concernFromFinding(finding));
      moved.push({ rule: 'R-BLIND', id: finding.id || '?', why });
    }
    verdict.findings = kept;
    verdict.concerns = concerns;
  }

  verdict.harness = {
    mode: options.mode,
    engine: options.engine || verdict.engine || DEFAULT_ENGINE,
    gate0_commit: gate0.commit,
    capped,
    moved,
    retries,
    ...(options.providerExecution ? {provider_execution:options.providerExecution} : {}),
    ...(options.verifiedTeamQaProof ? {review_mode:options.verifiedTeamQaProof.coder.provider===options.provider?'same-provider review':'cross-provider review',teamqa_proof:options.teamqaProof,teamqa_runtime:options.teamqaRuntime} : {}),
  };
  if(options.providerAttestation)verdict.dispatch_proof=options.providerAttestation;
  return verdict;
}

function validateCandidate(candidate, gate0Path, workspace, repo, base, options) {
  const candidatePath = join(workspace, 'candidate.json');
  const validationPath = join(workspace, 'validation.json');
  writeFileSync(candidatePath, `${JSON.stringify(candidate, null, 2)}\n`, 'utf8');
  const result = run(process.execPath, [
    VALIDATOR_PATH,
    '--verdict', candidatePath,
    '--gate0', gate0Path,
    '--repo', repo,
    '--base', base,
    '--task-base', base,
    '--json', validationPath,
    ...(options.teamqaProof ? ['--teamqa-proof',options.teamqaProof] : []),
    ...(options.teamqaRuntime ? ['--teamqa-runtime',options.teamqaRuntime] : []),
  ]);
  const validation = readJson(validationPath, 'validation');
  return { result, validation: validation.value, readError: validation.error };
}

function writeMachineReceipt(options, gate0, repo, commits, verdict, toolLog, executionStatus = 'completed') {
  const receipt = createQaReceipt({
    gate0,
    gate0Path: options.gate0,
    repo,
    taskBase: commits.base,
    head: commits.head,
    executionStatus,
    semanticVerdict: verdict.verdict,
    mode: options.mode,
    engine: options.engine || verdict.engine || DEFAULT_ENGINE,
    engineInjected: Boolean(options.engineCmd),
    toolLog,
    providerExecution: options.providerExecution,
    tampering: verdict?.harness?.tampering === true,
  });
  writeFileSync(options.receipt, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
  return receipt;
}

function ungraded(options, gate0, retries, reason, tampered = false) {
  const engine = options.engine || (options.engineCmd ? 'engine-cmd' : DEFAULT_ENGINE);
  return {
    schema: 'qa-code/verdict/v1',
    verdict: 'UNGRADED',
    mode: options.mode,
    engine,
    commit: gate0.commit,
    findings: [],
    concerns: [reason],
    proposed_tests: [],
    sweep: {
      S1: 'NOT_APPLICABLE',
      S2: 'NOT_APPLICABLE',
      S3: 'NOT_APPLICABLE',
      S4: 'NOT_APPLICABLE',
      S5: 'NOT_APPLICABLE',
    },
    harness: {
      mode: options.mode,
      engine,
      gate0_commit: gate0.commit,
      capped: [],
      moved: [],
      retries,
      ...(tampered ? { tampering: true } : {}),
    },
  };
}

// V7: the human-readable verdict line. Static mode always adds "static ceiling" (no path to PASS);
// tools mode prints only the grade. When the verdict is written to a file, stdout carries this human line.
function humanLine(verdict) {
  return verdict?.mode === 'static'
    ? `${verdict.verdict} — static ceiling`
    : `${verdict.verdict}`;
}

function emit(verdict, outputPath) {
  const text = `${JSON.stringify(verdict, null, 2)}\n`;
  if (outputPath) {
    writeFileSync(outputPath, text, 'utf8');
    process.stdout.write(`${humanLine(verdict)}\n`);
  } else {
    process.stdout.write(text);
  }
}

function engineFailure(result) {
  if (result.error?.code === 'ETIMEDOUT') return 'engine timeout';
  if (result.error) return `cannot call the engine: ${result.error.message}`;
  if (result.status !== 0) return `engine died (exit ${String(result.status)}, signal ${String(result.signal || 'none')})`;
  if (!result.stdout || !result.stdout.trim()) return 'engine returned empty stdout';
  return null;
}

function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    usage(error.message);
    return error instanceof UngradedUsageError ? 20 : 2;
  }
  if (options.help) {
    usage(null, process.stdout);
    return 0;
  }

  let repo;
  let outputPath;
  let receiptPath;
  let timeout;
  try {
    repo = resolveRepo(options.repo);
    outputPath = resolveOutput(options.json, repo);
    receiptPath = resolveOutput(options.receipt, repo);
    if (outputPath && outputPath === receiptPath) throw new UsageError('--json and --receipt must be two different files');
    options.receipt = receiptPath;
    timeout = timeoutMs();
  } catch (error) {
    usage(error.message);
    return 2;
  }

  const gate0Read = readJson(options.gate0, 'gate0');
  if (gate0Read.error || !gate0IsUsable(gate0Read.value)) {
    process.stderr.write(`qa-code: UNGRADED — R-GATE blocks before the engine: ${gate0Read.error || 'Gate 0 is not green, is malformed or its integrity does not match'}\n`);
    return 20;
  }
  const gate0 = gate0Read.value;

  const workspace = mkdtempSync(join(tmpdir(), 'qa-code-p3-'));
  try {
    let commits;
    let prompt;
    try {
      commits = resolveCommits(repo, options.base);
      const gateRepo = realpathSync(gate0.repo);
      if (gateRepo !== repo) throw new Error(`Gate 0 repo binding mismatch: ${gateRepo}`);
      if (resolveCommit(repo, gate0.base) !== commits.base) throw new Error('Gate 0 base binding does not match TASK_BASE');
      if (resolveCommit(repo, gate0.commit) !== commits.head) throw new Error('Gate 0 commit does not equal the current HEAD');
      prompt = buildPrompt(repo, options.mode, gate0, commits);
    } catch (error) {
      const verdict = ungraded(options, gate0, 0, `R-DEAD: cannot build the prompt or binding: ${error.message}`);
      process.stderr.write(`qa-code: UNGRADED — ${verdict.concerns[0]}\n`);
      emit(verdict, outputPath);
      // Do not issue a receipt when the Gate 0 binding is wrong: the source data is not enough to seal it safely.
      return 20;
    }

    if(options.provider) {
      try {
        const specJson=readJson(join(repo,'.teamcode','spec.json'),'spec').value;
        const specText=readOptional(join(repo,'.teamcode','spec.md'),'');
        let coder=specJson?.roles?.coder?.vendor || specJson?.coder_vendor || /coder_vendor\s*:\s*([a-z0-9._-]+)/i.exec(specText)?.[1];
        coder=typeof coder==='string'?coder.trim().toLowerCase():null;
        if(options.teamqaProof)options.verifiedTeamQaProof=verifyTeamQaReviewProof({proofPath:options.teamqaProof,runtimePath:options.teamqaRuntime,repo,base:commits.base,head:commits.head,provider:options.provider,model:options.providerModel,reasoning:options.reasoning});
        if(options.verifiedTeamQaProof) {
          coder ||= options.verifiedTeamQaProof.coder.provider;
          const proof=options.verifiedTeamQaProof;
          const seat=proof.resolved_seat;
          if(!Number.isInteger(seat?.caps?.timeout_ms)||!Number.isInteger(seat?.caps?.max_turns))throw new Error("TEAMQA_CAPS_REQUIRED");
          timeout=seat.caps.timeout_ms;options.providerCaps=seat.caps;
          if(options.native) {
            if(seat.harness!=='codex-native'||seat.provider!=='openai'||seat.caps.max_turns!==1)throw new Error('NATIVE_SEAT_REQUIRED');
            options.harnessVersion=seat.harness_version;
          } else {
          if(!seat?.harness_bin || !isAbsolute(seat.harness_bin))throw new Error('TEAMQA_HARNESS_BIN_REQUIRED');
          const version=run(seat.harness_bin,['--version'],{cwd:repo,timeout:10000});
          const actualVersion=version.stdout?.match(/\b\d+\.\d+\.\d+\b/)?.[0];
          if(version.status!==0 || !actualVersion || actualVersion!==seat.harness_version)throw new Error('TEAMQA_HARNESS_VERSION_MISMATCH');
          options.harnessVersion=actualVersion;
          options.harnessBinHash=hashBuffer(readFileSync(realpathSync(seat.harness_bin)));
          }
          const runDir=realpathSync(proof.run_dir);
          const receiptRelative=relative(runDir,options.receipt);
          if(receiptRelative.startsWith('..') || isAbsolute(receiptRelative))throw new Error('TEAMQA_RECEIPT_MUST_BE_INSIDE_RUN_DIR');
          const context=proof.context.map(item=>{
            const path=realpathSync(join(proof.runtime_root,item.path));
            const rel=relative(proof.runtime_root,path);
            if(rel.startsWith('..') || isAbsolute(rel))throw new Error('TEAMQA_CONTEXT_OUTSIDE_RUNTIME');
            const bytes=readFileSync(path);
            if(hashBuffer(bytes)!==item.sha256)throw new Error('TEAMQA_CONTEXT_HASH_MISMATCH');
            return bytes.toString('utf8');
          }).join('\n\n');
          prompt=`TEAMQA_RUN_BINDING run=${proof.run_id} round=${proof.round} role=executor_code roster=${proof.roster_hash}\n`+context+'\n\n'+prompt;
        }
        if(!coder)throw new Error('HR3 coder vendor unknown');
        if(options.verifiedTeamQaProof && options.verifiedTeamQaProof.coder.provider!==coder)throw new Error('TEAMQA_CODER_PROVIDER_MISMATCH');
        if(coder===options.provider && !options.verifiedTeamQaProof)throw new Error('HR3 same-provider standalone review forbidden');
      } catch(error) {
        const verdict=ungraded(options,gate0,0,error.message);emit(verdict,outputPath);return 20;
      }
    }

    if(options.nativePrepare) {
      try {
        const intent=prepareNativeQa({options,proof:options.verifiedTeamQaProof,repo,commits,gate0,prompt});
        process.stdout.write(JSON.stringify(intent)+'\nTEAMQA_NATIVE_PREPARED sha256='+hashBuffer(readFileSync(options.nativePrepare))+'\n');
        return 0;
      } catch(error) {process.stderr.write('qa-code: UNGRADED '+error.message+'\n');return 20;}
    }

    const tamperingMarker = tamperingMarkerPath(options.gate0, gate0.run_uuid);
    if (existsSync(tamperingMarker)) {
      const verdict = ungraded(
        options,
        gate0,
        0,
        `R-WRITE tampering: the run was sealed by ${tamperingMarker}; there is no path to PASS in the same run`,
        true,
      );
      emit(verdict, outputPath);
      writeMachineReceipt(options, gate0, repo, commits, verdict, [], 'failed');
      return 20;
    }

    const promptPath = join(workspace, 'prompt.md');
    writeFileSync(promptPath, prompt, 'utf8');
    let retries = 0;
    const observedToolLog = [];

    while (true) {
      const beforeEngine = repoState(repo);
      if (beforeEngine.error) {
        try { recordTampering(options.gate0, gate0, beforeEngine.error); } catch { /* the receipt stays fail-closed */ }
        const verdict = ungraded(
          options,
          gate0,
          retries,
          `R-WRITE tampering: ${beforeEngine.error}`,
          true,
        );
        emit(verdict, outputPath);
        writeMachineReceipt(options, gate0, repo, commits, verdict, observedToolLog, 'failed');
        return 20;
      }

      const sessionId = randomUUID();
      const command=options.provider && !options.native ? providerCommand({provider:options.provider,model:options.providerModel,reasoning:options.reasoning,repo,mode:options.mode,sessionId,caps:options.providerCaps}) : null;
      const executable=options.verifiedTeamQaProof?.resolved_seat?.harness_bin || command?.command;
      let nativeLoaded=null;
      try {if(options.native) nativeLoaded=loadNativeQaExecution({options,proof:options.verifiedTeamQaProof,repo,commits,gate0,prompt});}
      catch(error){const verdict=ungraded(options,gate0,0,'R-NATIVE: '+error.message);emit(verdict,outputPath);return 20;}
      const result = nativeLoaded ? {status:0,stdout:nativeLoaded.parsed.verdictText,stderr:''} : command
        ? run(executable,command.args,{cwd:repo,input:prompt,timeout})
        : options.engineCmd
          ? invokeInjected(options.engineCmd,prompt,repo,timeout)
          : invokeGrok({mode:options.mode,engine:options.engine || DEFAULT_ENGINE,promptPath,repo,timeout,sessionId});
      const tamperReason = tampering(beforeEngine, repoState(repo));
      if (tamperReason) {
        try { recordTampering(options.gate0, gate0, tamperReason); } catch { /* the receipt stays fail-closed */ }
        const verdict = ungraded(
          options,
          gate0,
          retries,
          `R-WRITE tampering: ${tamperReason}`,
          true,
        );
        emit(verdict, outputPath);
        writeMachineReceipt(options, gate0, repo, commits, verdict, observedToolLog, 'failed');
        return 20;
      }


      if(nativeLoaded) {
        const parsed=nativeLoaded.parsed;
        options.providerExecution=nativeLoaded.execution;
        options.providerAttestation=nativeLoaded.attestation;
        observedToolLog.push(...parsed.tool_log);
        try{verifyTeamQaReviewProof({proofPath:options.teamqaProof,runtimePath:options.teamqaRuntime,repo,base:commits.base,head:commits.head,provider:options.provider,model:options.providerModel,reasoning:options.reasoning,stage:'post',attestation:options.providerAttestation});}
        catch(error){const verdict=ungraded(options,gate0,0,error.message);emit(verdict,outputPath);return 20;}
      } else if(command) {
        const parsed=parseProviderExecution({provider:options.provider,stdout:result.stdout,stderr:result.stderr});
        const provenanceErrors=validateProviderExecution(parsed,{provider:options.provider,model:options.providerModel,reasoning:options.reasoning,mode:options.mode});
        const logPath=options.receipt+`.provider-${retries}.jsonl`;
        observedToolLog.length=0;
        const stderrPath=options.receipt+`.provider-${retries}.stderr`;
        writeFileSync(logPath,result.stdout || '','utf8');
        writeFileSync(stderrPath,result.stderr || '','utf8');
        options.providerExecution={schema:'qa-code/provider-execution/v1',provider:options.provider,sent:{model:options.providerModel,reasoning:options.reasoning},observed:parsed.observed,metadata_source:parsed.metadata_source,session_id:parsed.session_id,command:command.command,executable,args:command.args,version:options.harnessVersion || null,binary_sha256:options.harnessBinHash || null,source:{path:logPath,sha256:parsed.stream_sha256},stderr_source:{path:stderrPath,sha256:parsed.stderr_sha256},errors:provenanceErrors};
        observedToolLog.push(...parsed.tool_log);
        if(provenanceErrors.length) {
          const verdict=ungraded(options,gate0,retries,'R-PROVIDER: '+provenanceErrors.join('; '));emit(verdict,outputPath);writeMachineReceipt(options,gate0,repo,commits,verdict,observedToolLog,'failed');return 20;
        }
        if(options.verifiedTeamQaProof) {
          const attestation={schema:'team-qa/role-attestation/v1',run_id:options.verifiedTeamQaProof.run_id,round:options.verifiedTeamQaProof.round,roster_hash:options.verifiedTeamQaProof.roster_hash,context:options.verifiedTeamQaProof.context,role:'executor_code',agent_id:command.command+':'+parsed.session_id,session_id:parsed.session_id,runtime:{provider:options.provider,model:options.providerModel,effort:options.reasoning,harness:command.command,version:options.harnessVersion,sent:{model:options.providerModel,effort:options.reasoning},observed:{model:parsed.observed.model,effort:parsed.observed.reasoning,session_id:parsed.session_id}},source:{kind:options.provider==='openai'?'codex-stream':'claude-stream',path:logPath,sha256:parsed.stream_sha256,stderr_path:stderrPath,stderr_sha256:parsed.stderr_sha256,...(parsed.metadata_source?{metadata_source:parsed.metadata_source}:{})},graded:true};
          const attestationPath=options.receipt+'.role-attestation.json';writeFileSync(attestationPath,JSON.stringify(attestation,null,2)+'\n');
          options.providerExecution.attestation_path=attestationPath;
          options.providerExecution.attestation=attestation;
          options.providerAttestation=attestation;
          try{verifyTeamQaReviewProof({proofPath:options.teamqaProof,runtimePath:options.teamqaRuntime,repo,base:commits.base,head:commits.head,provider:options.provider,model:options.providerModel,reasoning:options.reasoning,stage:'post',attestation});}
          catch(error){const verdict=ungraded(options,gate0,retries,error.message);emit(verdict,outputPath);writeMachineReceipt(options,gate0,repo,commits,verdict,observedToolLog,'failed');return 20;}
        }
        result.stdout=parsed.verdictText;
      } else if(!options.engineCmd) observedToolLog.push(...toolLogFromGrok(repo,sessionId));


      const deadReason = engineFailure(result);
      if (deadReason) {
        const verdict = ungraded(options, gate0, retries, `R-DEAD: ${deadReason}`);
        emit(verdict, outputPath);
        writeMachineReceipt(options, gate0, repo, commits, verdict, observedToolLog, 'failed');
        return 20;
      }

      let raw;
      try {
        raw = JSON.parse(result.stdout);
      } catch (error) {
        if (retries === 0 && !options.native) {
          retries = 1;
          continue;
        }
        const verdict = ungraded(options, gate0, retries, `R-JSON: broken JSON: ${error.message}`);
        emit(verdict, outputPath);
        writeMachineReceipt(options, gate0, repo, commits, verdict, observedToolLog, 'failed');
        return 20;
      }

      const candidate = enforceHarness(raw, options, gate0, retries);
      if (options.mode === 'tools' && candidate.verdict === 'PASS' && observedToolLog.length === 0) {
        const verdict = ungraded(options, gate0, retries, 'R-TOOLS: PASS tools has no machine-observed tool-log');
        emit(verdict, outputPath);
        writeMachineReceipt(options, gate0, repo, commits, verdict, observedToolLog, 'completed');
        return 20;
      }
      const checked = validateCandidate(candidate, options.gate0, workspace, repo, commits.base, options);
      const semanticFailAccepted = checked.result.status === 1
        && checked.validation?.ok === true
        && checked.validation?.verdict_out === 'FAIL';
      const semanticUngradedAccepted = checked.result.status === 20
        && checked.validation?.ok === true
        && checked.validation?.verdict_out === 'UNGRADED';
      if ((!semanticFailAccepted && !semanticUngradedAccepted && checked.result.status !== 0)
        || checked.readError || checked.validation?.ok !== true) {
        if (retries === 0 && !options.native) {
          retries = 1;
          continue;
        }
        const detail = checked.readError
          || checked.validation?.rejected?.map((item) => item.why).filter(Boolean).join('; ')
          || checked.result.stderr.trim()
          || `validator exit ${String(checked.result.status)}`;
        const verdict = ungraded(options, gate0, retries, `R-JSON: the validator rejected the verdict: ${detail}`);
        emit(verdict, outputPath);
        writeMachineReceipt(options, gate0, repo, commits, verdict, observedToolLog, 'completed');
        return 20;
      }

      if (checked.validation.verdict_out === 'UNGRADED') {
        const why = checked.validation.downgraded?.map((item) => item.why).filter(Boolean).join('; ')
          || 'validator P2 downgraded the verdict to UNGRADED';
        const verdict = ungraded(options, gate0, retries, `R-JSON: ${why}`);
        emit(verdict, outputPath);
        writeMachineReceipt(options, gate0, repo, commits, verdict, observedToolLog, 'completed');
        return 20;
      }

      if(options.providerAttestation) {
        try{verifyTeamQaReviewProof({proofPath:options.teamqaProof,runtimePath:options.teamqaRuntime,repo,base:commits.base,head:commits.head,provider:options.provider,model:options.providerModel,reasoning:options.reasoning,stage:'post',attestation:options.providerAttestation,bindRole:true});}
        catch(error){const verdict=ungraded(options,gate0,retries,error.message);emit(verdict,outputPath);writeMachineReceipt(options,gate0,repo,commits,verdict,observedToolLog,'failed');return 20;}
      }
      emit(candidate, outputPath);
      const receipt = writeMachineReceipt(options, gate0, repo, commits, candidate, observedToolLog, 'completed');
      if (receipt.semantic_verdict === 'UNGRADED') return 20;
      if (candidate.verdict === 'UNGRADED') return 20;
      if (candidate.verdict === 'FAIL') return 1;
      return 0;
    }
  } finally {
    const archived = join(tmpdir(),'qa-code-archive');
    mkdirSync(archived,{recursive:true});
    renameSync(workspace,join(archived,basename(workspace)));
  }
}

if(process.argv[1] && realpathSync(process.argv[1])===fileURLToPath(import.meta.url))process.exitCode = main();
