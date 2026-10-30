import {closeSync,openSync,readSync,realpathSync,statSync} from 'node:fs';
import {createHash} from 'node:crypto';

const MAX_LINE=32*1024*1024;
const identity=path=>{const s=statSync(path,{bigint:true});return [s.dev,s.ino,s.size,s.mtimeNs,s.ctimeNs].join(':');};

// Read the original in bounded chunks and verify its bytes again before using observations.
export function scanOriginalSource(source,visit=()=>{}) {
 const path=realpathSync(source),before=identity(path);
 const pass=emit=>{
  const fd=openSync(path,'r'),chunk=Buffer.allocUnsafe(64*1024),digest=createHash('sha256');
  let parts=[],bytes=0,lines=0;
  const line=()=>{if(emit)visit(Buffer.concat(parts,bytes).toString('utf8'),++lines);parts=[];bytes=0;};
  try {
   for(;;){const count=readSync(fd,chunk,0,chunk.length,null);if(!count)break;digest.update(chunk.subarray(0,count));
    if(!emit)continue;
    let start=0;
    for(let i=0;i<count;i++)if(chunk[i]===10){
     const part=chunk.subarray(start,i);if(part.length){parts.push(Buffer.from(part));bytes+=part.length;}
     if(bytes>MAX_LINE)throw new Error('ORIGINAL_SOURCE_LINE_TOO_LARGE');
     line();start=i+1;
    }
    if(start<count){const part=chunk.subarray(start,count);parts.push(Buffer.from(part));bytes+=part.length;}
    if(bytes>MAX_LINE)throw new Error('ORIGINAL_SOURCE_LINE_TOO_LARGE');
   }
   if(emit&&bytes)line();
   return {sha256:digest.digest('hex'),lines};
  }finally{closeSync(fd);}
 };
 const first=pass(true);
 if(identity(path)!==before||pass(false).sha256!==first.sha256||identity(path)!==before)throw new Error('ORIGINAL_SOURCE_CHANGED');
 return {path,...first};
}
