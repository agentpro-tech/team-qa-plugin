#!/usr/bin/env node
import {verifyNativeQaIntent,verifyNativeQaSource} from './lib/native-qa.mjs';
const args=process.argv.slice(2),o={};
try {
 for(let n=0;n<args.length;n+=2){if(!['--intent','--evidence','--proof','--teamqa-runtime'].includes(args[n])||!args[n+1]||o[args[n]])throw new Error('NATIVE_VERIFY_ARGUMENTS');o[args[n]]=args[n+1];}
 if(!o['--proof']||!o['--teamqa-runtime']||Boolean(o['--intent'])===Boolean(o['--evidence']))throw new Error('NATIVE_VERIFY_ARGUMENTS');
 const result=o['--intent']?verifyNativeQaIntent({intentPath:o['--intent'],proofPath:o['--proof'],runtimePath:o['--teamqa-runtime']}):verifyNativeQaSource({evidencePath:o['--evidence'],proofPath:o['--proof'],runtimePath:o['--teamqa-runtime']});
 process.stdout.write(JSON.stringify({authorized:true,intent:result.intent,parsed:result.parsed||null,seat:result.seat})+'\n');
}catch(error){process.stderr.write('UNGRADED '+error.message+'\n');process.exitCode=20;}
