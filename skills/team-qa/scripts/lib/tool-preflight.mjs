import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fail, readJson, sha256, sha256File, runAdapter, visibleCodexAssistantText } from './core.mjs';
import { readContract } from './release-truth.mjs';
import { isDeployedTarget, assertDeployedIdentityProof, deployedTargetShapeErrors, WEB_CONTRACT_SHA256 } from './deployed-target.mjs';
import { verifyNativeHost } from './native-host.mjs';
import { claudeToolPair, isClaudeTranscriptPath, orchestratorSessionId, verifyClaudeHost, visibleAssistantText } from './host-transcript.mjs';
import { verifyProviderInterface } from './roster.mjs';
import { scanOriginalSource } from './original-source.mjs';
import { dragonRuntimeDir, dragonStatusCommand, dragonStatusUrl, isDragonStatusCommand } from './dragon-endpoint.mjs';
import { dragonStatusVerdict } from './dragon-requirements.mjs';
import { loadOwnerGrant } from './owner-grant.mjs';
import { siblingSkillRoot } from './install-layout.mjs';

const must = (v, code, detail = '') => { if (!v) fail(3, `PREFLIGHT_${code}`, detail, 'ungraded'); };
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
function exact(v, keys, label) {
  must(v && typeof v === 'object' && !Array.isArray(v), 'FIELDS', label);
  must(Object.keys(v).every(k => keys.includes(k)), 'FIELDS', label);
}
function json(text) { try { return JSON.parse(text); } catch { fail(3, 'PREFLIGHT_RAW_INVALID', '', 'ungraded'); } }
// JSON literals with JavaScript's unquoted object keys; no evaluation or expressions.
function literal(text) {
  let out = '', index = 0;
  const stack = [];
  while (index < text.length) {
    const char = text[index], top = stack.at(-1);
    if (char === '"') {
      const start = index++;
      while (index < text.length) {
        if (text[index] === '\\') { index += 2; continue; }
        if (text[index++] === '"') break;
      }
      out += text.slice(start, index); if (top?.key) top.key = false; continue;
    }
    if (top?.key && /[A-Za-z_$]/.test(char)) {
      const match = /^[A-Za-z_$][\w$]*/.exec(text.slice(index));
      must(/^\s*:/.test(text.slice(index + match[0].length)), 'ADAPTER_UNSUPPORTED');
      out += JSON.stringify(match[0]); index += match[0].length; top.key = false; continue;
    }
    if (char === '{' || char === '[') stack.push({ kind: char, key: char === '{' });
    else if (char === '}' || char === ']') stack.pop();
    else if (char === ',' && top?.kind === '{') top.key = true;
    out += char; index++;
  }
  return json(out);
}

function passiveExecPragma(raw) {
  if(typeof raw!=='string'||!raw.startsWith('// @exec: '))return {body:raw,pragma:false};
  const m=/^\/\/ @exec: \{[ \t]*"max_output_tokens"[ \t]*:[ \t]*([1-9][0-9]*)[ \t]*\}[ \t]*\r?\n([^]*)$/.exec(raw);
  must(m&&Number(m[1])<=1048576,'ADAPTER_UNSUPPORTED');
  return {body:m[2],pragma:true};
}

function decode(value) {
  for (let i = 0; i < 8; i++) {
    if (typeof value === 'string') { value = json(value); continue; }
    if (Array.isArray(value)) {
      must(value.length === 2 && value.every(x => x?.type === 'input_text' && typeof x.text === 'string'), 'EXEC_OUTPUT_SHAPE');
      must(/^Script completed\nWall time \d+(?:\.\d+)? seconds\nOutput:\n$/.test(value[0].text), 'EXEC_NOT_COMPLETED');
      value = value[1].text; continue;
    }
    must(value?.truncated!==true&&value?.isTruncated!==true,'EXEC_OUTPUT_TRUNCATED');
    if (Array.isArray(value?.content)) {
      must(value.isError !== true, 'TOOL_ERROR');
      if (value.content.length === 0) {
        const structured = value.structuredContent;
        must(structured && typeof structured === 'object' && !Array.isArray(structured), 'ADAPTER_UNSUPPORTED');
        must(structured.isError !== true && !structured.error, 'TOOL_ERROR');
        must(structured.truncated !== true && structured.isTruncated !== true, 'EXEC_OUTPUT_TRUNCATED');
        // Keep the full MCP envelope: board snapshots must match the original result.
        return value;
      }
      const text = value.content.filter(x => x.type === 'text');
      must(text.length === 1, 'ADAPTER_UNSUPPORTED'); value = text[0].text; continue;
    }
    return value;
  }
  fail(3, 'PREFLIGHT_ADAPTER_UNSUPPORTED', '', 'ungraded');
}
function file(ref, base) {
  exact(ref, ['path', 'sha256'], 'file');
  must(typeof ref.path === 'string' && /^[a-f0-9]{64}$/.test(ref.sha256 || ''), 'SOURCE_METADATA');
  let path;
  try { path = realpathSync(resolve(base, ref.path)); must(statSync(path).size <= 256 * 1024 * 1024, 'SOURCE_SIZE'); }
  catch (e) { if (e.code?.startsWith('PREFLIGHT_')) throw e; fail(3, 'PREFLIGHT_SOURCE_MISSING', '', 'ungraded'); }
  must(sha256File(path) === ref.sha256, 'SOURCE_DRIFT');
  return path;
}
function media(ref, base, kind) {
  const path = file(ref, base), bytes = readFileSync(path);
  if (kind === 'image') must(bytes.length > 24 && (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) || bytes[0] === 255 && bytes[1] === 216 && bytes.at(-2) === 255 && bytes.at(-1) === 217), 'IMAGE_FORMAT');
  else must(bytes.length > 32 && bytes.subarray(4, 8).toString() === 'ftyp', 'VIDEO_FORMAT');
}

// Only original host records count. Copies inside a run cannot attest their own origin.
function pair(ref, { runDir, fixture, binding, requireFresh }) {
  exact(ref, ['path', 'call_sha256', 'result_sha256', 'call_line', 'result_line', 'host', 'helper', 'request', 'native'], 'host-source');
  let path;
  try { path = realpathSync(resolve(runDir, ref.path)); }
  catch (e) { if (e.code?.startsWith('PREFLIGHT_')) throw e; fail(3, 'PREFLIGHT_SOURCE_MISSING', '', 'ungraded'); }
  let claudeHost = false;
  if (!fixture) {
    if (isClaudeTranscriptPath(path)) {
      claudeHost = true;
      try { verifyClaudeHost(ref.host); } catch { fail(3, 'PREFLIGHT_HOST_DRIFT', '', 'ungraded'); }
      // After roster approval, Claude evidence must come from the approving root session.
      const root = orchestratorSessionId(resolve(runDir));
      if (existsSync(join(resolve(runDir), 'control', 'approvals', 'roster.json'))) must(root && ref.host.session_id === root, 'HOST_NOT_ORCHESTRATOR');
    } else {
      let sessions;
      try { sessions = realpathSync(join(homedir(), '.codex/sessions')); }
      catch { fail(3, 'PREFLIGHT_SOURCE_UNTRUSTED', 'Codex session storage is unavailable', 'ungraded'); }
      must(path.startsWith(sessions + sep), 'SOURCE_UNTRUSTED');
      try { verifyNativeHost(ref.host); } catch { fail(3, 'PREFLIGHT_HOST_DRIFT', '', 'ungraded'); }
    }
    must(realpathSync(ref.host.path) === path, 'HOST_BINDING');
  }
  must(Number.isInteger(ref.call_line) && ref.call_line > 0 && Number.isInteger(ref.result_line) && ref.result_line > ref.call_line, 'SOURCE_LINES');
  let callRaw='',resultRaw='',bound=false;
  scanOriginalSource(path,(raw,index)=>{
    if(index===ref.call_line-1)callRaw=raw;
    if(index===ref.result_line-1)resultRaw=raw;
    if(index<ref.call_line-1&&!bound){
      try{const e=JSON.parse(raw);if((claudeHost||fixture?visibleAssistantText(e):visibleCodexAssistantText(e))?.includes(binding))bound=true;}
      catch{fail(3,'PREFLIGHT_RAW_INVALID','','ungraded');}
    }
  });
  must(sha256(callRaw) === ref.call_sha256 && sha256(resultRaw) === ref.result_sha256, 'SOURCE_DRIFT');
  must(bound, 'CALL_BINDING');
  let callEvent,resultEvent;
  try{callEvent=JSON.parse(callRaw);resultEvent=JSON.parse(resultRaw);}
  catch{fail(3,'PREFLIGHT_RAW_INVALID','','ungraded');}
  if (requireFresh) {
    const callTime = Date.parse(callEvent.timestamp), resultTime = Date.parse(resultEvent.timestamp);
    must(Number.isFinite(callTime) && Number.isFinite(resultTime) && resultTime >= callTime, 'TIMESTAMP_METADATA');
    const age = Date.now() - resultTime, maximum = readJson(join(ROOT, 'references/roster-policy.json')).preflight_max_age_ms;
    must(Number.isFinite(maximum) && maximum > 0, 'FRESHNESS_POLICY');
    must(age >= -60000 && age <= maximum, 'STALE');
  }
  if (claudeHost || fixture && callEvent?.type === 'assistant') {
    const normalized = claudeToolPair(callEvent, resultEvent);
    must(!normalized.error, normalized.error || 'CALL_RESULT');
    return { name: normalized.name, input: normalized.input, output: normalized.name === 'exec_command' ? normalized.output : decode(normalized.output),
      call_timestamp: normalized.call_timestamp, output_timestamp: normalized.output_timestamp };
  }
  const call = callEvent?.payload, result = resultEvent?.payload;
  must(['function_call', 'custom_tool_call'].includes(call?.type) && ['function_call_output', 'custom_tool_call_output'].includes(result?.type) && call.call_id && call.call_id === result.call_id, 'CALL_RESULT');
  // A single literal MCP call wrapper is supported; arbitrary JavaScript is not.
  let name = call.name, input;
  if (name === 'functions.exec' || name === 'exec') {
    const {body:raw,pragma}=passiveExecPragma(call.arguments || call.input);
    const match = /^\s*(?:const|let)\s+(\w+)\s*=\s*await\s+tools\.((?:mcp__\w+__\w+|exec_command))\((\{[^]*\})\);\s*text\(\1\);?\s*$/.exec(raw);
    const direct = /^\s*text\(await\s+tools\.((?:mcp__\w+__\w+|exec_command))\((\{[^]*\})\)\);?\s*$/.exec(raw);
    must(match || direct, 'ADAPTER_UNSUPPORTED'); name = match ? match[2] : direct[1]; input = literal(match ? match[3] : direct[2]);
    if(pragma){must((!call.namespace||call.namespace==='functions')&&!match&&/^text\(await tools\.[A-Za-z0-9_]+\(\{[^]*\}\)\);\s*$/.test(raw),'ADAPTER_UNSUPPORTED');input=json(direct[2]);must(/^mcp__.*dragon.*__dragon_rpc$/i.test(name)&&['getPageHtml','getPageIdentity','getNetwork','getTabInfo'].includes(input.method),'ADAPTER_UNSUPPORTED');}
  } else input = json(call.arguments);
  return { name, input, output: decode(result.output), call_timestamp: callEvent.timestamp, output_timestamp: resultEvent.timestamp };
}
export function readHostToolEvidence(ref, { roster, runDir = process.cwd(), requireFresh = false }) {
  return pair(ref, { runDir, requireFresh, fixture: roster.catalog_source?.kind === 'fixture', binding: `TEAMQA_PREFLIGHT run=${roster.run_id} round=${roster.round} roster=${roster.roster_hash}` });
}

// The status helper is the installed release's own tools/macos-service.mjs (public v1, T1). Its hash is bound into
// the native status code for this call only; no Dragon release's hash is pinned, so a Store update keeps working.
const SHA256 = /^[a-f0-9]{64}$/;
export function nativeServiceStatusCode({ service, node_path } = {}) {
  if (!service || Object.keys(service).some(k => !['path','sha256'].includes(k)) || typeof service.path !== 'string' || !service.path.startsWith('/') || !service.path.endsWith('/tools/macos-service.mjs') || !SHA256.test(service.sha256 || '') || typeof node_path !== 'string' || !node_path.startsWith('/') || /[\0\n\r]/.test(node_path)) return null;
  const args=[service.path,'status'];
  return 'var nativeFs=await import("node:fs/promises");var nativeCrypto=await import("node:crypto");if(nativeCrypto.createHash("sha256").update(await nativeFs.readFile('+JSON.stringify(service.path)+')).digest("hex")!=='+JSON.stringify(service.sha256)+')throw new Error("NATIVE_SERVICE_HELPER_DRIFT");var nativeChild=await import("node:child_process");var nativeResult=await new Promise((resolve,reject)=>{var child=nativeChild.spawn('+JSON.stringify(node_path)+','+JSON.stringify(args)+',{stdio:["ignore","pipe","pipe"]});var stdout="",stderr="",exceeded=false;var timer=setTimeout(()=>{exceeded=true;child.kill("SIGTERM");},9000);child.stdout.on("data",b=>{stdout+=b;if(stdout.length>1048576){exceeded=true;child.kill("SIGTERM");}});child.stderr.on("data",b=>{stderr+=b;if(stderr.length>65536){exceeded=true;child.kill("SIGTERM");}});child.on("error",e=>{clearTimeout(timer);reject(e);});child.on("close",(exit_code,signal)=>{clearTimeout(timer);resolve({schema:"team-qa/native-service-status-result/v1",exit_code,signal,exceeded,output:stdout,stderr});});});nodeRepl.write(JSON.stringify(nativeResult));';
}
function serviceStatus(ref, context) {
  const p=pair(ref,context);
  let version;
  if (p.name === 'mcp__node_repl__js') {
    must(ref.helper===undefined && ref.request===undefined,'DRAGON_STATUS_METADATA');
    exact(ref.native,['node_path','service'],'native-status');
    exact(ref.native.service,['path','sha256'],'native-status-service');
    const service=ref.native.service;
    must(sha256File(service.path)===service.sha256,'DRAGON_SERVICE_PIN');
    if (!context.fixture) {
      must(realpathSync(service.path)===realpathSync(join(homedir(),'.dragon-browser/runtime/current/tools/macos-service.mjs')),'DRAGON_SERVICE_PIN');
      must(realpathSync(ref.native.node_path)===realpathSync(process.execPath),'DRAGON_STATUS_NODE');
    }
    exact(p.input,['code','title','timeout_ms'],'native-status-input');
    must(p.input.code===nativeServiceStatusCode(ref.native),'DRAGON_STATUS_CALL');
    must(p.output?.schema==='team-qa/native-service-status-result/v1' && p.output.exit_code===0 && !p.output.signal && !p.output.exceeded && !p.output.stderr && typeof p.output.output==='string','DRAGON_STATUS');
    version=json(p.output.output);
  } else {
    must(ref.native===undefined && ref.helper===undefined && ref.request===undefined,'DRAGON_STATUS_METADATA');
    must(['exec_command','functions.exec_command'].includes(p.name) && isDragonStatusCommand(p.input.cmd),'DRAGON_STATUS_CALL',`expected ${dragonStatusCommand()}`);
    must(p.output.exit_code===0,'DRAGON_STATUS');
    version=decode(p.output.output);
  }
  const bridge=p.name==='mcp__node_repl__js'?version?.status:version;
  if (p.name==='mcp__node_repl__js') must(version?.loaded===true && version.loadedFromPlist===true && Number.isInteger(version.pid) && version.pid>0 && typeof version.current==='string' && version.current && !version.error,'DRAGON_SERVICE_NOT_LOADED');
  must(bridge?.ok===true && typeof bridge.bridgeVersion==='string' && bridge.bridgeVersion && (p.name!=='mcp__node_repl__js' || typeof bridge.bridgeBuild==='string' && bridge.bridgeBuild),'DRAGON_VERSION');
  // An unpacked or other Dragon extension passes only on the owner's machine with a grant for it (public v1, O1).
  const verdict=dragonStatusVerdict(bridge,undefined,{ownerGrant:loadOwnerGrant({runId:/\brun=(\S+)/.exec(context.binding||'')?.[1]??null})});
  must(verdict.ok,verdict.code,`${verdict.detail} (fix: ${verdict.action}; run teamqa doctor)`);
  if (!context.fixture) must(readJson(join(dragonRuntimeDir(),'package.json')).version===bridge.bridgeVersion,'DRAGON_VERSION_DRIFT');
  return { version:bridge, service:version, native:p.name==='mcp__node_repl__js', source:p, platform:verdict.platform, grant_id:verdict.grant_id };
}
export function readNativeServiceStatusEvidence(ref,{roster,runDir=process.cwd(),requireFresh=false}) {
  const context={runDir,requireFresh,fixture:roster.catalog_source?.kind==='fixture',binding:`TEAMQA_PREFLIGHT run=${roster.run_id} round=${roster.round} roster=${roster.roster_hash}`};
  const status=serviceStatus(ref,context);
  must(status.native,'DRAGON_NATIVE_STATUS_REQUIRED');
  return status;
}

function dragon(ref, context, method, session, tabId) {
  const p = pair(ref, context);
  let request=p.input, raw=p.output;
  if (p.name==='mcp__node_repl__js') {
    exact(ref.native,['node_path'],'dragon-native');
    exact(ref.helper,['path','sha256'],'dragon-helper');
    exact(ref.request,['method','params','timeout'],'dragon-helper-request');
    const root=context.fixture?realpathSync(process.env.TEAMQA_PREFLIGHT_TEST_QA_GUI_ROOT||siblingSkillRoot('qa-gui')):(context.guiRoot||verifyProviderInterface({skill:'qa-gui'}).root);
    const helper=realpathSync(join(root,'scripts/qa_do.mjs'));
    must(ref.helper.path===helper&&sha256File(helper)===ref.helper.sha256,'DRAGON_HELPER_PIN');
    const code='const m=await import(process.argv[1]);let raw="";for await(const chunk of process.stdin)raw+=chunk;process.stdout.write(JSON.stringify(m.nativeGuiNodeHelperCode(JSON.parse(raw))));';
    const recipe=spawnSync(process.execPath,['--input-type=module','-e',code,join(root,'scripts/lib/native-gui-trajectory.mjs')],{input:JSON.stringify({helper:ref.helper,request:ref.request,node_path:ref.native.node_path}),encoding:'utf8',timeout:6000,maxBuffer:1048576});
    must(recipe.status===0&&typeof p.input.code==='string'&&p.input.code===json(recipe.stdout),'DRAGON_NATIVE_CODE');
    exact(p.input,['code','title','timeout_ms'],'dragon-native-input');
    must(p.output?.schema==='qa-gui/native-helper-result/v1'&&p.output.exit_code===0&&!p.output.signal&&!p.output.exceeded&&!p.output.stderr&&typeof p.output.output==='string','DRAGON_HELPER_EXECUTION');
    request=ref.request;raw=json(p.output.output);
  } else if (['exec_command','functions.exec_command'].includes(p.name)) {
    exact(ref.helper,['path','sha256'],'dragon-helper');
    exact(ref.request,['method','params','timeout'],'dragon-helper-request');
    const root=context.fixture ? realpathSync(process.env.TEAMQA_PREFLIGHT_TEST_QA_GUI_ROOT || siblingSkillRoot('qa-gui')) : (context.guiRoot || verifyProviderInterface({skill:'qa-gui'}).root);
    const helper=realpathSync(join(root,'scripts/qa_do.mjs'));
    must(ref.helper.path===helper && sha256File(helper)===ref.helper.sha256,'DRAGON_HELPER_PIN');
    const code='const m=await import(process.argv[1]);let raw="";for await(const chunk of process.stdin)raw+=chunk;process.stdout.write(JSON.stringify(m.nativeGuiHelperCommand(JSON.parse(raw))));';
    const recipe=spawnSync(process.execPath,['--input-type=module','-e',code,join(root,'scripts/lib/native-gui-trajectory.mjs')],{input:JSON.stringify({helper:ref.helper,request:ref.request}),encoding:'utf8',timeout:6000,maxBuffer:1024*1024});
    must(recipe.status===0,'DRAGON_HELPER_INTERFACE');
    const command=json(recipe.stdout);
    must(typeof command==='string' && p.input.cmd===command && p.input.login===false,'DRAGON_HELPER_COMMAND');
    must(p.output?.exit_code===0 && !p.output.session_id && typeof p.output.output==='string','DRAGON_HELPER_EXECUTION');
    request=ref.request;raw=json(p.output.output);
  } else {
    must(/^mcp__.*dragon.*__dragon_rpc$/i.test(p.name),'DRAGON_TOOL');
    must(ref.helper===undefined && ref.request===undefined && ref.native===undefined,'DRAGON_HELPER_UNEXPECTED');
  }
  must((Array.isArray(method) ? method.includes(request.method) : request.method === method) && request.params && typeof request.params === 'object', 'DRAGON_REQUEST');
  const params = request.params;
  if (session) must(['sessionId', 'nonce', 'browserInstanceId'].every(k => params[k] === session[k]), 'GUI_SESSION_DRIFT');
  if (tabId != null && request.method !== 'stopRecording' && request.method !== 'assembleRecording') must(params.tabId === tabId, 'GUI_TAB_DRIFT');
  return { result: dragonResult(request.method, raw), params, source: p, method: request.method };
}
// The usable result of one Dragon RPC answer {ok, result}: the HTML of a getPageHtml (plain or in its evidence envelope),
// otherwise the result object, which must not report a failure.
export function dragonResult(method, raw) {
  let r = raw?.result;
  if(method==='getPageHtml'&&r&&typeof r==='object') {
    exact(r,['value','evidence','telemetry'],'html-envelope');
    const e=r.evidence,t=r.telemetry;
    exact(e,['v','kind','ts','correlationId','contentHash','ref'],'html-evidence');
    exact(t,['durMs','bytesOut','terminalReason','retryable','evidenceRef'],'html-telemetry');
    must(typeof r.value==='string'&&r.value.length>0&&e.v===1&&e.kind==='dom'&&Number.isFinite(e.ts)&&(e.correlationId===null||typeof e.correlationId==='string')&&e.contentHash==='sha256:'+sha256(JSON.stringify(['string',r.value]))&&e.ref==='observation:'+e.contentHash.slice(7)&&t.evidenceRef===e.ref&&Number.isFinite(t.durMs)&&t.durMs>=0&&Number.isInteger(t.bytesOut)&&t.bytesOut>=Buffer.byteLength(r.value,'utf8')&&t.terminalReason==='complete'&&t.retryable===false,'DRAGON_HTML_ENVELOPE');
    r=r.value;
  }
  must(raw?.ok === true && !raw.error && (method==='getPageHtml'?typeof r==='string'&&r.length>0:r&&typeof r==='object'&&r.ok!==false&&r.completed!==false&&!r.human_needed&&!r.error&&!(r.results||[]).some(x=>x?.ok===false)), 'DRAGON_OPERATION');
  return r;
}
export function readDragonToolEvidence(ref,{roster,runDir=process.cwd(),requireFresh=false},method) {
  return dragon(ref,{runDir,requireFresh,fixture:roster.catalog_source?.kind==='fixture',binding:`TEAMQA_PREFLIGHT run=${roster.run_id} round=${roster.round} roster=${roster.roster_hash}`},method);
}
export const DEPLOYED_IDENTITY_READ='return {preview_url:location.href,frontend_build:{kind:"nextjs",id:JSON.parse(document.getElementById("__NEXT_DATA__")?.textContent||"{}").buildId||null},asset_manifest:window.__BUILD_MANIFEST||null,resource_urls:performance.getEntriesByType("resource").map(r=>r.name)};';
export function deployedIdentityBootstrapMarker({run_id,round,target}) {
  const errors=deployedTargetShapeErrors(target).filter(e=>e!=='TARGET target.identity_proof');
  must(/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(run_id||'')&&Number.isInteger(round)&&round>0&&errors.length===0,'WEB_IDENTITY_TARGET');
  return 'TEAMQA_IDENTITY_PREFLIGHT run='+run_id+' round='+round+' target='+target.target_binding_sha256;
}
function htmlAttribute(attrs,name) {
  const values=[];
  const pattern=/([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>]+))/g;
  for(const m of attrs.matchAll(pattern))if(m[1].toLowerCase()===name)values.push(m[2]??m[3]??m[4]);
  must(values.length<=1,'WEB_PASSIVE_HTML');
  return values[0];
}
function decodeHtmlAttribute(value) {
  return value.replace(/&(?:amp|quot|apos|lt|gt|#\d+|#x[0-9a-f]+);/gi,e=>{
    const named={'&amp;':'&','&quot;':'"','&apos;':"'",'&lt;':'<','&gt;':'>'};
    if(named[e.toLowerCase()])return named[e.toLowerCase()];
    const n=e.slice(2,-1);const cp=n[0].toLowerCase()==='x'?parseInt(n.slice(1),16):parseInt(n,10);
    must(cp>0&&cp<=0x10ffff,'WEB_PASSIVE_HTML');return String.fromCodePoint(cp);
  });
}
// The verifier's two scans of a page's HTML (upgrade U1): every <script …>…</script> block (its raw attributes; for one
// whose attributes name __NEXT_DATA__, whether its body is JSON and the buildId it carries) and every <script …> /
// <link …> start tag, in document order. Dragon's getPageIdentity returns these two lists computed by the same
// expressions (apps/dragon-browser/qa-identity.cjs), so the identity derived from them is the one the whole HTML gives.
const NEXT_DATA='__NEXT_DATA__';
function nextDataOf(body){try{const data=JSON.parse(body);return {json:true,build_id:data&&typeof data.buildId==='string'?data.buildId:null};}catch{return {json:false,build_id:null};}}
export function passiveHtmlParts(html) {
  return {
    scripts:[...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)].map(m=>m[1].includes(NEXT_DATA)?{attrs:m[1],next_data:nextDataOf(m[2])}:{attrs:m[1]}),
    tags:[...html.matchAll(/<(script|link)\b([^>]*)>/gi)].map(m=>({tag:m[1].toLowerCase(),attrs:m[2]})),
  };
}
// Vite single-page builds (eval compat 3): index.html loads exactly one same-origin hashed module entry under /assets/.
// The entry chunk name (e.g. index-CJjkO35e) is the build id, like Next.js buildId; the manifest is the entry URL alone,
// because the live DOM gains modulepreload/stylesheet links for lazy chunks as the user navigates.
const VITE_ENTRY=/^\/assets\/([A-Za-z0-9_-]+-[A-Za-z0-9_-]{8})\.js$/;
function viteEntries(tags,url) {
  const entries=[];
  for(const t of tags) {
    if(t.tag!=='script'||String(htmlAttribute(t.attrs,'type')??'').toLowerCase()!=='module')continue;
    const raw=htmlAttribute(t.attrs,'src');if(!raw)continue;
    let asset;try{asset=new URL(decodeHtmlAttribute(raw),url);}catch{must(false,'WEB_PASSIVE_HTML');}
    if(asset.origin!==url.origin||!VITE_ENTRY.test(asset.pathname))continue;
    must(!asset.username&&!asset.password&&!asset.search,'WEB_PASSIVE_HTML');asset.hash='';entries.push(asset);
  }
  return entries;
}
function passiveViteIdentity(url,entries) {
  must(entries.length===1,'WEB_PASSIVE_VITE_ENTRY');
  const id=VITE_ENTRY.exec(entries[0].pathname)[1];
  const manifest={kind:'vite-html-assets/v1',entry:entries[0].href};
  return {preview_url:url.href,frontend_build:{kind:'vite',id},asset_manifest_sha256:sha256(JSON.stringify(manifest))};
}
function passiveUrl(preview_url) {
  let url;try{url=new URL(preview_url);}catch{must(false,'WEB_PASSIVE_URL');}
  must(['http:','https:'].includes(url.protocol),'WEB_PASSIVE_URL');
  return url;
}
function passiveIdentityFromParts({scripts,tags},url) {
  const next=scripts.filter(s=>htmlAttribute(s.attrs,'id')===NEXT_DATA);
  if(next.length===0){const entries=viteEntries(tags,url);if(entries.length)return passiveViteIdentity(url,entries);}
  must(next.length===1,'WEB_PASSIVE_NEXT_DATA');
  must(next[0].next_data?.json===true,'WEB_PASSIVE_NEXT_DATA');
  const buildId=next[0].next_data.build_id;
  must(typeof buildId==='string'&&/^[A-Za-z0-9_-]+$/.test(buildId),'WEB_PASSIVE_BUILD');
  const urls=new Set();
  for(const t of tags) {
    const raw=htmlAttribute(t.attrs,t.tag==='script'?'src':'href');if(!raw)continue;
    let asset;try{asset=new URL(decodeHtmlAttribute(raw),url);}catch{must(false,'WEB_PASSIVE_HTML');}
    if(asset.origin===url.origin&&asset.pathname.startsWith('/_next/static/')) {
      must(!asset.username&&!asset.password,'WEB_PASSIVE_HTML');asset.hash='';urls.add(asset.href);
    }
  }
  const resources=[...urls].sort();
  must(resources.length>0&&resources.some(u=>new URL(u).pathname.startsWith('/_next/static/'+buildId+'/')),'WEB_PASSIVE_ASSETS');
  const manifest={kind:'nextjs-html-assets/v1',build_id:buildId,urls:resources};
  return {preview_url:url.href,frontend_build:{kind:'nextjs',id:buildId},asset_manifest_sha256:sha256(JSON.stringify(manifest))};
}
export function parsePassiveDeployedHtml(html,{preview_url,maxLength=1048576}={}) {
  must(typeof html==='string'&&Number.isInteger(maxLength)&&maxLength>0&&maxLength<=1048576&&html.length<=maxLength&&Buffer.byteLength(html,'utf8')<=1048576&&/^<html\b/i.test(html.trim())&&/<\/html>\s*$/i.test(html)&&!html.includes('<!-- truncated -->'),'WEB_PASSIVE_HTML');
  return passiveIdentityFromParts(passiveHtmlParts(html),passiveUrl(preview_url));
}
// A getPageIdentity result: the read was whole (from <html to </html>, uncut, at most 1 MiB as characters and as UTF-8
// bytes, no part left out), and its parts give the identity exactly as the whole HTML would.
const PAGE_IDENTITY_KEYS=['v','html_sha256','html_length','html_bytes','complete','truncated','scripts','tags','omitted','evidence','telemetry'];
export function parsePassiveIdentityRead(r,{preview_url}={}) {
  exact(r,PAGE_IDENTITY_KEYS,'page-identity');
  const part=x=>x&&typeof x==='object'&&!Array.isArray(x);
  must(r.v===1&&/^[a-f0-9]{64}$/.test(String(r.html_sha256))&&Number.isInteger(r.html_length)&&Number.isInteger(r.html_bytes)&&typeof r.complete==='boolean'&&typeof r.truncated==='boolean'&&Number.isInteger(r.omitted)&&Array.isArray(r.scripts)&&Array.isArray(r.tags)
    &&r.scripts.every(x=>part(x)&&typeof x.attrs==='string'&&Object.keys(x).every(k=>['attrs','next_data'].includes(k))&&(x.next_data!==undefined)===x.attrs.includes(NEXT_DATA)&&(x.next_data===undefined||part(x.next_data)&&Object.keys(x.next_data).length===2&&typeof x.next_data.json==='boolean'&&(x.next_data.build_id===null||typeof x.next_data.build_id==='string')))
    &&r.tags.every(x=>part(x)&&Object.keys(x).length===2&&['script','link'].includes(x.tag)&&typeof x.attrs==='string')
    &&part(r.evidence)&&r.evidence.kind==='dom'&&/^sha256:[a-f0-9]{64}$/.test(String(r.evidence.contentHash)),'DRAGON_IDENTITY_SHAPE');
  must(r.complete===true&&r.truncated===false&&r.omitted===0&&r.html_length>0&&r.html_length<=1048576&&r.html_bytes<=1048576,'WEB_PASSIVE_HTML');
  return passiveIdentityFromParts({scripts:r.scripts,tags:r.tags},passiveUrl(preview_url));
}
// The identity of a passive page read, whichever of the two reads it is.
export const PASSIVE_PAGE_METHODS=['getPageHtml','getPageIdentity'];
const PASSIVE_PAGE_PARAMS={getPageHtml:['sessionId','nonce','browserInstanceId','tabId','maxLength'],getPageIdentity:['sessionId','nonce','browserInstanceId','tabId']};
export function passivePageObservation(page,preview_url) {
  must(PASSIVE_PAGE_METHODS.includes(page.method),'DRAGON_REQUEST');
  return page.method==='getPageIdentity'?parsePassiveIdentityRead(page.result,{preview_url}):parsePassiveDeployedHtml(page.result,{preview_url,maxLength:page.params.maxLength??1048576});
}
// Whether a getNetwork answer holds a 2xx/3xx request to `backend` made in [from, to]: from the request list, or from
// a {summary:true} answer, whose latest ok time for that origin must fall in the window (a summary is computed before
// the call returns, so every ok request it counts was made no later than `to`).
const NETWORK_SUMMARY_KEYS=['summary','count','cursor','truncated','omitted','origins','evidence','telemetry'];
function backendObserved(r,{summary,backend,from,to}) {
  if(summary) {
    exact(r,NETWORK_SUMMARY_KEYS,'network-summary');
    const row=o=>o&&typeof o==='object'&&Object.keys(o).length===5&&typeof o.origin==='string'&&['ok','failed','other'].every(k=>Number.isInteger(o[k])&&o[k]>=0)&&(o.ok>0?Number.isFinite(o.last_ok_t):o.last_ok_t===null);
    must(r.summary===true&&Array.isArray(r.origins)&&r.origins.every(row)&&new Set(r.origins.map(o=>o.origin)).size===r.origins.length&&Number.isInteger(r.count)&&r.count===r.origins.reduce((n,o)=>n+o.ok+o.failed+o.other,0)&&r.truncated===false&&r.omitted===0&&Number.isFinite(r.cursor),'WEB_PASSIVE_NETWORK');
    const own=r.origins.find(o=>o.origin===backend);
    return Boolean(own&&own.ok>0&&own.last_ok_t>=from&&own.last_ok_t<=to);
  }
  must(Array.isArray(r.requests)&&Number.isInteger(r.count)&&r.count===r.requests.length&&r.truncated===false&&r.omitted===0&&Number.isFinite(r.cursor),'WEB_PASSIVE_NETWORK');
  return r.requests.some(v=>{try{return !v.failed&&!v.errorText&&Number.isFinite(v.t)&&v.t>=from&&v.t<=to&&Number.isInteger(v.status)&&v.status>=200&&v.status<400&&new URL(v.url).origin===backend;}catch{return false;}});
}
// The checks of a passive identity read on normalized Dragon calls {method, params, result, call_timestamp,
// output_timestamp}: page read → getNetwork → getTabInfo on one session triple and tab, the tab at the target's preview
// URL, all within the preflight window, the page's build and, with `network`, a 2xx/3xx request to the backend made in
// the window before the page read. `network` may be a function, read after the page (the readers' order of checks).
export function passiveIdentityChecks({page,tab,network},{target}) {
  const p=page.params;
  must(PASSIVE_PAGE_METHODS.includes(page.method),'DRAGON_REQUEST');
  exact(p,PASSIVE_PAGE_PARAMS[page.method],'passive-html-params');
  must(['sessionId','nonce','browserInstanceId'].every(k=>typeof p[k]==='string'&&p[k])&&Number.isInteger(p.tabId),'DRAGON_METADATA');
  const session=Object.fromEntries(['sessionId','nonce','browserInstanceId'].map(k=>[k,p[k]]));
  must(tab.method==='getTabInfo','DRAGON_REQUEST');
  must(['sessionId','nonce','browserInstanceId'].every(k=>tab.params?.[k]===session[k]),'GUI_SESSION_DRIFT');
  must(tab.params.tabId===p.tabId,'GUI_TAB_DRIFT');
  exact(tab.params,['sessionId','nonce','browserInstanceId','tabId'],'passive-tab-params');
  must(tab.result.tabId===p.tabId&&tab.result.url===target.preview_url,'WEB_PASSIVE_URL');
  const pageCall=Date.parse(page.call_timestamp),pageTime=Date.parse(page.output_timestamp),tabTime=Date.parse(tab.call_timestamp),tabOutput=Date.parse(tab.output_timestamp),maximum=readJson(join(ROOT,'references/roster-policy.json')).preflight_max_age_ms;
  must([pageCall,pageTime,tabTime,tabOutput,maximum].every(Number.isFinite)&&maximum>0&&pageTime>=pageCall&&tabTime>=pageTime&&tabOutput>=tabTime&&tabOutput-pageCall<=maximum,'WEB_PASSIVE_ORDER');
  const observation=passivePageObservation(page,tab.result.url);
  if(network) {
    const net=typeof network==='function'?network():network;
    must(net.method==='getNetwork','DRAGON_REQUEST');
    must(['sessionId','nonce','browserInstanceId'].every(k=>net.params?.[k]===session[k]),'GUI_SESSION_DRIFT');
    must(net.params.tabId===p.tabId,'GUI_TAB_DRIFT');
    exact(net.params,['sessionId','nonce','browserInstanceId','tabId','maxBytes','since','failedOnly','correlationId','summary'],'passive-network-params');
    must((net.params.maxBytes===undefined||Number.isInteger(net.params.maxBytes)&&net.params.maxBytes>0&&net.params.maxBytes<=200000)&&net.params.failedOnly!==true&&(net.params.since===undefined||Number.isFinite(net.params.since))&&(net.params.correlationId===undefined||typeof net.params.correlationId==='string')&&(net.params.summary===undefined||net.params.summary===true),'WEB_PASSIVE_NETWORK');
    const netTime=Date.parse(net.call_timestamp),netOutput=Date.parse(net.output_timestamp);
    must(Number.isFinite(netTime)&&Number.isFinite(netOutput)&&netTime>=pageTime&&netOutput>=netTime&&tabTime>=netOutput,'WEB_PASSIVE_ORDER');
    const backend=new URL(target.backend_origin).origin;
    must(backendObserved(net.result,{summary:net.params.summary===true,backend,from:pageTime-maximum,to:netOutput+1000}),'WEB_BACKEND_OBSERVATION');
    observation.backend_origin=backend;
  }
  return {observation,session,tabId:p.tabId};
}
const normalized=c=>({method:c.method,params:c.params,result:c.result,call_timestamp:c.source.call_timestamp,output_timestamp:c.source.output_timestamp});
function passivePage(ref,context,{network=false}={}) {
  const {tab_source,network_source,...source}=ref;
  must(tab_source&&(!network||network_source)&& (network||network_source===undefined),'WEB_PASSIVE_SOURCE_REQUIRED');
  const page=dragon(source,context,PASSIVE_PAGE_METHODS),p=page.params;
  exact(p,PASSIVE_PAGE_PARAMS[page.method],'passive-html-params');
  must(['sessionId','nonce','browserInstanceId'].every(k=>typeof p[k]==='string'&&p[k])&&Number.isInteger(p.tabId),'DRAGON_METADATA');
  const session=Object.fromEntries(['sessionId','nonce','browserInstanceId'].map(k=>[k,p[k]]));
  const tab=dragon(tab_source,context,'getTabInfo',session,p.tabId);
  const checked=passiveIdentityChecks({page:normalized(page),tab:normalized(tab),network:network?()=>normalized(dragon(network_source,context,'getNetwork',session,p.tabId)):null},{target:context.target});
  return {...checked,page};
}
export function readDeployedIdentityObservation(ref,{roster,runDir=process.cwd(),requireFresh=false}) {
  const context={runDir,requireFresh,fixture:roster.catalog_source?.kind==='fixture',target:roster.target,
    binding:deployedIdentityBootstrapMarker({run_id:roster.run_id,round:roster.round,target:roster.target})};
  if(ref.tab_source!==undefined||ref.network_source!==undefined) {
    const v=passivePage(ref,context,{network:true}).observation;
    must(v.frontend_build.id===roster.target.frontend_build.id,'WEB_PASSIVE_BUILD');
    return v;
  }
  const observed=dragon(ref,context,'do');
  must(Array.isArray(observed.params.steps)&&observed.params.steps.length===1&&observed.params.steps[0].read===DEPLOYED_IDENTITY_READ&&observed.params.steps[0].as==='deployed_identity'&&Object.keys(observed.params.steps[0]).every(k=>['read','as'].includes(k)),'WEB_IDENTITY_READ');
  const v=observed.result.reads?.deployed_identity;
  must(v&&v.preview_url===roster.target.preview_url&&v.frontend_build?.kind==='nextjs'&&typeof v.frontend_build.id==='string'&&v.frontend_build.id&&v.asset_manifest&&typeof v.asset_manifest==='object'&&!Array.isArray(v.asset_manifest)&&Object.keys(v.asset_manifest).length&&Array.isArray(v.resource_urls),'WEB_IDENTITY_CONTENT');
  const backend=new URL(roster.target.backend_origin).origin;
  must(v.resource_urls.some(u=>{try{return new URL(u).origin===backend;}catch{return false;}}),'WEB_BACKEND_OBSERVATION');
  const ordered=x=>Array.isArray(x)?x.map(ordered):x&&typeof x==='object'?Object.fromEntries(Object.keys(x).sort().map(k=>[k,ordered(x[k])])):x;
  return {preview_url:v.preview_url,frontend_build:v.frontend_build,asset_manifest_sha256:sha256(JSON.stringify(ordered(v.asset_manifest))),backend_origin:backend};
}
function currentDeployedIdentity(ref,{roster,runDir=process.cwd(),requireFresh=true}) {
  must(typeof requireFresh==='boolean','FRESHNESS_FLAG');
  must(ref?.tab_source&&ref?.network_source,'CURRENT_IDENTITY_PASSIVE_REQUIRED');
  const context={runDir,requireFresh,fixture:roster.catalog_source?.kind==='fixture',target:roster.target,
    binding:`TEAMQA_PREFLIGHT run=${roster.run_id} round=${roster.round} roster=${roster.roster_hash}`};
  const observed=passivePage(ref,context,{network:true});
  must(observed.observation.frontend_build.kind===roster.target.frontend_build.kind&&observed.observation.frontend_build.id===roster.target.frontend_build.id&&observed.observation.asset_manifest_sha256===roster.target.asset_manifest_sha256,'WEB_CURRENT_BUILD');
  return observed;
}
export function readCurrentDeployedIdentityObservation(ref,options) {
  return currentDeployedIdentity(ref,options).observation;
}
function guiAccess(gui, context) {
  exact(gui, ['status', 'session', 'open', 'read', 'screenshot', 'image', 'start', 'recording', 'assemble', 'video', 'fresh_status', 'fresh_session'], 'gui');
  // Creation provenance stays immutable; current observations below prove freshness.
  const provenance = { ...context, requireFresh: false };
  const initial = serviceStatus(gui.status, provenance);
  const version = initial.version;
  const created = dragon(gui.session, provenance, 'session.create');
  const session = created.result;
  const web=isDeployedTarget(context.target);
  must(session.sessionId===created.params.sessionId&&session.nonce&&session.browserInstanceId&&session.forbidSyntheticDOM===false&&created.params.forbidSyntheticDOM===false&&session.policy?.requireTrusted!==false&&created.params.policy?.requireTrusted!==false&&session.policy?.forbidSyntheticDOM!==true&&created.params.policy?.forbidSyntheticDOM!==true,'DRAGON_METADATA');
  const opened = dragon(gui.open, provenance, 'openTab', session);
  must(opened.params.url === context.target.preview_url && opened.params.active === false && Number.isInteger(opened.result.tabId), 'TARGET_ACCESS');
  const tabId = opened.result.tabId;
  if(web){
    const observed=passivePage(gui.read,context);
    must(observed.tabId===tabId&&['sessionId','nonce','browserInstanceId'].every(k=>observed.session[k]===session[k]),'GUI_SESSION_DRIFT');
    must(observed.observation.frontend_build.id===context.target.frontend_build.id&&observed.observation.asset_manifest_sha256===context.target.asset_manifest_sha256,'WEB_PASSIVE_BUILD');
  }else{
  const read = dragon(gui.read, context, 'do', session, tabId);
  must(Array.isArray(read.params.steps) && read.params.steps.some(s => typeof s.read === 'string' && s.as && Object.hasOwn(read.result.reads || {}, s.as)), 'GUI_CONTENT');
  must(Object.values(read.result.reads || {}).some(v => v && v.url === context.target.preview_url && typeof v.dom === 'string' && v.dom.trim().length > 20 && !v.__read_error), 'GUI_CONTENT');
  }
  // Freshness is a bounded dispatch snapshot, never a permanent readiness guarantee.
  if (context.requireFresh && initial.native) {
    must(gui.fresh_status && gui.fresh_session, 'DRAGON_FRESH_SOURCE_REQUIRED');
    must(gui.fresh_status.path !== gui.status.path || gui.fresh_status.call_line !== gui.status.call_line, 'DRAGON_FRESH_SOURCE_REQUIRED');
    const fresh=serviceStatus(gui.fresh_status,{...context,requireFresh:true});
    must(fresh.native && Date.parse(fresh.source.call_timestamp)>=Date.parse(initial.source.output_timestamp), 'DRAGON_FRESH_STATUS');
    must(fresh.service.pid===initial.service.pid && fresh.version.bridgeVersion===version.bridgeVersion && fresh.version.bridgeBuild===version.bridgeBuild, 'DRAGON_LIVE_DRIFT');
    const listed=dragon(gui.fresh_session,{...context,requireFresh:true},'session.list');
    must(Date.parse(listed.source.call_timestamp)>=Date.parse(fresh.source.output_timestamp), 'DRAGON_FRESH_SESSION');
    const active=listed.result.sessions?.find(s=>s.sessionId===session.sessionId);
    must(active?.alive===true && active.browserInstanceId===session.browserInstanceId && active.expired===false && active.circuitOpen===false, 'DRAGON_SESSION_STALE');
    must(active.forbidSyntheticDOM===false&&active.policy?.forbidSyntheticDOM!==true&&active.policy?.requireTrusted!==false,'DRAGON_POLICY_DRIFT');
  } else if (context.requireFresh && !context.fixture) {
    const live = runAdapter(['curl', '--fail', '--silent', '--max-time', '5', dragonStatusUrl()], { timeout: 6000 });
    must(live.status === 0, 'DRAGON_NOT_READY');
    const current = json(live.stdout);
    const live_verdict = dragonStatusVerdict(current, undefined, { ownerGrant: loadOwnerGrant({ runId: /\brun=(\S+)/.exec(context.binding || '')?.[1] ?? null }) });
    must(live_verdict.ok, live_verdict.code, live_verdict.detail);
    must(current.bridgeVersion === version.bridgeVersion && current.bridgeBuild === version.bridgeBuild && current.extension?.version === version.extension?.version, 'DRAGON_LIVE_DRIFT');
    const listed = runAdapter([process.execPath, join(context.guiRoot || verifyProviderInterface({skill:'qa-gui'}).root, 'scripts/qa_do.mjs'), '--method', 'session.list'], { timeout: 6000 });
    must(listed.status === 0, 'DRAGON_SESSION_UNAVAILABLE');
    const state = json(listed.stdout), active = state.result?.sessions?.find(s => s.sessionId === session.sessionId);
    must(state.ok === true && active?.alive === true && active.browserInstanceId === session.browserInstanceId && active.expired === false && active.circuitOpen === false, 'DRAGON_SESSION_STALE');
  }
  return { session, tabId };
}
function targetAccess(access, context) {
  exact(access, ['kind', 'repo_root', 'source_path', 'source_sha256', 'gui'], 'target-access');
  if (access.kind === 'dragon') {
    return guiAccess(access.gui, context);
  }
  must(access.kind === 'git' && typeof access.repo_root === 'string' && typeof access.source_path === 'string', 'TARGET_ACCESS');
  must(!access.source_path.startsWith('-') && !access.source_path.includes('..'), 'TARGET_ACCESS');
  const version = runAdapter(['git', '-C', access.repo_root, 'rev-parse', '--verify', `${context.target.version}^{commit}`]);
  const head = runAdapter(['git', '-C', access.repo_root, 'rev-parse', 'HEAD']);
  must(version.status === 0 && head.status === 0 && version.stdout.trim() === head.stdout.trim(), 'TARGET_VERSION');
  const read = runAdapter(['git', '-C', access.repo_root, 'show', `${head.stdout.trim()}:${access.source_path}`]);
  must(read.status === 0 && read.stdout.trim() && sha256(read.stdout) === access.source_sha256, 'TARGET_READ');
}
function verifyInstalled(skill, pin) {
  exact(pin, ['skill', 'source_sha256', 'manifest_sha256'], 'child-runtime');
  must(pin.skill === skill, 'CHILD_RUNTIME');
  const root = verifyProviderInterface({ skill }).root;
  must(sha256File(join(root, 'SOURCE.json')) === pin.source_sha256 && sha256File(join(root, 'package-manifest.json')) === pin.manifest_sha256, 'CHILD_RUNTIME_DRIFT');
  const check = runAdapter([process.execPath, join(root, 'scripts/package-tool.mjs'), 'verify-runtime', '--root', root], { timeout: 10000 });
  must(check.status === 0, 'CHILD_RUNTIME_PROVENANCE');
  return root;
}
function canonicalChildParse(root, receipt, tier) {
  const code = 'const m=await import(process.argv[1]+"/scripts/lib/release-receipt.mjs");const t=await import(process.argv[1]+"/scripts/lib/test-runners.mjs");let s="";for await(const c of process.stdin)s+=c;const r=JSON.parse(s);process.stdout.write(JSON.stringify({integrity:m.verifyObjectIntegrity(r),outcome:process.argv[2]==="runner"?t.testExecutionOutcome({status:r.native_test_runners?.records?.coverage?.exit_status,records:r.native_test_runners?.records?.coverage?.records}):null}));';
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', code, root, tier], { input: JSON.stringify(receipt), encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024 });
  must(result.status === 0, 'CODE_VALIDATOR_UNAVAILABLE');
  return json(result.stdout);
}
function codeSmoke(check, context) {
  exact(check, ['tier', 'command', 'runtime', 'evidence', 'config', 'tools'], 'code-smoke');
  must(['scanner', 'runner'].includes(check.tier), 'CODE_TIER');
  const root = realpathSync(check.runtime);
  if (!context.fixture) {
    must(root === (context.codeRoot || verifyProviderInterface({skill:'qa-code'}).root), 'CODE_RUNTIME');
    const provenance = runAdapter([process.execPath, join(root, 'scripts/package-tool.mjs'), 'verify-runtime', '--root', root], { timeout: 10000 });
    must(provenance.status === 0, 'CODE_RUNTIME_PROVENANCE');
  }
  const script = join(root, 'scripts', 'gate0.sh');
  const prefix = `bash '${script.replaceAll("'", "'\\''")}' `;
  must(typeof check.command === 'string' && check.command.startsWith(prefix) && !/--help|(?:^|\s)-h(?:\s|$)|[;|&`\n]|\$\(/.test(check.command), 'CODE_COMMAND');
  must(/--repo\s+\S+/.test(check.command) && /--base\s+\S+/.test(check.command) && !check.command.includes('--json'), 'CODE_COMMAND');
  const p = pair(check.evidence, context);
  must(['functions.exec_command', 'exec_command'].includes(p.name) && p.input.cmd === check.command, 'CODE_CALL');
  const out = p.output;
  // The second pattern is the Vietnamese "usage:" prefix (written as escapes) that child CLIs may print; usage
  // output is not an operation.
  must(out?.exit_code === 0 && typeof out.output === 'string' && out.output.trim() && !/usage:|d\u00f9ng:|ungraded|not run|unknown option/i.test(out.output), 'CODE_OPERATION');
  // Child CLI output is consumed, never invented by a summary receipt.
  if (check.config) {
    const config = file(check.config, context.runDir);
    must(check.command.includes(`--config '${config}'`), 'CODE_CONFIG_BINDING');
  } else must(!check.command.includes('--config'), 'CODE_CONFIG_MISSING');
  const receipt = json(out.output);
  must(receipt.schema === 'qa-code/gate0/v1' && receipt.status === 'pass' && receipt.runtime?.node?.version && Array.isArray(receipt.runtime.checkers) && receipt.runtime.checkers.length > 0, 'CODE_SMOKE_RESULT');
  must(Array.isArray(check.tools) && check.tools.length === receipt.runtime.checkers.length, 'CODE_TOOL_PIN');
  for (const checker of receipt.runtime.checkers) {
    must(checker.path && checker.version && checker.version !== 'unknown', 'CODE_CHECKER_METADATA');
    const pin = check.tools.find(t => t.path === checker.path);
    must(pin, 'CODE_TOOL_PIN'); file(pin, context.runDir);
    const version = runAdapter([checker.path, '--version'], { timeout: 5000 });
    must(version.status === 0 && `${version.stdout}\n${version.stderr}`.split('\n').map(s => s.trim()).find(Boolean) === checker.version, 'CODE_TOOL_VERSION_DRIFT');
  }
  const parser = canonicalChildParse(root, receipt, check.tier);
  must(parser.integrity, 'CODE_RECEIPT_INTEGRITY');
  if (check.tier === 'runner') {
    must(parser.outcome === 'pass', 'CODE_RUNNER_EXECUTION');
    const records = receipt.native_test_runners.records.coverage.records;
    for (const record of records) {
      file({ path: record.receipt?.path, sha256: record.receipt?.sha256 }, context.runDir);
      if (record.configuration) file({ path: record.configuration.path, sha256: record.configuration.sha256 }, context.runDir);
      const report = record.execution_report;
      must(report && Array.isArray(record.files) && record.files.length > 0 && Array.isArray(report.files) && report.files.length === record.files.length, 'CODE_RUNNER_SELECTION');
      file({ path: report.path, sha256: report.sha256 }, context.runDir);
      must(report.files.every(r => record.files.some(f => realpathSync(resolve(receipt.repo, f)) === r.file) && r.passed > 0 && r.skipped === 0 && r.failed === 0), 'CODE_RUNNER_SELECTION');
    }
  }
}

// The verifier reads the root's live transcript. A root that keeps writing while a detached dispatch checks its
// preflight (U6) can change the file during that read (ORIGINAL_SOURCE_CHANGED), as a refusal or as a blocked lane:
// read it again, up to five times, before blocking. Every other refusal stands at once.
const pauseSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
export function retryWhileSourceChanges(read, { attempts = 5, pause = pauseSync } = {}) {
  for (let attempt = 1; ; attempt++) {
    let result;
    try { result = read(); }
    catch (error) { if (![error?.code, error?.detail].includes('ORIGINAL_SOURCE_CHANGED') || attempt >= attempts) throw error; pause(150 * attempt); continue; }
    const raced = result?.verified === false && Object.values(result.lanes ?? {}).some((lane) => lane?.code === 'ORIGINAL_SOURCE_CHANGED');
    if (!raced || attempt >= attempts) return result;
    pause(150 * attempt);
  }
}
export function assertToolPreflight(options) { return retryWhileSourceChanges(() => assertToolPreflightOnce(options)); }

function assertToolPreflightOnce({ runDir, roster, stage, role, requirements, file: preflightFile, requireFresh = false }) {
  try {
    must(['basic', 'plan', 'execute'].includes(stage), 'STAGE');
    const receiptPath = resolve(runDir, preflightFile || 'preflight.json');
    must(receiptPath.startsWith(resolve(runDir) + sep), 'FILE_OUTSIDE_RUN');
    const p = readJson(receiptPath, { missingExit: 3, missingCode: 'PREFLIGHT_MISSING', invalidExit: 3, invalidCode: 'PREFLIGHT_INVALID' });
    exact(p, ['schema', 'run_id', 'round', 'roster_hash', 'target', 'runtime', 'target_access', 'qa_code', 'gui', 'current_identity'], 'preflight');
    must(p.schema === 'team-qa/tool-preflight/v1', 'SCHEMA');
    must(p.run_id === roster.run_id && p.round === roster.round && p.roster_hash === roster.roster_hash && eq(p.target, roster.target), 'BINDING');
    if (role) must(roster.roles.some(s => s.role === role), 'ROLE');
    must(typeof requireFresh === 'boolean', 'FRESHNESS_FLAG');
    const context = { runDir, requireFresh, fixture: roster.catalog_source?.kind === 'fixture', target: roster.target, binding: `TEAMQA_PREFLIGHT run=${roster.run_id} round=${roster.round} roster=${roster.roster_hash}`, codeRoot:null, guiRoot:null };
    exact(p.runtime, ['node_version', 'contract_sha256', 'children', 'dragon_files'], 'runtime');
    must(/^v(?:24|26)\./.test(p.runtime.node_version) && p.runtime.node_version.split('.')[0] === process.version.split('.')[0], 'NODE_VERSION');
    must(p.runtime.contract_sha256 === (isDeployedTarget(roster.target)?WEB_CONTRACT_SHA256:readContract().contract_sha256), 'SCHEMA_RUNTIME');
    if (!context.fixture) {
      must(Array.isArray(p.runtime.children) && p.runtime.children.length === 2, 'CHILD_RUNTIME_MISSING');
      for (const skill of ['qa-code', 'qa-gui']) context[skill==='qa-code'?'codeRoot':'guiRoot']=verifyInstalled(skill, p.runtime.children.find(c => c.skill === skill));
    }
    for (const ref of p.runtime.dragon_files || []) file(ref, runDir);
    let currentIdentity;
    if(isDeployedTarget(roster.target)){
      must(p.target_access?.kind==='dragon','WEB_TARGET_ACCESS');
      // Approved provenance remains immutable; dispatch freshness belongs to the current sample.
      assertDeployedIdentityProof(roster.target,{runDir,verifyOriginalSource:ref=>readDeployedIdentityObservation(ref,{roster,runDir})});
      if(requireFresh)must(p.current_identity,'CURRENT_IDENTITY_REQUIRED');
      if(p.current_identity!==undefined)currentIdentity=currentDeployedIdentity(p.current_identity,{roster,runDir,requireFresh});
    } else {
      must(p.current_identity===undefined,'CURRENT_IDENTITY_WEB_ONLY');
    }
    const access=targetAccess(p.target_access, context);
    if(currentIdentity){
      must(['sessionId','nonce','browserInstanceId'].every(k=>currentIdentity.session[k]===access.session[k]),'GUI_SESSION_DRIFT');
      must(currentIdentity.tabId===access.tabId,'GUI_TAB_DRIFT');
    }
    const lanes = { runtime: 'verified', target: 'verified', code: 'pending', gui: 'pending', recording: 'pending' };
    if (stage === 'basic') return { verified: true, stage, lanes };
    exact(requirements, ['code', 'gui', 'recording'], 'requirements');
    must(['code', 'gui', 'recording'].every(k => typeof requirements[k] === 'boolean') && (!requirements.recording || requirements.gui) && (!isDeployedTarget(roster.target)||requirements.code===false&&requirements.gui===true), 'SCOPE');
    if (stage === 'execute') must(!(role === 'executor_code' && !requirements.code || role === 'executor_gui' && !requirements.gui), 'ROLE_OUT_OF_SCOPE');
    if (requirements.code) {
      try {
        must(Array.isArray(p.qa_code) && p.qa_code.length === 2 && new Set(p.qa_code.map(c => c.tier)).size === 2, 'CODE_SMOKE_MISSING');
        for (const check of p.qa_code) codeSmoke(check, context);
        lanes.code = 'verified';
      } catch (e) {
        if (role === 'executor_code' && stage === 'execute') throw e;
        lanes.code = { status: 'BLOCKED', code: e.code || 'PREFLIGHT_CODE_BLOCKED' };
      }
    } else lanes.code = 'N/A';
    if (!requirements.recording) lanes.recording = 'N/A';
    if (!requirements.gui) { lanes.gui = 'N/A'; lanes.recording = 'N/A'; }
    else if (stage === 'plan' || stage === 'execute' && (!role || role === 'executor_gui')) {
      try {
      if (!context.fixture) {
        must(Array.isArray(p.runtime.dragon_files) && p.runtime.dragon_files.length === 3, 'DRAGON_RUNTIME_PIN');
        for (const name of ['server.js', 'mcp-server.mjs', 'package.json']) must(p.runtime.dragon_files.some(r => realpathSync(r.path) === realpathSync(join(dragonRuntimeDir(), name))), 'DRAGON_RUNTIME_PIN');
      }
      const { session, tabId } = guiAccess(p.gui, context);
      const shot = dragon(p.gui.screenshot, context, 'screenshot', session, tabId);
      must(shot.result.privacyMasked === true && Array.isArray(shot.result.maskedRects) && shot.result.savedTo, 'GUI_CONTENT');
      must(realpathSync(shot.result.savedTo) === file(p.gui.image, runDir), 'IMAGE_BINDING');
      media(p.gui.image, runDir, 'image'); lanes.gui = 'verified';
      if (requirements.recording) {
        const start = dragon(p.gui.start, context, 'startRecording', session, tabId);
        const stop = dragon(p.gui.recording, context, 'stopRecording', session);
        must(start.result.id && stop.params.id === start.result.id && stop.result.id === start.result.id && stop.result.frameCount > 1 && stop.result.events > 0, 'RECORDING_BEHAVIOR');
        const privacy = stop.result.privacy, delivery = stop.result.delivery;
        must(privacy?.masked === true && privacy.maskFailures === 0 && privacy.cleanup?.ok === true, 'RECORDING_PRIVACY');
        must(delivery?.persistedFrames === stop.result.frameCount && delivery.extensionFrames === delivery.persistedFrames && delivery.ingestErrors === 0 && delivery.captureErrors === 0 && delivery.pushErrors === 0, 'RECORDING_DELIVERY');
        const assembled = dragon(p.gui.assemble, context, 'assembleRecording', session);
        must(assembled.params.id === start.result.id && assembled.result.id === start.result.id && realpathSync(assembled.result.video) === file(p.gui.video, runDir), 'VIDEO_BINDING');
        media(p.gui.video, runDir, 'video');
        lanes.recording = 'verified';
      } else lanes.recording = 'N/A';
      } catch (e) {
        if (role === 'executor_gui' && stage === 'execute') throw e;
        lanes.gui = { status: 'BLOCKED', code: e.code || 'PREFLIGHT_GUI_BLOCKED' };
        if (requirements.recording) lanes.recording = { status: 'BLOCKED', code: e.code || 'PREFLIGHT_GUI_BLOCKED' };
      }
    }
    const relevant = role === 'executor_code' ? [lanes.code] : role === 'executor_gui' ? [lanes.gui, lanes.recording] : Object.values(lanes);
    return { verified: !relevant.some(v => v === 'pending' || v?.status === 'BLOCKED'), stage, lanes };
  } catch (error) {
    if (error.code?.startsWith('PREFLIGHT_') && error.exitCode === 3) throw error;
    fail(3, 'PREFLIGHT_VERIFICATION_BLOCKED', String(error.code || error.message || error).split('\n')[0], 'ungraded');
  }
}
