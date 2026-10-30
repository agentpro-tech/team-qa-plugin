import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,statSync,utimesSync,renameSync,symlinkSync,realpathSync,openSync,closeSync,writeSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import {originalSource,scanOriginalSource,withOriginalSourceRead} from '../../scripts/lib/original-source.mjs';

const fixture=()=>{const dir=realpathSync(mkdtempSync(join(tmpdir(),'teamqa-original-source-'))),path=join(dir,'source.jsonl');writeFileSync(path,'{"payload":{"value":1}}\n');return{dir,path};};
test('one verification reuses immutable source rows, but later reads always start fresh',()=>{
 const {path}=fixture();let first;
 withOriginalSourceRead(()=>{
  first=originalSource(path);const row=first.row(0);
  assert.equal(originalSource(path),first);assert.equal(first.row(0),row);
  assert.throws(()=>{row.payload.value=2;},TypeError);assert.equal(first.row(0).payload.value,1);
  assert.throws(()=>first.lines.push('{}'),TypeError);
  withOriginalSourceRead(()=>assert.equal(originalSource(path),first));
 });
 withOriginalSourceRead(()=>assert.notEqual(originalSource(path),first));
 assert.notEqual(originalSource(path),originalSource(path));
});
test('an exception discards the source scope without retaining failed verification state',()=>{
 const {path}=fixture();let first;
 assert.throws(()=>withOriginalSourceRead(()=>{first=originalSource(path);throw Error('verification rejected');}),/verification rejected/);
 withOriginalSourceRead(()=>assert.notEqual(originalSource(path),first));
});
test('append, same-size rewrite with restored mtime and inode replacement invalidate source decoding',()=>{
 for(const change of ['append','same-size','replace']){
  const {path}=fixture();if(change==='same-size')utimesSync(path,1700000000,1700000000);withOriginalSourceRead(()=>{
   const first=originalSource(path);assert.equal(first.row(0).payload.value,1);const before=statSync(path);
   if(change==='replace')renameSync(path,path+'.preimage');
   writeFileSync(path,change==='append'?readFileSync(path,'utf8')+'{"extra":true}\n':'{"payload":{"value":2}}\n');
   if(change==='same-size'){utimesSync(path,before.atime,before.mtime);assert.equal(statSync(path).mtimeMs,before.mtimeMs);}
   const next=originalSource(path);assert.notEqual(next,first);
   assert.equal(next.row(0).payload.value,change==='append'?1:2);
   if(change==='append')assert.deepEqual(next.row(1),{extra:true});
  });
 }
});
test('original source reads retain the 32 MiB bound, including growth after a cached read',()=>{
 for(const cached of [false,true]){
  const {path}=fixture();withOriginalSourceRead(()=>{
   if(cached)originalSource(path).row(0);
   writeFileSync(path,' '.repeat(32*1024*1024+1));
   assert.throws(()=>originalSource(path),e=>e.code==='ORIGINAL_SOURCE_TOO_LARGE');
  });
 }
});
test('source changes during a fresh read or cached-hit fingerprint check are rejected',()=>{
 for(const cached of [false,true]){
  const {path}=fixture(),stat=fs.statSync,read=fs.readFileSync;
  try{withOriginalSourceRead(()=>{
   if(cached)originalSource(path).row(0);
   let changed=false;
   if(cached)fs.statSync=(p,...args)=>{const value=stat(p,...args);if(String(p)===path&&!changed){changed=true;writeFileSync(path,'{"payload":{"value":2}}\n');}return value;};
   else fs.readFileSync=(p,...args)=>{const value=read(p,...args);if(String(p)===path&&!changed){changed=true;writeFileSync(path,'{"payload":{"value":2}}\n');}return value;};
   syncBuiltinESMExports();
   assert.throws(()=>originalSource(path),e=>e.code==='ORIGINAL_SOURCE_CHANGED');
  });}finally{fs.statSync=stat;fs.readFileSync=read;syncBuiltinESMExports();}
 }
});
test('symlink retargeting and malformed source cannot reuse previously decoded evidence',()=>{
 const {dir,path}=fixture(),other=join(dir,'other.jsonl'),link=join(dir,'link.jsonl');writeFileSync(other,'{"payload":{"value":2}}\n');symlinkSync(path,link);
 withOriginalSourceRead(()=>{
  const first=originalSource(link);assert.equal(first.row(0).payload.value,1);
  renameSync(link,link+'.preimage');symlinkSync(other,link);assert.equal(originalSource(link).row(0).payload.value,2);
  writeFileSync(other,'malformed\n');assert.throws(()=>originalSource(link).row(0),SyntaxError);
 });
});
test('scanner verifies complete original transcript above 32 MiB with bounded line visits',()=>{
 const {path}=fixture(),fd=openSync(path,'w'),hash=createHash('sha256');
 const first='{"payload":{"value":1}}\n',middle=`{"padding":"${'x'.repeat(65500)}"}\n`,last='{"payload":{"value":2}}\n';
 try{for(const raw of [first,...Array(520).fill(middle),last]){writeSync(fd,raw);hash.update(raw);}}finally{closeSync(fd);}
 assert.ok(statSync(path).size>32*1024*1024);
 const found=[];
 const result=scanOriginalSource(path,(raw,index)=>{if(index===0||index===521)found.push([index,JSON.parse(raw).payload.value]);});
 assert.deepEqual(found,[[0,1],[521,2]]);
 assert.equal(result.lines,523);
 assert.equal(result.sha256,hash.digest('hex'));
 assert.ok(result.fingerprint.endsWith(result.sha256));
});
test('scanner rejects an in-place mutation even if source metadata is masked',()=>{
 const {path}=fixture(),original=fs.statSync,initial=original(path,{bigint:true});
 let mutated=false;
 try{
  fs.statSync=(p,...args)=>String(p)===path?initial:original(p,...args);
  syncBuiltinESMExports();
  assert.throws(()=>scanOriginalSource(path,(_,index)=>{
   if(index===0&&!mutated){mutated=true;writeFileSync(path,'{"payload":{"value":2}}\n');}
  }),e=>e.code==='ORIGINAL_SOURCE_CHANGED');
 }finally{fs.statSync=original;syncBuiltinESMExports();}
 assert.equal(mutated,true);
});
