import {existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, statSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {dirname,isAbsolute, join, relative, resolve, sep} from 'node:path';
import {homedir,tmpdir} from 'node:os';
import {archiveOwnedPath} from './archive.mjs';
import {fileURLToPath} from 'node:url';
const NODE_REPORTER=join(dirname(fileURLToPath(import.meta.url)),'native-test-reporter.mjs');
const PRELOAD=join(dirname(fileURLToPath(import.meta.url)),'archive-fs-preload.mjs');

const TYPES = new Set(['node', 'vitest', 'deno']);
const FIELDS = new Set(['type', 'testFiles', 'binary', 'config', 'permissions', 'env']);
export function validateTestRunners(value) {
  if (value === undefined) return;
  if (!Array.isArray(value) || !value.length) throw new Error('test_runners must be a nonempty array');
  for (const entry of value) {
    if (!entry || Array.isArray(entry) || typeof entry !== 'object') throw new Error('invalid test_runners entry');
    if (Object.keys(entry).some(key => !FIELDS.has(key))) throw new Error('unknown test_runners field');
    if (!TYPES.has(entry.type)) throw new Error('test_runners.type must be node, vitest or deno');
    if (!Array.isArray(entry.testFiles) || !entry.testFiles.length || entry.testFiles.some(p => typeof p !== 'string' || !p || isAbsolute(p) || p.split(/[\\/]/).includes('..'))) throw new Error('test_runners.testFiles must be repo-relative globs');
    if (entry.binary !== undefined && (entry.type !== 'deno' || typeof entry.binary !== 'string' || !isAbsolute(entry.binary))) throw new Error('only deno may declare an absolute binary');
    if (entry.config !== undefined && (typeof entry.config !== 'string' || isAbsolute(entry.config) || entry.config.split(/[\\/]/).includes('..'))) throw new Error('runner config must be repo-relative');
    if (entry.type === 'node' && entry.config !== undefined) throw new Error('Node runner does not consume a config file');
    if (entry.permissions !== undefined && (entry.type !== 'deno' || !Array.isArray(entry.permissions) || entry.permissions.some(p => typeof p !== 'string' || !/^--allow-(env|read|write|run|net|sys|ffi)(=.*)?$/.test(p)))) throw new Error('only explicit deno permission flags are supported');
    if (entry.env !== undefined && (!entry.env || Array.isArray(entry.env) || typeof entry.env !== 'object' || Object.entries(entry.env).some(([k,v]) => !/^[A-Z][A-Z0-9_]*$/.test(k) || typeof v !== 'string' || ['NODE_OPTIONS','NODE_V8_COVERAGE','NODE_TEST_CONTEXT','PATH','HOME','CODEX_HOME'].includes(k)))) throw new Error('invalid runner env');
  }
}
function within(repo, value) {
  const actual = realpathSync(resolve(repo, value));
  const rel = relative(realpathSync(repo), actual);
  if (rel === '..' || rel.startsWith('..'+sep) || isAbsolute(rel)) throw new Error('runner config escapes repo');
  return actual;
}
function runtimeReceipt(binary, version, provider) {
  return {provider, path:realpathSync(binary), version, sha256:createHash('sha256').update(readFileSync(binary)).digest('hex')};
}


function executedFiles(type,path,repo){
  if(!existsSync(path))throw new Error('native executed-file report missing');
  const rows=new Map();
  const add=(name,passed,skipped,failed)=>{
    const file=realpathSync(resolve(repo,name));
    const row=rows.get(file)||{file,passed:0,skipped:0,failed:0};
    row.passed+=passed;row.skipped+=skipped;row.failed+=failed;rows.set(file,row);
  };
  const text=readFileSync(path,'utf8');
  if(type==='vitest'){
    for(const suite of JSON.parse(text).testResults??[]){
      const tests=suite.assertionResults??[];
      add(suite.name,tests.filter(t=>t.status==='passed').length,tests.filter(t=>!['passed','failed'].includes(t.status)).length,tests.filter(t=>t.status==='failed').length);
    }
  }else if(type==='node'){
    for(const line of text.trim().split('\n').filter(Boolean)){
      const event=JSON.parse(line),d=event.data;
      if(!d.file || d.details?.type==='suite')continue;
      // Node synthesizes a file-pass when no assertions were registered.
      if(d.nesting===0&&d.line===1&&d.column===1&&realpathSync(resolve(repo,d.name))===realpathSync(d.file))continue;
      add(d.file,event.type==='test:pass'&&!d.skip&&!d.todo?1:0,d.skip||d.todo?1:0,event.type==='test:fail'?1:0);
    }
  }else{
    const decode=v=>v.replace(/&(quot|apos|lt|gt|amp);/g,(_,k)=>({quot:'"',apos:"'",lt:'<',gt:'>',amp:'&'}[k]));
    for(const m of text.matchAll(/<testsuite\s+([^>]+)>([\s\S]*?)<\/testsuite>/g)){
      const attrs=Object.fromEntries([...m[1].matchAll(/(\w+)="([^"]*)"/g)].map(v=>[v[1],decode(v[2])]));
      const tests=[...m[2].matchAll(/<testcase\s[^>]*>([\s\S]*?)<\/testcase>/g)];
      if(Number(attrs.tests)!==tests.length)throw new Error('invalid Deno executed-file count');
      const skipped=tests.filter(t=>/<skipped\b/.test(t[1])).length,failed=tests.filter(t=>/<(?:failure|error)\b/.test(t[1])).length;
      add(attrs.name,tests.length-skipped-failed,skipped,failed);
    }
  }
  return [...rows.values()].sort((a,b)=>a.file.localeCompare(b.file));
}

// Closed set of actual stack runners. No shell command, arbitrary reporter, filtering,
// no-tests-pass flag or configurable threshold is accepted by this dispatcher.
export function executeTestFiles({repo, files, runners, coverageDir=null, run, matches}) {
  validateTestRunners(runners);
  const groups = new Map();
  const defaultRunner={type:'node'};
  const records = [];
  const reports = [];
  const scratch = [];
  const unavailable = why => ({status:null,error:new Error(why),stdout:records.map(r=>r.stdout).join('\n'),stderr:why,records,reports,timedOut:false});
  if (!files.length) return unavailable('no declared test files');
  try {
    for (const file of files) {
      const candidates = runners ? runners.filter(r=>r.testFiles.some(p=>matches(p,file))) : [defaultRunner];
      if (candidates.length !== 1) throw new Error(`test runner mapping must be exact for ${file}, got ${candidates.length}`);
      const entry = candidates[0];
      if (!groups.has(entry)) groups.set(entry,[]);
      groups.get(entry).push(file);
    }
    let index=0;
    for (const [entry, selected] of groups) {
      const directory = coverageDir ? join(coverageDir,`runner-${index++}-${entry.type}`) : null;
      if (directory) mkdirSync(directory,{recursive:true});
      const evidenceDir=directory || mkdtempSync(join(tmpdir(),'qa-code-runner-'));
      if(!directory)scratch.push(evidenceDir);
      const executionPath=join(evidenceDir,entry.type==='deno'?'execution.xml':'execution.json');
      let binary=process.execPath, args, version, report, receipt;
      const configPath = entry.config ? within(repo,entry.config) : null;
      const configurationReceipt=configPath?{path:configPath,sha256:createHash('sha256').update(readFileSync(configPath)).digest('hex')}:null;
      const configuration = configPath ? ['--config',configPath] : [];
      if (entry.type === 'node') {
        report=directory ? join(directory,'coverage.lcov') : null;
        args=['--test','--test-reporter=tap','--test-reporter-destination=stdout',`--test-reporter=${NODE_REPORTER}`,`--test-reporter-destination=${executionPath}`, ...(report?['--experimental-test-coverage','--test-reporter=lcov',`--test-reporter-destination=${report}`]:[]), ...selected];
        receipt=runtimeReceipt(binary,process.version,'node');
      } else if (entry.type === 'vitest') {
        const cli=resolve(repo,'node_modules/vitest/vitest.mjs');
        if (!existsSync(cli)) throw new Error('declared Vitest runtime missing');
        version=JSON.parse(readFileSync(resolve(repo,'node_modules/vitest/package.json'))).version;
        report=directory ? join(directory,'lcov.info') : null;
        if (directory && !existsSync(resolve(repo,'node_modules/@vitest/coverage-v8/package.json'))) throw new Error('native @vitest/coverage-v8 required for real Vitest coverage');
        if (directory && JSON.parse(readFileSync(resolve(repo,'node_modules/@vitest/coverage-v8/package.json'))).version!==version) throw new Error('Vitest and coverage-v8 exact versions differ');
        args=['--import',PRELOAD,cli,'run',...configuration,'--reporter=verbose','--reporter=json',`--outputFile.json=${executionPath}`,...(directory?['--coverage.enabled=true','--coverage.provider=v8','--coverage.reporter=lcov',`--coverage.reportsDirectory=${directory}`,'--coverage.clean=false','--coverage.cleanOnRerun=false']:[]),...selected];
        receipt={...runtimeReceipt(binary,process.version,'vitest'),stack_version:version,entry_path:realpathSync(cli),entry_sha256:createHash('sha256').update(readFileSync(cli)).digest('hex')};
      } else {
        binary=entry.binary;
        if (!binary || !existsSync(binary) || !statSync(binary).isFile()) throw new Error('declared absolute Deno binary missing');
        const probe=run(binary,['--version'],{cwd:repo});
        if (probe.error || probe.status!==0 || !/^deno \d/.test(probe.stdout)) throw new Error('Deno runtime version unavailable');
        version=probe.stdout.trim();
        args=['test','--no-lock',`--junit-path=${executionPath}`,...configuration,...(entry.permissions??[]),...(directory?[`--coverage=${join(directory,'raw')}`]:[]),...selected];
        report=directory ? join(directory,'coverage.lcov') : null;
        receipt=runtimeReceipt(binary,version,'deno');
      }
      const result=run(binary,args,{cwd:repo,env:{...(entry.env??{}),FORCE_COLOR:'0',NO_COLOR:'1',...(entry.type==='vitest'?{QA_CODE_FS_ARCHIVE_ROOT:process.env.QA_CODE_ARCHIVE_ROOT || join(homedir(),'.qa-code','archive'),QA_CODE_FS_ARCHIVE_CONFIG_PATHS:JSON.stringify(entry.config?[within(repo,entry.config)]:['vitest.config','vite.config'].flatMap(prefix=>['ts','js','mts','mjs','cts','cjs'].map(ext=>join(repo,prefix+'.'+ext)))),QA_CODE_FS_ARCHIVE_ALLOWED_ROOTS:JSON.stringify([...(directory?[directory]:[]),join(realpathSync(resolve(repo,'node_modules')),'.vite-temp'),join(realpathSync(resolve(repo,'node_modules')),'.vite'),join(repo,'.vite-temp'),join(repo,'.vite')])}:{})},unsetEnv:['NODE_TEST_CONTEXT']});
      const record={runner:entry.type,files:selected,argv:[binary,...args],environment_keys:Object.keys(entry.env??{}),...(configurationReceipt?{configuration:configurationReceipt}:{}),...result,receipt};
      // Error objects do not serialize; retain a concrete first error as well as stderr.
      record.error_message=result.error?.message??null;
      records.push(record);
      if(configPath&&createHash('sha256').update(readFileSync(configPath)).digest('hex')!==configurationReceipt.sha256)return unavailable('runner configuration changed during execution');
      if (result.error || result.timedOut || result.status===null) return {...result,records,reports};
      if (result.status!==0) return {...result,records,reports};
      const executed=executedFiles(entry.type,executionPath,repo);
      record.execution_report={path:executionPath,sha256:createHash('sha256').update(readFileSync(executionPath)).digest('hex'),files:executed};
      const expected=selected.map(f=>realpathSync(resolve(repo,f))).sort((a,b)=>a.localeCompare(b));
      if(expected.length!==executed.length || expected.some((file,i)=>file!==executed[i].file) || executed.some(r=>r.passed<1 || r.skipped>0 || r.failed>0))return unavailable('selected test execution mismatch or skipped/filtered tests');
      if (entry.type==='deno' && directory) {
        const nativeReport=join(directory,'raw','lcov.info');
        if (existsSync(nativeReport)) {
          // The successful test process exports LCOV with its own resolved transpile cache.
          report=nativeReport;
          record.coverage_report={path:report,producer:'deno-test-native',sha256:createHash('sha256').update(readFileSync(report)).digest('hex')};
        } else {
          // A converter that cannot accept this config must fail, never resolve another map.
          const coverageArgs=['coverage',...configuration,'--lcov',`--output=${report}`,join(directory,'raw')];
          const measured=run(binary,coverageArgs,{cwd:repo,unsetEnv:['NODE_TEST_CONTEXT']});
          records.push({runner:'deno-coverage',argv:[binary,...coverageArgs],...(record.configuration?{configuration:record.configuration}:{}),...measured,error_message:measured.error?.message??null,receipt});
          if(configPath&&createHash('sha256').update(readFileSync(configPath)).digest('hex')!==configurationReceipt.sha256)return unavailable('runner configuration changed during coverage conversion');
          if (measured.error || measured.timedOut || measured.status!==0) return {...measured,records,reports};
        }
      }
      if (report && (!existsSync(report) || !readFileSync(report,'utf8').includes('SF:'))) return unavailable(`${entry.type} produced no mapped LCOV source data`);
      if (report) reports.push(report);
    }
    return {status:0,stdout:records.map(r=>r.stdout).join('\n'),stderr:records.map(r=>r.stderr).join('\n'),error:undefined,timedOut:false,records,reports};
  } catch (error) {
    return unavailable(error.message);
  } finally {
    for(const path of scratch){const archived=archiveOwnedPath(path);for(const record of records)if(record.execution_report?.path.startsWith(path+sep))record.execution_report.path=join(archived,relative(path,record.execution_report.path));}
  }
}

// Interpret the runner's actual test summary; loader errors and zero tests never prove RED.
export function testExecutionOutcome(value) {
  if (!value || value.error || value.status === null) return 'ungraded';
  const records = value.records?.filter(r=>r.runner!=='deno-coverage') ?? [{runner:'node',...value}];
  if (!records.length) return 'ungraded';
  let failed = false;
  for (const record of records) {
    if (record.error || record.error_message || record.status === null || record.timedOut) return 'ungraded';
    const output = `${record.stdout ?? ''}\n${record.stderr ?? ''}`;
    if (/ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND|SyntaxError:|Could not find|no tests found|run\(\) recursively|skipping test files/i.test(output)) return 'ungraded';
    let tests=0, failures=0;
    if (record.runner==='vitest') {
      const summary=output.match(/(?:^|\n)\s*Tests\s+([^\n]+)/)?.[1] ?? '';
      for (const match of summary.matchAll(/(\d+)\s+(passed|failed)\b/g)) {
        tests+=Number(match[1]);if(match[2]==='failed') failures+=Number(match[1]);
      }
    } else if (record.runner==='deno') {
      const summary=output.match(/(\d+) passed\s*\|\s*(\d+) failed/);
      if(summary){tests=Number(summary[1])+Number(summary[2]);failures=Number(summary[2]);}
    } else {
      tests=Number(output.match(/(?:^|\n)(?:#|ℹ) tests (\d+)/m)?.[1] ?? 0);
      failures=Number(output.match(/(?:^|\n)(?:#|ℹ) fail (\d+)/m)?.[1] ?? 0);
    }
    if(tests<1 || (record.status!==0 && failures===0) || (record.status===0 && failures>0))return 'ungraded';
    if(record.status!==0)failed=true;
  }
  return failed?'fail':value.status===0?'pass':'ungraded';
}
