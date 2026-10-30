#!/usr/bin/env node
// qa_do.mjs — run a Dragon `do` macro (or any RPC) and pretty-print the QA result.
//
// WHY: calling Dragon RPC from Cowork goes through `osascript do shell script`, and embedding a
// complex `do` JSON payload inline breaks on nested-quote escaping. Writing the payload to a
// file and running THIS on the Mac avoids all of that — Node parses JSON natively.
//
// USAGE (on the Mac, e.g. via Control-your-Mac osascript):
//   node qa_do.mjs <payload.json>          # payload = a `do` params object OR {method,params}
//   node qa_do.mjs --method listTabs       # quick RPC with no params
//   node qa_do.mjs --method perceive --params '{"tabId":123,"max":40}'
//   cat payload.json | node qa_do.mjs -    # read payload from stdin
//
// AUTH: DRAGON_RPC_TOKEN takes priority, then DRAGON_RPC_TOKEN_FILE, then the stable
// ~/.dragon-browser/auth/service-token and legacy ~/.dragon-browser/auth/token files.
// A missing token fails before any network request. Never print or copy the token into a payload.
//
// payload.json forms (both accepted):
//   { "tabId": 123, "steps": [ ... ], "timeout": 35000 }        # treated as a `do` call
//   { "method": "do", "params": { "tabId":123, "steps":[...] }, "timeout": 35000 }
//
// Output: JSON with { ok, completed, reads, asserts, verdict }. On a clean, complete run (ok and completed !== false)
// verdict comes from the asserts (all ok => PASS, any not-ok => FAIL), else "n/a" (inspect reads yourself). A failed
// step, an incomplete run, a denial or an HTTP error is never PASS: FAIL when an assert failed, else UNGRADED.

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const RPC = process.env.DRAGON_RPC || 'http://localhost:9233/rpc';
const STABLE_TOKEN_FILE = join(homedir(), '.dragon-browser', 'auth', 'service-token');
const LEGACY_TOKEN_FILE = join(homedir(), '.dragon-browser', 'auth', 'token');

function rpcToken() {
  const fromEnv = String(process.env.DRAGON_RPC_TOKEN || '').trim();
  if (fromEnv) return fromEnv;
  const tokenFiles = process.env.DRAGON_RPC_TOKEN_FILE
    ? [process.env.DRAGON_RPC_TOKEN_FILE]
    : [STABLE_TOKEN_FILE, LEGACY_TOKEN_FILE];
  for (const tokenFile of tokenFiles) {
    try {
      const fromFile = readFileSync(tokenFile, 'utf8').trim();
      if (fromFile) return fromFile;
    } catch {}
  }
  throw new Error('Dragon bearer token is missing; set DRAGON_RPC_TOKEN or DRAGON_RPC_TOKEN_FILE');
}

function safeMessage(error, token = '') {
  const message = error instanceof Error ? error.message : String(error);
  return token ? message.split(token).join('[redacted]') : message;
}

function readStdin() {
  return new Promise((res) => {
    let s = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d) => (s += d));
    process.stdin.on('end', () => res(s));
  });
}

function parseArgs(argv) {
  const a = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--method') a.method = argv[++i];
    else if (t === '--params') a.params = argv[++i];
    else if (t === '--timeout') a.timeout = Number(argv[++i]);
    else a._.push(t);
  }
  return a;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  let body;

  if (args.method) {
    body = { method: args.method, params: args.params ? JSON.parse(args.params) : {} };
    if (args.timeout) body.timeout = args.timeout;
  } else {
    const src = args._[0];
    let raw;
    if (!src || src === '-') raw = await readStdin();
    else raw = (await import('node:fs')).readFileSync(src, 'utf8');
    const obj = JSON.parse(raw);
    if (obj.method && obj.params) body = obj; // already {method,params}
    else body = { method: 'do', params: obj }; // treat as `do` params
    if (obj.timeout && !body.timeout) body.timeout = obj.timeout;
  }

  const token = rpcToken();
  let response;
  let r;
  try {
    response = await fetch(RPC, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(Number(body.timeout) || 15_000),
    });
    const raw = await response.text();
    try { r = JSON.parse(raw); }
    catch { throw new Error('Dragon RPC returned malformed JSON'); }
  } catch (error) {
    throw new Error(safeMessage(error, token));
  }

  const result = r.result || {};
  const failedStep = Array.isArray(result?.results)
    ? result.results.find((step) => step?.ok === false)
    : null;
  const nestedError = result?.ok === false
    ? `${result.code || 'DENIED'} — ${result.reason || result.error || 'Dragon denied the call'}`
    : failedStep
      ? `${failedStep.code || 'STEP_FAILED'} — ${failedStep.reason || failedStep.error || 'Dragon denied a step'}`
      : body.method === 'do' && result?.completed === false
        ? 'INCOMPLETE — Dragon did not complete every step'
        : null;
  const asserts = result.asserts || [];
  const ok = response.ok && r.ok !== false && !r.error && !nestedError;
  const assertFailed = asserts.some((a) => !a?.ok);
  // PASS needs a clean, complete run: asserts that ran before a failed step, a denial or an HTTP error prove nothing
  // about the steps that did not run, so that is UNGRADED unless an assert already failed (FAIL).
  let verdict;
  if (ok && result.completed !== false) verdict = asserts.length ? (assertFailed ? 'FAIL' : 'PASS') : 'n/a';
  else verdict = assertFailed ? 'FAIL' : 'UNGRADED';

  const out = {
    ok,
    error: safeMessage(r.error || nestedError || (!response.ok ? `HTTP ${response.status}` : ''), token) || null,
    completed: result.completed,
    reads: result.reads || null,
    asserts: asserts.length ? asserts : null,
    verdict,
  };
  // For non-`do` calls (listTabs/perceive/etc), just dump the raw result.
  if (body.method !== 'do') {
    console.log(JSON.stringify({ ok: out.ok, error: out.error, result }, null, 2));
    if (!out.ok) process.exitCode = 1;
    return;
  }
  console.log(JSON.stringify(out, null, 2));
  if (!out.ok) process.exitCode = 1;
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: safeMessage(error) }));
  process.exitCode = 1;
});
