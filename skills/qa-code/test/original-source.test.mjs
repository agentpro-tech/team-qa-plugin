import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {syncBuiltinESMExports} from 'node:module';
import {scanOriginalSource} from '../scripts/lib/original-source.mjs';

test('large original scan keeps exact bytes and one-based lines across chunk boundaries',()=>{
 const dir=fs.mkdtempSync(join(tmpdir(),'qa-code-original-')),path=join(dir,'synthetic.jsonl');
 const raw=`{"padding":"${'ộ'.repeat(22000)}"}\n`,digest=createHash('sha256');
 const fd=fs.openSync(path,'w');
 try{for(let i=0;i<520;i++){fs.writeSync(fd,raw);digest.update(raw);}}finally{fs.closeSync(fd);}
 try{
  assert.ok(fs.statSync(path).size>32*1024*1024);
  let visited=0;
  const result=scanOriginalSource(path,(line,number)=>{assert.equal(number,++visited);assert.equal(line+'\n',raw);});
  assert.equal(result.lines,520);assert.equal(visited,520);assert.equal(result.sha256,digest.digest('hex'));
 }finally{fs.renameSync(dir,dir+'-archive');}
});

test('full second hash rejects in-place mutation even when stat identity is masked',()=>{
 const dir=fs.mkdtempSync(join(tmpdir(),'qa-code-original-mutation-')),path=join(dir,'synthetic.jsonl');
 fs.writeFileSync(path,'{"value":1}\n');
 const stat=fs.statSync,initial=stat(path,{bigint:true});let changed=false;
 try{
  fs.statSync=(p,...args)=>String(p)===path?initial:stat(p,...args);syncBuiltinESMExports();
  assert.throws(()=>scanOriginalSource(path,()=>{if(!changed){changed=true;fs.writeFileSync(path,'{"value":2}\n');}}),/ORIGINAL_SOURCE_CHANGED/);
  assert.equal(changed,true);
 }finally{fs.statSync=stat;syncBuiltinESMExports();fs.renameSync(dir,dir+'-archive');}
});

test('oversized single line still fails closed',()=>{
 const dir=fs.mkdtempSync(join(tmpdir(),'qa-code-original-line-')),path=join(dir,'synthetic.jsonl');
 try{fs.writeFileSync(path,'x'.repeat(32*1024*1024+1));assert.throws(()=>scanOriginalSource(path),/ORIGINAL_SOURCE_LINE_TOO_LARGE/);}
 finally{fs.renameSync(dir,dir+'-archive');}
});
