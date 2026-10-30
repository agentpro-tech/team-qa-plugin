import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const moduleUrl = new URL('../../scripts/lib/native-host.mjs', import.meta.url).href;
const hash = value => createHash('sha256').update(value).digest('hex');
const metadata = { type: 'session_meta', payload: { id: 'fixture-host', cli_version: '0.200.0',
  source: { subagent: { thread_spawn: { agent_path: '/root/fixture' } } } } };

function readHost({ line = JSON.stringify(metadata), tail = 0, mode = 'read' } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'teamqa-native-host-'));
  mkdirSync(join(home, '.codex/sessions'), { recursive: true });
  const code = `
    import fs from 'node:fs';
    import os from 'node:os';
    import { join } from 'node:path';
    import { syncBuiltinESMExports } from 'node:module';
    const [home]=process.argv.slice(1),args=JSON.parse(fs.readFileSync(0,'utf8'));
    os.homedir=()=>home;syncBuiltinESMExports();
    const {nativeHostSource,verifyNativeHost}=await import(${JSON.stringify(moduleUrl)});
    const path=join(home,'.codex/sessions/fixture.jsonl'),outside=join(home,'outside.jsonl');
    fs.writeFileSync(path,args.line+(args.tail?'\\n'+'.'.repeat(args.tail):''));
    const originalRead=fs.readSync,originalWholeRead=fs.readFileSync,originalClose=fs.closeSync;
    let bytes=0,wholeReads=0,closed=0;
    fs.readSync=(...values)=>{const count=originalRead(...values);bytes+=count;return count;};
    fs.readFileSync=(file,...values)=>{if(file===path)wholeReads++;return originalWholeRead(file,...values);};
    fs.closeSync=(...values)=>{closed++;return originalClose(...values);};
    syncBuiltinESMExports();
    try {
      let source=nativeHostSource(path),appendVerified=false;
      if(args.mode==='drift') {
        fs.appendFileSync(path,'\\nnew transcript content');verifyNativeHost(source);appendVerified=true;
        fs.writeFileSync(path,args.line.replace('0.200.0','0.300.0'));
        try{verifyNativeHost(source);}catch(error){console.log(JSON.stringify({code:error.code,appendVerified,bytes,wholeReads,closed}));process.exit(0);}
      }
      if(args.mode==='outside'||args.mode==='symlink') {
        fs.writeFileSync(outside,args.line);
        const target=args.mode==='symlink'?join(home,'.codex/sessions/escape.jsonl'):outside;
        if(args.mode==='symlink')fs.symlinkSync(outside,target);
        source=nativeHostSource(target);
      }
      console.log(JSON.stringify({source,bytes,wholeReads,closed}));
    } catch(error) {console.log(JSON.stringify({code:error.code||error.name,bytes,wholeReads,closed}));}
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', code, home],
    { input: JSON.stringify({ line, tail, mode }), encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, result.stderr || String(result.error || ''));
  return JSON.parse(result.stdout);
}

test('native host metadata reads only the first block of a large transcript', () => {
  const line = JSON.stringify(metadata), result = readHost({ line, tail: 8 * 1024 * 1024 });
  assert.equal(result.source.sha256, hash(line));
  assert.equal(result.source.line, 1);
  assert.equal(result.source.session_id, metadata.payload.id);
  assert.equal(result.source.version, metadata.payload.cli_version);
  assert.equal(result.source.agent_path, '/root/fixture');
  assert.ok(result.bytes > 0 && result.bytes <= 4096, `read ${result.bytes} bytes`);
  assert.equal(result.wholeReads, 0);
  assert.equal(result.closed, 1);
});

test('chunked metadata preserves UTF-8 and EOF without a newline', () => {
  const empty = JSON.stringify({ ...metadata, padding: '' });
  const prefix = empty.slice(0, empty.indexOf('"padding":"') + '"padding":"'.length);
  const line = JSON.stringify({ ...metadata, padding: 'x'.repeat(4095 - Buffer.byteLength(prefix)) + '越'.repeat(6) });
  const result = readHost({ line });
  assert.equal(result.source.sha256, hash(line));
  assert.equal(result.wholeReads, 0);
  assert.ok(result.bytes >= Buffer.byteLength(line) && result.bytes < Buffer.byteLength(line) + 4096);
});

test('fresh metadata reads preserve append-only identity and reject first-line drift', () => {
  const result = readHost({ mode: 'drift' });
  assert.equal(result.appendVerified, true);
  assert.equal(result.code, 'NATIVE_HOST_DRIFT');
  assert.equal(result.closed, 3);
});

test('native host rejects untrusted paths and symlinks, malformed JSON and missing metadata', () => {
  for (const mode of ['outside', 'symlink']) assert.equal(readHost({ mode }).code, 'NATIVE_HOST_UNTRUSTED');
  assert.equal(readHost({ line: '{broken' }).code, 'SyntaxError');
  for (const line of ['', '{}', JSON.stringify({ type: 'turn_context', payload: metadata.payload }),
    JSON.stringify({ type: 'session_meta', payload: { id: 'host' } })]) {
    const result = readHost({ line });
    assert.equal(result.code, line ? 'NATIVE_HOST_METADATA_MISSING' : 'SyntaxError');
    assert.equal(result.closed, 1);
  }
});

test('metadata size is capped while the boundary line remains accepted', () => {
  const base = JSON.stringify({ ...metadata, padding: '' });
  const line = JSON.stringify({ ...metadata, padding: 'x'.repeat(1024 * 1024 - Buffer.byteLength(base)) });
  assert.equal(Buffer.byteLength(line), 1024 * 1024);
  assert.equal(readHost({ line }).source.sha256, hash(line));
  const result = readHost({ line: line + ' ' });
  assert.equal(result.code, 'NATIVE_HOST_METADATA_TOO_LARGE');
  assert.ok(result.bytes <= 1024 * 1024 + 4096);
  assert.equal(result.closed, 1);
});
