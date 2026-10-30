import { closeSync, openSync, readSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, sep } from 'node:path';
import { fail, sha256 } from './core.mjs';
import { scanOriginalSource } from './original-source.mjs';

export function readFirstOriginalLine(path) {
  const fd=openSync(path,'r'),chunks=[],buffer=Buffer.alloc(4096);
  let size=0;
  try {
    for (;;) {
      const count=readSync(fd,buffer,0,buffer.length,null),newline=buffer.subarray(0,count).indexOf(10);
      const length=newline<0?count:newline;
      size+=length;
      if(size>1024*1024)fail(3,'NATIVE_HOST_METADATA_TOO_LARGE');
      if(length)chunks.push(Buffer.from(buffer.subarray(0,length)));
      if(newline>=0||count===0)return Buffer.concat(chunks).toString('utf8');
    }
  } finally { closeSync(fd); }
}

export function nativeHostSource(path) {
  path=realpathSync(path);
  let root;
  try{root=realpathSync(join(homedir(),'.codex/sessions'));}
  catch(error){if(error.code==='ENOENT')fail(3,'NATIVE_HOST_UNTRUSTED');throw error;}
  if(!path.startsWith(root+sep))fail(3,'NATIVE_HOST_UNTRUSTED');
  const raw=readFirstOriginalLine(path),e=JSON.parse(raw);
  if(e.type!=='session_meta'||!e.payload?.id||!e.payload.cli_version)fail(3,'NATIVE_HOST_METADATA_MISSING');
  return {path,line:1,sha256:sha256(raw),session_id:e.payload.id,agent_path:e.payload.source?.subagent?.thread_spawn?.agent_path||'/root',version:e.payload.cli_version};
}

export function verifyNativeHost(source) {
  const actual=nativeHostSource(source.path);
  if(JSON.stringify(actual)!==JSON.stringify(source))fail(3,'NATIVE_HOST_DRIFT');
  return actual;
}

export function nativeCreationEpoch({childSourcePath,parentSource,host}) {
  verifyNativeHost(host);
  const child=nativeHostSource(childSourcePath);
  if(realpathSync(parentSource.path)!==host.path)fail(3,'NATIVE_PARENT_SOURCE_MISMATCH');
  let parent='',turn;
  scanOriginalSource(host.path,(raw,index)=>{
    if(index===parentSource.line-1)parent=raw;
    if(index>=parentSource.line-1)return;
    const event=JSON.parse(raw);
    if(event.type==='turn_context')turn={line:index+1,sha256:sha256(raw),turn_id:event.payload?.turn_id};
  });
  if(!Number.isInteger(parentSource.line)||parentSource.line<1||sha256(parent)!==parentSource.sha256)fail(3,'NATIVE_PARENT_SOURCE_HASH_MISMATCH');
  if(!turn?.turn_id)fail(3,'NATIVE_RUNTIME_EPOCH_MISSING');
  return {child_version:child.version,parent_origin_version:host.version,parent_turn_source:turn};
}
