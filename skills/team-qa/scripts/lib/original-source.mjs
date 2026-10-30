import { closeSync, openSync, readFileSync, readSync, realpathSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';

let currentRead;
const fingerprint = path => {
  const s=statSync(path,{bigint:true});
  if(s.size>32n*1024n*1024n)throw Object.assign(new Error('Original source exceeds 32 MiB'),{code:'ORIGINAL_SOURCE_TOO_LARGE'});
  return [s.dev,s.ino,s.size,s.mtimeNs,s.ctimeNs].join(':');
};
const identity = path => {
  const s=statSync(path,{bigint:true});
  return [s.dev,s.ino,s.size,s.mtimeNs,s.ctimeNs].join(':');
};
const changed = () => Object.assign(new Error('Original source changed during read'),{code:'ORIGINAL_SOURCE_CHANGED'});

// Scan the original file without retaining its transcript. A second full hash
// catches in-place changes even when size and timestamps appear unchanged.
export function scanOriginalSource(path, visit=()=>{}) {
  path=realpathSync(path);
  const before=identity(path);
  const pass=emit=>{
    const fd=openSync(path,'r'),hash=createHash('sha256'),buffer=Buffer.allocUnsafe(64*1024);
    let chunks=[],length=0,index=0;
    const line=()=>{
      if(emit)visit(Buffer.concat(chunks,length).toString('utf8'),index);
      index++;chunks=[];length=0;
    };
    try {
      for(;;){
        const count=readSync(fd,buffer,0,buffer.length,null);
        if(!count)break;
        hash.update(buffer.subarray(0,count));
        if(!emit)continue;
        let start=0;
        for(let i=0;i<count;i++)if(buffer[i]===10){
          const part=buffer.subarray(start,i);
          if(part.length){chunks.push(Buffer.from(part));length+=part.length;}
          if(length>32*1024*1024)throw Object.assign(new Error('Original source line exceeds 32 MiB'),{code:'ORIGINAL_SOURCE_LINE_TOO_LARGE'});
          line();start=i+1;
        }
        if(start<count){const part=buffer.subarray(start,count);chunks.push(Buffer.from(part));length+=part.length;}
        if(length>32*1024*1024)throw Object.assign(new Error('Original source line exceeds 32 MiB'),{code:'ORIGINAL_SOURCE_LINE_TOO_LARGE'});
      }
      if(emit)line();
      return {sha256:hash.digest('hex'),lines:index};
    } finally {closeSync(fd);}
  };
  const first=pass(true);
  if(identity(path)!==before)throw changed();
  const second=pass(false);
  if(identity(path)!==before||second.sha256!==first.sha256)throw changed();
  return Object.freeze({fingerprint:`${before}:${first.sha256}`,sha256:first.sha256,lines:first.lines});
}
function freeze(value) {
  if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}
  return value;
}

// Reuse source decoding only inside one synchronous verification, never its verdicts.
export function withOriginalSourceRead(read) {
  if(currentRead)return read();
  currentRead=new Map();
  try{return read();}finally{currentRead=undefined;}
}

export function originalSource(path) {
  path=realpathSync(path);
  const before=fingerprint(path),cached=currentRead?.get(path);
  if(cached?.fingerprint===before){
    if(fingerprint(path)!==before)throw Object.assign(new Error('Original source changed during read'),{code:'ORIGINAL_SOURCE_CHANGED'});
    return cached;
  }
  const lines=Object.freeze(readFileSync(path,'utf8').split('\n'));
  if(fingerprint(path)!==before)throw Object.assign(new Error('Original source changed during read'),{code:'ORIGINAL_SOURCE_CHANGED'});
  const decoded=new Map();
  const source=Object.freeze({fingerprint:before,lines,row(index){
    if(!decoded.has(index))decoded.set(index,freeze(JSON.parse(lines[index]??'null')));
    return decoded.get(index);
  }});
  currentRead?.set(path,source);
  return source;
}
