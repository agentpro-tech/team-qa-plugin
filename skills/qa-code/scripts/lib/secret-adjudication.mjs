import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {readFileSync,realpathSync,existsSync} from 'node:fs';
import {isAbsolute,relative,resolve,sep} from 'node:path';
import {verifyTeamQaReviewProof} from './teamqa-review-proof.mjs';
import {parseProviderExecution,validateProviderExecution} from './provider-execution.mjs';

export const ADJUDICATION_SCHEMA='qa-code/secret-adjudication/v1';
const sha=value=>createHash('sha256').update(value).digest('hex');
const requireValue=(value,code)=>{if(!value)throw new Error(code);};
const canonical=value=>Array.isArray(value)?`[${value.map(canonical).join(',')}]`:value&&typeof value==='object'?`{${Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical(value[k])).join(',')}}`:JSON.stringify(value);
function exact(value,keys,code){requireValue(value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).sort().join(',')===[...keys].sort().join(','),code);}
function git(repo,args){const r=spawnSync('git',['-C',repo,...args],{encoding:'utf8',timeout:10000,maxBuffer:16*1024*1024});requireValue(r.status===0,'ADJUDICATION_GIT_SOURCE');return r.stdout;}
function findingPath(repo,value){
  requireValue(typeof value==='string'&&value,'ADJUDICATION_SOURCE_PATH');
  requireValue(!value.split(/[\\/]/).includes('..'),'ADJUDICATION_SOURCE_PATH');
  const path=resolve(repo,value),root=realpathSync(repo),rel=relative(root,path);
  requireValue(rel&&rel!=='..'&&!rel.startsWith('..'+sep)&&!isAbsolute(rel),'ADJUDICATION_SOURCE_PATH');
  if(existsSync(path)){const physical=relative(root,realpathSync(path));requireValue(physical&&physical!=='..'&&!physical.startsWith('..'+sep)&&!isAbsolute(physical),'ADJUDICATION_SOURCE_PATH');}
  return rel;
}
function source(repo,head,file){
  requireValue(typeof file==='string'&&file&&!isAbsolute(file)&&!file.split(/[\\/]/).includes('..'),'ADJUDICATION_SOURCE_PATH');
  const path=realpathSync(resolve(repo,file)),rel=relative(realpathSync(repo),path);
  requireValue(rel!==''&&rel!=='..'&&!rel.startsWith('..'+sep)&&!isAbsolute(rel),'ADJUDICATION_SOURCE_PATH');
  const blob=git(repo,['show',`${head}:${file}`]);
  requireValue(readFileSync(path,'utf8')===blob,'ADJUDICATION_WORKTREE_DRIFT');
  return {blob,sha256:sha(blob),oid:git(repo,['rev-parse',`${head}:${file}`]).trim(),lines:blob.split('\n')};
}
function evidence(repo,head,item){
  exact(item,['file','blob_sha256','line','line_sha256'],'ADJUDICATION_EVIDENCE_FIELDS');
  const found=source(repo,head,item.file);
  requireValue(found.sha256===item.blob_sha256&&Number.isInteger(item.line)&&item.line>0&&item.line<=found.lines.length&&sha(found.lines[item.line-1])===item.line_sha256,'ADJUDICATION_EVIDENCE_DRIFT');
  return found.lines[item.line-1];
}
function additions(repo,base,head){
  const diff=git(repo,['-c','core.quotePath=false','diff','--no-color','--no-ext-diff','--unified=0',base,head,'--']);
  const lines=new Map();let file=null,line=0;
  for(const row of diff.split('\n')){
    if(row.startsWith('+++ b/')){file=row.slice(6);lines.set(file,new Set());}
    else if(row.startsWith('@@'))line=Number(/\+(\d+)/.exec(row)?.[1]);
    else if(row.startsWith('+')&&!row.startsWith('+++')){lines.get(file)?.add(line);line++;}
    else if(!row.startsWith('-')&&!row.startsWith('\\'))line++;
  }
  return {lines,sha256:sha(diff)};
}
function markdownProse(found,line,secret){
  let fence=null;
  for(const text of found.lines.slice(0,line)){
    const marker=/^\s{0,3}(`{3,}|~{3,})/.exec(text)?.[1];
    if(marker){if(!fence)fence=marker;else if(marker[0]===fence[0]&&marker.length>=fence.length)fence=null;}
  }
  const text=found.lines[line-1];
  if(fence||/^\s*(?:`{3,}|~{3,})|^(?: {4}|\t)/.test(text)||found.lines.slice(0,line).some(v=>/<[A-Za-z!/]/.test(v)))return false;
  const plain=text.replace(/(`+)(.*?)\1/g,' ');
  if(!plain.includes(secret)||/["'`]/.test(plain)||/(?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|password|secret|credential|private[_ -]?key)\s*(?:[=:]|is\b)/i.test(plain))return false;
  return /^[A-Za-z]+(?:[ /-][A-Za-z]+){2,}$/.test(secret)&&plain.trim().split(/\s+/).length>=8;
}

// Closed SQL token grammar: comments and quoted text cannot supply executable evidence.
function materialTokens(text,doBodies=false){
  const out=[];let i=0;
  while(i<text.length){
    const rest=text.slice(i);let m;
    if((m=/^\s+/.exec(rest))||(m=/^(?:--|\/\/)[^\n]*/.exec(rest))||(m=/^\/\*[\s\S]*?\*\//.exec(rest))){i+=m[0].length;continue;}
    if(['(','=','!',',','return'].includes(out.at(-1))&&(m=/^\/(?:\\.|[^/\\\n])+\/[a-z]*/.exec(rest))){out.push(m[0]);i+=m[0].length;continue;}
    if(rest.startsWith('`')){m=/^`(?:\\.|[^`\\])*`/.exec(rest);if(!m||m[0].includes('${'))return [];out.push(m[0]);i+=m[0].length;continue;}
    const dollar=/^\$[A-Za-z_0-9]*\$/.exec(rest)?.[0];
    if(dollar){const end=rest.indexOf(dollar,dollar.length);if(end<0)return [];const body=rest.slice(dollar.length,end);if(doBodies&&/^do$/i.test(out.at(-1)??''))out.push(dollar,...materialTokens(body),dollar);else out.push(rest.slice(0,end+dollar.length));i+=end+dollar.length;continue;}
    if((m=/^'(?:''|[^'])*'/.exec(rest))||(m=/^"(?:""|[^"])*"/.exec(rest))||(m=/^\$[A-Za-z_0-9]*\$/.exec(rest))||(m=/^[A-Za-z_][A-Za-z_0-9]*/.exec(rest))||(m=/^\d+/.exec(rest))||(m=/^(?:->>|->|:=|<>|<=|>=|\|\||!~|::|.)/.exec(rest))){out.push(m[0]);i+=m[0].length;continue;}
    return [];
  }
  return out;
}
const tokenEqual=(a,b)=>a.length===b.length&&a.every((v,i)=>v===b[i]);
function tokenAt(tokens,sequence){const out=[];for(let i=0;i<=tokens.length-sequence.length;i++)if(tokenEqual(tokens.slice(i,i+sequence.length),sequence))out.push(i);return out;}
const sqlString=value=>"'"+value.replaceAll("'","''")+"'";
function sqlFunction(tokens,name){
  const starts=tokenAt(tokens,['FUNCTION','public','.',name,'(']).filter(i=>['CREATE','REPLACE'].includes(tokens[i-1]));
  if(starts.length!==1)return null;
  const i=starts[0],first=tokens.findIndex((t,j)=>j>i&&t.startsWith('$$')&&t.endsWith('$$')&&t.length>4);
  if(first<0||tokens[first-1]!=='AS')return null;
  return {signature:tokens.slice(i,first),body:materialTokens(tokens[first].slice(2,-2))};
}
const nonceBody=materialTokens(`DECLARE inserted integer;
BEGIN
  IF p_nonce IS NULL OR length(p_nonce) NOT BETWEEN 22 AND 128
    OR p_body_sha256 IS NULL OR length(p_body_sha256)<>64 OR p_sent_at IS NULL
    OR abs(extract(epoch FROM (now()-p_sent_at)))>300 THEN RETURN false; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.billing_transport_keys k
    JOIN public.billing_module_bindings b ON b.company_id=k.company_id AND b.module='supply'
    JOIN public.billing_companies c ON c.id=k.company_id
    WHERE k.key_id=p_key_id AND k.revoked_at IS NULL AND k.valid_from<=now()
      AND (k.valid_until IS NULL OR now()<k.valid_until)
      AND b.status='verified' AND b.identity_revision=k.identity_revision
      AND b.source_workspace_id=k.source_workspace_id
      AND c.issuer=k.provider_issuer AND c.tenant_workspace_id=k.provider_workspace_id
  ) THEN RETURN false; END IF;
  INSERT INTO public.billing_transport_nonces(key_id,nonce,body_sha256,sent_at,expires_at)
    VALUES(p_key_id,p_nonce,p_body_sha256,p_sent_at,p_sent_at + interval '300 seconds')
    ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS inserted=ROW_COUNT; RETURN inserted=1; END;`);
function sqlMaterial({repo,head,file,found,line,secret,item,kind}){
  if(item.oracle!==undefined||!/(?:^|\/)(?:test|tests)\//.test(file)||!file.endsWith('.sql')||typeof secret!=='string')return false;
  const fixture=materialTokens(found.blob,true),row=materialTokens(found.lines[line-1]);
  if(!tokenEqual(fixture.slice(0,2),['BEGIN',';'])||!tokenEqual(fixture.slice(-2),['ROLLBACK',';'])||fixture.includes('COMMIT')||fixture.includes('commit')||fixture.some(t=>/^(?:hmac|sign|encrypt|decrypt|importkey|crypto)$/i.test(t)))return false;
  // Only existing rollback-fixture role switches may execute quoted SQL.
  for(let i=0;i<fixture.length;i++)if(/^execute$/i.test(fixture[i])){
    if(tokenEqual(fixture.slice(i,i+3),['EXECUTE',"'SET LOCAL ROLE service_role'",';'])||tokenEqual(fixture.slice(i,i+3),['EXECUTE',"'RESET ROLE'",';']))continue;
    const variable=fixture[i+5],loop=['FOREACH',variable,'IN','ARRAY','ARRAY','[',"'anon'",',',"'authenticated'",']','LOOP','denied',':=','false',';'];
    if(!/^[a-z_][a-z0-9_]*$/i.test(variable??'')||!tokenEqual(fixture.slice(i,i+8),['EXECUTE',"'SET LOCAL ROLE '",'||','quote_ident','(',variable,')',';'])||!tokenEqual(fixture.slice(i-loop.length,i),loop))return false;
  }
  // Evidence must cover complete, independently tracked active consumer declarations/bodies.
  const evidenceFiles=[...new Set(item.evidence.map(e=>e.file).filter(f=>f!==file))];
  // Preserve file kind explicitly rather than infer it from supplied snippets.
  const sqlSources=evidenceFiles.filter(f=>f.endsWith('.sql')).map(f=>materialTokens(source(repo,head,f).blob));
  if(kind==='sql_environment_reference'){
    if(!/^BILLING_S2S_KEY_[A-Z0-9_]{1,80}$/.test(secret))return false;
    const assignment=/^\s*([a-z_][a-z0-9_]*):='((?:''|[^'])*)';\s*$/i.exec(found.lines[line-1]);
    if(!assignment||!tokenEqual(row,materialTokens(`${assignment[1]}:='${assignment[2]}';`))||tokenAt(fixture,row).length!==1)return false;
    let config;try{config=JSON.parse(assignment[2].replaceAll("''","'"));}catch{return false;}
    if(!config||Object.keys(config).sort().join(',')!=='binding,ingest,proxy'||!Object.values(config).every(v=>v&&Object.keys(v).sort().join(',')==='generationId,secretRef'&&/^[A-Za-z0-9_-]{1,128}$/.test(v.generationId)&&/^BILLING_S2S_KEY_[A-Z0-9_]{1,80}$/.test(v.secretRef))||!Object.values(config).some(v=>v.secretRef===secret))return false;
    const variable=assignment[1];
    const calls=tokenAt(fixture,['billing_resolve_supply_binding_and_transport','(']);
    if(!calls.some(i=>{
      let depth=1,args=[[]];for(let j=i+2;j<fixture.length&&depth;j++){const t=fixture[j];if(t==='(')depth++;if(t===')')depth--;if(!depth)break;if(t===','&&depth===1)args.push([]);else args.at(-1).push(t);}
      return args.length===9&&tokenEqual(args[8],[variable]);
    }))return false;
    const tainted=new Set([variable]);
    for(const i of tokenAt(fixture,['jsonb_set','(',variable,',']))if(fixture[i-1]===':='&&/^[a-z_][a-z0-9_]*$/i.test(fixture[i-2]))tainted.add(fixture[i-2]);
    for(const name of tainted){
      for(let i=0;i<fixture.length;i++)if(fixture[i]===name){
        const declaration=fixture[i+1]==='jsonb';
        const literalAssignment=fixture[i+1]===':='&&fixture[i+2]?.startsWith("'")&&name===variable;
        const derivation=fixture[i+1]===':='&&['jsonb_set','replace'].includes(fixture[i+2]);
        const input=(fixture[i-2]==='jsonb_set'&&fixture[i-1]==='(')||(fixture[i-2]==='replace'&&fixture[i-1]==='('&&fixture[i+1]==='::'&&fixture[i+2]==='text');
        const resolverArgument=calls.some(j=>{
          let depth=1,args=[[]],positions=[[]];for(let k=j+2;k<fixture.length&&depth;k++){const t=fixture[k];if(t==='(')depth++;if(t===')')depth--;if(!depth)break;if(t===','&&depth===1){args.push([]);positions.push([]);}else{args.at(-1).push(t);positions.at(-1).push(k);}}
          return args.length===9&&tokenEqual(args[8],[name])&&positions[8][0]===i;
        });
        if(!declaration&&!literalAssignment&&!derivation&&!input&&!resolverArgument)return false;
      }
    }
    // The reference literal occurs only in JSON metadata or an exact secret_ref comparison.
    if(fixture.some((t,i)=>t.startsWith("'")&&t.includes(secret)&&t!==row[2]&&!(t===sqlString(secret)&&fixture[i-1]==='<>'&&fixture.slice(Math.max(0,i-12),i).includes('secret_ref'))))return false;
    const resolver=sqlSources.map(t=>sqlFunction(t,'billing_resolve_supply_binding_and_transport')).find(Boolean);
    if(!resolver)return false;
    if(!sqlSources.some(t=>tokenAt(t,materialTokens('CREATE TABLE public.billing_transport_keys(')).length===1&&tokenAt(t,materialTokens('secret_ref text NOT NULL,')).length===1))return false;
    const b=resolver.body,ref=materialTokens("config->>'secretRef'");
    if(b.some(t=>/^execute$/i.test(t)))return false;
    const uses=tokenAt(b,ref);
    if(b.filter(t=>t==='secret_ref').length!==2||uses.length!==4||!tokenAt(b,materialTokens("config->>'secretRef' !~ '^BILLING_S2S_KEY_[A-Z0-9_]{1,80}$'")).length||!tokenAt(b,materialTokens("existing.secret_ref<>config->>'secretRef'")).length||!tokenAt(b,materialTokens("p_source_workspace_id::text,revision,config->>'secretRef','supply','hrm-billing',actions")).length||!tokenAt(b,materialTokens('INSERT INTO public.billing_transport_keys(key_id,company_id,provider_issuer,provider_workspace_id,source_workspace_id,identity_revision,secret_ref,sender,audience,allowed_actions,valid_from)')).length)return false;
    // No aliasing, arbitrary config consumption or additional signing use is supported.
    const allowedConfig=[materialTokens('config jsonb'),materialTokens('config:=p_key_config->purpose'),materialTokens('jsonb_typeof(config)'),materialTokens('jsonb_object_keys(config)'),materialTokens("config->>'generationId'"),ref];
    for(let i=0;i<b.length;i++)if(b[i]==='config'&&!allowedConfig.some(p=>tokenAt(b,p).some(j=>i>=j&&i<j+p.length)))return false;
    for(let i=0;i<b.length;i++)if(b[i]==='p_key_config'&&!['jsonb','IS',')','->'].includes(b[i+1]))return false;
    const envNames=evidenceFiles.filter(f=>f.endsWith('.ts'));
    const envFiles=envNames.map(f=>materialTokens(source(repo,head,f).blob));
    if(envFiles.some(t=>t.some(v=>v==='eval'||v==='Function')))return false;
    const expected=materialTokens(`function secretBytes(secretRef: string): Uint8Array | null {
      if (!/^BILLING_S2S_KEY_[A-Z0-9_]{1,80}$/.test(secretRef)) return null
      const encoded = Deno.env.get(secretRef)
      if (!encoded || !/^[A-Za-z0-9_-]+$/.test(encoded)) return null
      try { const raw = atob(encoded.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - encoded.length % 4) % 4))
        const bytes = Uint8Array.from(raw, c => c.charCodeAt(0))
        return bytes.byteLength >= 32 ? bytes : null
      } catch { return null }
    }`);
    const lookup=materialTokens("async keyId => {\n        const { data: key, error } = await admin.from('billing_transport_keys')\n          .select('key_id,company_id,provider_issuer,provider_workspace_id,source_workspace_id,identity_revision,secret_ref,sender,audience,allowed_actions,valid_from,valid_until,revoked_at')\n          .eq('key_id', keyId).maybeSingle()\n        if (error) throw new Error('TRANSPORT_KEY_LOOKUP_UNAVAILABLE')\n        if (!key || key.sender !== 'supply' || key.audience !== 'hrm-billing'\n          || key.revoked_at || Date.parse(key.valid_from) > Date.now()\n          || key.valid_until && Date.parse(key.valid_until) <= Date.now()) return null\n        const [company, binding] = await Promise.all([\n          admin.from('billing_companies').select('issuer,tenant_workspace_id')\n            .eq('id', key.company_id).maybeSingle(),\n          admin.from('billing_module_bindings').select('status,source_workspace_id,identity_revision')\n            .eq('company_id', key.company_id).eq('module', 'supply').maybeSingle(),\n        ])\n        if (company.error || binding.error) throw new Error('TRANSPORT_SCOPE_LOOKUP_UNAVAILABLE')\n        if (!company.data || company.data.issuer !== key.provider_issuer\n          || company.data.tenant_workspace_id !== key.provider_workspace_id\n          || !binding.data || binding.data.status !== 'verified'\n          || binding.data.source_workspace_id !== key.source_workspace_id\n          || binding.data.identity_revision !== key.identity_revision) return null\n        const ids = { companyId: key.company_id, sourceWorkspaceId: key.source_workspace_id }\n        if (!validTrustedIds(ids)) throw new Error('TRANSPORT_KEY_LOOKUP_UNAVAILABLE')\n        const secret = secretBytes(key.secret_ref)\n        if (!secret) throw new Error('TRANSPORT_KEY_SECRET_UNAVAILABLE')\n        const scope: BillingSigningScope = { keyId: key.key_id, secret,\n          companyId: ids.companyId,\n          providerIssuer: key.provider_issuer, providerWorkspaceId: key.provider_workspace_id,\n          sourceWorkspaceId: ids.sourceWorkspaceId, identityRevision: key.identity_revision,\n          actions: key.allowed_actions, active: true }\n        return scope\n      }");
    let actualSignatureFile=null;
    const validReceiver=envFiles.some((t,entry)=>{
      const positions=tokenAt(t,expected),calls=tokenAt(t,materialTokens('const verified = await verifyBillingRequest(')),servers=tokenAt(t,materialTokens('Deno.serve(async req => {'));
      if(positions.length!==1||t.filter(v=>v==='verifyBillingRequest').length!==2||t.filter(v=>v==='secretBytes').length!==2||tokenAt(t,['function','secretBytes','(']).length!==1||t.slice(0,positions[0]).reduce((d,v)=>d+(v==='{'?1:v==='}'?-1:0),0)!==0||calls.length!==1||servers.length!==1)return false;
      const imports=tokenAt(t,materialTokens("import { BILLING_S2S_CLOCK_SKEW_MS, verifyBillingRequest, type BillingSignedHeaders, type BillingSigningScope } from"));
      if(imports.length!==1)return false;
      const module=t[imports[0]+materialTokens("import { BILLING_S2S_CLOCK_SKEW_MS, verifyBillingRequest, type BillingSignedHeaders, type BillingSigningScope } from").length];
      if(!module?.startsWith("'")||!module.endsWith("'")||!module.slice(1,-1).startsWith('.'))return false;
      const signaturePath=relative(repo,resolve(repo,envNames[entry],'..',module.slice(1,-1)));
      if(!envNames.includes(signaturePath))return false;
      actualSignatureFile=signaturePath;
      const call=calls[0],start=call+materialTokens('const verified = await verifyBillingRequest(').length;
      if(call<servers[0]||!tokenEqual(t.slice(call-2,call),['try','{']))return false;
      if(t.slice(servers[0]+materialTokens('Deno.serve(async req => {').length,call).reduce((d,v)=>d+(v==='{'?1:v==='}'?-1:0),0)!==1)return false;
      let depth=1,args=[[]];for(let i=start;i<t.length&&depth;i++){const v=t[i];if(['(','{','['].includes(v))depth++;if([')','}',']'].includes(v))depth--;if(!depth)break;if(v===','&&depth===1)args.push([]);else args.at(-1).push(v);}
      return args.length===5&&tokenEqual(args[3],lookup)&&tokenEqual(args[0],['rawBody'])&&tokenEqual(args[1],['headers'])&&tokenAt(t,materialTokens('if (!validTrustedIds(verified.scope)) throw new Error(\'TRANSPORT_KEY_LOOKUP_UNAVAILABLE\')')).length===1;
    });
    if(!validReceiver)return false;
    const sharedHmac=materialTokens("async function hmacKey(secret: Uint8Array): Promise<CryptoKey> {\n  if (secret.byteLength < 32) throw new Error('WEAK_S2S_KEY');\n  return crypto.subtle.importKey('raw', secret as BufferSource, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);\n}"),sharedVerify=materialTokens("export async function verifyBillingRequest(rawUtf8Body: string, headers: BillingSignedHeaders, now: string,\n  lookupKey: (keyId: string) => Promise<BillingSigningScope | null>, claimNonce: ClaimNonce): Promise<BillingVerifiedSignature> {\n  const at = Date.parse(now), sent = Date.parse(headers.timestamp);\n  if (!Number.isFinite(at) || !Number.isFinite(sent) || Math.abs(at - sent) > BILLING_S2S_CLOCK_SKEW_MS) throw new Error('S2S_TIMESTAMP_EXPIRED');\n  if (!/^[A-Za-z0-9_-]{22,128}$/.test(headers.nonce) || !headers.keyId || headers.sender !== 'supply'\n    || headers.audience !== 'hrm-billing' || !['ingest_supply_usage', 'proxy_billing_action'].includes(headers.action)) throw new Error('S2S_HEADER_INVALID');\n  const scope = await lookupKey(headers.keyId);\n  if (!scope?.active || scope.keyId !== headers.keyId || !scope.actions.includes(headers.action)) throw new Error('S2S_KEY_SCOPE_DENIED');\n  const digest = await sha256Body(rawUtf8Body);\n  if (digest !== headers.bodySha256) throw new Error('S2S_BODY_MISMATCH');\n  const fields = { keyId: headers.keyId, sender: headers.sender, audience: headers.audience, action: headers.action,\n    timestamp: headers.timestamp, nonce: headers.nonce, bodySha256: headers.bodySha256 };\n  const verified = await crypto.subtle.verify('HMAC', await hmacKey(scope.secret), decodeBase64url(headers.signature) as BufferSource, encoder.encode(canonical(fields)));\n  if (!verified) throw new Error('S2S_SIGNATURE_INVALID');\n  const expiresAt = new Date(sent + BILLING_S2S_CLOCK_SKEW_MS).toISOString();\n  if (!await claimNonce(headers.keyId, headers.nonce, expiresAt)) throw new Error('S2S_NONCE_REPLAY');\n  const { secret: _secret, ...verifiedScope } = scope;\n  return { scope: verifiedScope, requestSentAt: headers.timestamp, bodySha256: digest };\n}");
    return envFiles.some((t,entry)=>envNames[entry]===actualSignatureFile&&[sharedHmac,sharedVerify].every(pattern=>{const positions=tokenAt(t,pattern);return positions.length===1&&t.slice(0,positions[0]).reduce((d,v)=>d+(v==='{'?1:v==='}'?-1:0),0)===0;}));
  }
  if(!/^nonce-[a-z0-9-]{16,100}$/.test(secret)||/bearer|token|secret|password|credential/i.test(secret))return false;
  const matches=tokenAt(fixture,['billing_claim_transport_nonce','(']).map(i=>{
    let depth=1,args=[[]],end=i+2;for(;end<fixture.length&&depth;end++){const t=fixture[end];if(t==='(')depth++;if(t===')')depth--;if(!depth)break;if(t===','&&depth===1)args.push([]);else args.at(-1).push(t);}
    return {i,end,args};
  }).filter(c=>c.args.length===4&&tokenEqual(c.args[1],[sqlString(secret)]));
  if(matches.length!==2||!matches.every(c=>c.args[0].length===1&&/^[a-z_][a-z0-9_]*$/i.test(c.args[0][0]))||!tokenEqual(matches[0].args.flat(),matches[1].args.flat()))return false;
  const [first,replay]=matches,key=first.args[0][0];
  const directPair=tokenEqual(fixture.slice(first.i-2,first.i),['IF','NOT'])&&fixture[first.end+1]==='OR'&&replay.i===first.end+2&&fixture[replay.end+1]==='THEN'&&tokenEqual(fixture.slice(replay.end+2,replay.end+4),['RAISE','EXCEPTION']);
  if(!directPair||fixture.filter(t=>t===sqlString(secret)).length!==2||!tokenAt(row,['billing_claim_transport_nonce','(']).length)return false;
  const derivations=tokenAt(fixture,[key,':=','billing_supply_scoped_transport_id','(']);
  if(derivations.length!==1||derivations[0]>=first.i)return false;
  const keyConsumer=sqlSources.map(t=>sqlFunction(t,'billing_supply_scoped_transport_id')).find(Boolean);
  if(!keyConsumer)return false;
  const kb=keyConsumer.body;
  if(kb.filter(t=>t==='RETURN').length!==1||!tokenAt(kb,materialTokens("RETURN 'p1_'||p_purpose||'_'||pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(canonical,'UTF8')),'hex');")).length||!tokenAt(kb,materialTokens("LOOP canonical:=canonical||octet_length(value)::text||':'||value; END LOOP;")).length||kb.filter(t=>t==='canonical').length!==4||kb.some(t=>/^(?:hmac|sign|encrypt|decrypt|importkey|crypto|execute)$/i.test(t)))return false;
  const consumer=sqlSources.map(t=>sqlFunction(t,'billing_claim_transport_nonce')).find(Boolean);
  return !!consumer&&tokenEqual(consumer.body,nonceBody)&&tokenEqual(consumer.signature.slice(0,materialTokens('FUNCTION public.billing_claim_transport_nonce(p_key_id text,p_nonce text,p_body_sha256 text,p_sent_at timestamptz)').length),materialTokens('FUNCTION public.billing_claim_transport_nonce(p_key_id text,p_nonce text,p_body_sha256 text,p_sent_at timestamptz)'));
}

export const secretFindingHash=finding=>sha(canonical(finding));

// Classification is a calculation over pinned public evidence, not a caller's PASS field.
export function evaluateSecretAdjudication({repo,base,head,reportPath,reportSha256,decision}){
  requireValue(git(repo,['rev-parse','HEAD']).trim()===head,'ADJUDICATION_HEAD_DRIFT');
  const rawBytes=readFileSync(reportPath);requireValue(sha(rawBytes)===reportSha256,'ADJUDICATION_REPORT_DRIFT');
  const raw=JSON.parse(rawBytes);requireValue(Array.isArray(raw),'ADJUDICATION_REPORT_SHAPE');
  exact(decision,['schema','repo','base','head','report_sha256','findings'],'ADJUDICATION_FIELDS');
  requireValue(decision.schema===ADJUDICATION_SCHEMA&&decision.repo===realpathSync(repo)&&decision.base===base&&decision.head===head&&decision.report_sha256===reportSha256,'ADJUDICATION_TARGET_DRIFT');
  requireValue(Array.isArray(decision.findings)&&decision.findings.length===raw.length,'ADJUDICATION_FINDING_COVERAGE');
  const scope=additions(repo,base,head),indices=new Set(),rows=[];
  for(const item of decision.findings){
    exact(item,['reportIndex','fingerprint','finding_sha256','file','blob_oid','blob_sha256','line','line_sha256','classification','rationale','evidence',...(item.oracle!==undefined?['oracle']:[])],'ADJUDICATION_FINDING_FIELDS');
    requireValue(Number.isInteger(item.reportIndex)&&item.reportIndex>=0&&item.reportIndex<raw.length&&!indices.has(item.reportIndex),'ADJUDICATION_FINDING_COVERAGE');indices.add(item.reportIndex);
    const finding=raw[item.reportIndex],file=findingPath(repo,finding.File??finding.file),line=Number(finding.StartLine??finding.line);
    requireValue(item.fingerprint===(finding.Fingerprint??null)&&item.finding_sha256===secretFindingHash(finding),'ADJUDICATION_FINGERPRINT_DRIFT');
    requireValue(item.file===file&&item.line===line&&Number.isInteger(line)&&line>0,'ADJUDICATION_SOURCE_DRIFT');
    requireValue(typeof item.rationale==='string'&&item.rationale.trim().length>=20&&Array.isArray(item.evidence),'ADJUDICATION_RATIONALE');
    const applicable=scope.lines.get(file)?.has(line)===true;
    if(!applicable){
      requireValue(item.classification==='out_of_scope'&&item.blob_oid===null&&item.blob_sha256===null&&item.line_sha256===null&&item.evidence.length===0&&item.oracle===undefined,'ADJUDICATION_OUT_OF_SCOPE_BINDING');
      rows.push({reportIndex:item.reportIndex,fingerprint:item.fingerprint,finding_sha256:item.finding_sha256,file,line,blob_oid:null,blob_sha256:null,line_sha256:null,classification:'out_of_scope',applicable:false,blocking:false});continue;
    }
    const found=source(repo,head,file);
    requireValue(item.blob_oid===found.oid&&item.blob_sha256===found.sha256&&line<=found.lines.length&&item.line_sha256===sha(found.lines[line-1]),'ADJUDICATION_SOURCE_DRIFT');
    const evidenceLines=item.evidence.map(e=>evidence(repo,head,e));
    let benign=false;
    const secret=finding.Secret;
    if(item.classification==='public_deterministic_id'){
      exact(item.oracle,['encoding','prefix','inputs'],'ADJUDICATION_ORACLE_FIELDS');
      const oracle=item.oracle;
      requireValue(oracle.encoding==='utf8-length-prefix-sha256'&&/^p1_[a-z][a-z0-9_]{0,30}_$/.test(oracle.prefix)&&!/(?:secret|token|password|credential|key)/i.test(oracle.prefix),'ADJUDICATION_PUBLIC_ID_FORMAT');
      requireValue(Array.isArray(oracle.inputs)&&oracle.inputs.length>=2&&oracle.inputs.every(v=>typeof v==='string'&&v&&v.length<=256&&!/-----BEGIN|\bBearer\b|\b(?:sk|ghp|github_pat)[_-]|^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\./.test(v)),'ADJUDICATION_PUBLIC_INPUT');
      requireValue(item.evidence.some(e=>e.file!==file)&&oracle.inputs.every(v=>evidenceLines.some(text=>text.includes(JSON.stringify(v))||text.includes("'"+v.replaceAll('\\','\\\\').replaceAll("'","\\'")+"'"))),'ADJUDICATION_INDEPENDENT_PUBLIC_EVIDENCE');
      const calculated=oracle.prefix+sha(oracle.inputs.map(v=>`${Buffer.byteLength(v,'utf8')}:${v}`).join(''));
      const credentialAssignment=/(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret|credential|private[_-]?key)\s*[=:]/i.test(found.lines[line-1]);
      benign=typeof secret==='string'&&secret===calculated&&found.lines[line-1].includes(secret)&&!credentialAssignment;
    }else if(item.classification==='nonassigned_test_prose'){
      requireValue(/(?:^|\/)(?:test|tests|__tests__)\/|\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file),'ADJUDICATION_TEST_PROSE_LOCATION');
      const title=/^\s*(?:it|test)(?:\.(?:only|skip))?\(\s*(['"])([^'"\n]+)\1/.exec(found.lines[line-1])?.[2];
      benign=typeof secret==='string'&&/^[A-Za-z][A-Za-z ,.;!?()'-]{15,255}$/.test(secret)&&secret.split(/\s+/).length>=4&&!!title&&title.includes(secret)&&item.evidence.length>0;
    }else if(item.classification==='nonassigned_prose'){
      requireValue(/\.md$/i.test(file),'ADJUDICATION_PROSE_LOCATION');
      benign=typeof secret==='string'&&secret.length>=16&&secret.length<=256&&markdownProse(found,line,secret)&&item.evidence.length>0;
    }else if(['sql_environment_reference','sql_rollback_replay_nonce'].includes(item.classification)){
      benign=sqlMaterial({repo,head,file,found,line,secret,item,kind:item.classification});
    }else requireValue(['actual_secret','uncertain','out_of_scope'].includes(item.classification),'ADJUDICATION_CLASSIFICATION');
    requireValue(item.classification!=='out_of_scope'||!applicable,'ADJUDICATION_SCOPE_MISCLASSIFIED');
    rows.push({reportIndex:item.reportIndex,fingerprint:item.fingerprint,finding_sha256:item.finding_sha256,file,line,blob_oid:item.blob_oid,blob_sha256:item.blob_sha256,line_sha256:item.line_sha256,classification:item.classification,applicable,blocking:applicable&&!benign});
  }
  rows.sort((a,b)=>a.reportIndex-b.reportIndex);
  return {schema:ADJUDICATION_SCHEMA,status:rows.some(r=>r.blocking)?'fail':'pass',repo:realpathSync(repo),base,head,scope:{type:'added-lines',diff_sha256:scope.sha256},report:{path:resolve(reportPath),sha256:reportSha256},decision_sha256:sha(canonical(decision)),findings:rows};
}

export function verifySecretAdjudication({repo,base,head,reportPath,reportSha256,proofPath,runtimePath}){
  requireValue(proofPath,'ADJUDICATION_INDEPENDENT_PROOF_REQUIRED');
  const proof=JSON.parse(readFileSync(proofPath,'utf8'));
  const checked=verifyTeamQaReviewProof({proofPath,runtimePath,repo,base,head,provider:proof.seat?.provider,model:proof.seat?.model,reasoning:proof.seat?.effort,stage:'post'});
  requireValue(proof.attestation_path&&sha(readFileSync(proof.attestation_path))===proof.attestation_sha256,'ADJUDICATION_ATTESTATION_DRIFT');
  const attestation=JSON.parse(readFileSync(proof.attestation_path,'utf8'));
  requireValue(['codex-rollout','codex-stream','claude-stream'].includes(attestation.source?.kind),'ADJUDICATION_EXISTING_PROVIDER_ROUTE_REQUIRED');
  const execution=parseProviderExecution({provider:proof.seat.provider,stdout:readFileSync(resolve(proof.run_dir,attestation.source.path),'utf8'),stderr:readFileSync(resolve(proof.run_dir,attestation.source.stderr_path),'utf8'),metadataSource:attestation.source.metadata_source});
  requireValue(!validateProviderExecution(execution,{provider:proof.seat.provider,model:proof.seat.model,reasoning:proof.seat.effort}).length&&execution.session_id===attestation.session_id&&execution.tool_log.length>0,'ADJUDICATION_REVIEW_EXECUTION_INVALID');
  const decision=JSON.parse(execution.verdictText);
  const result=evaluateSecretAdjudication({repo,base,head,reportPath,reportSha256,decision});
  return {...result,review:{proof_path:resolve(proofPath),proof_sha256:sha(readFileSync(proofPath)),attestation_path:resolve(proof.attestation_path),attestation_sha256:proof.attestation_sha256,runtime_path:checked.runtime_root,reviewer_agent_id:attestation.agent_id,reviewer_session_id:attestation.session_id}};
}

/** Every consumer rereads source, raw scanner bytes and actual post-review provenance. */
export function verifyGate0SecretAdjudication(gate0){
  const layer=gate0?.layers?.secret;
  if(!layer)return;
  if(layer.adjudication?.status==='fail'&&layer.effective_status===undefined&&gate0.status!=='pass')return;
  if(layer.effective_status!==undefined||layer.adjudication!==undefined){
    requireValue(layer.status==='fail'&&layer.raw_scanner?.status==='fail','ADJUDICATION_RAW_FAIL_REQUIRED');
    const saved=layer.adjudication;
    requireValue(saved?.status==='pass'&&saved.review&&layer.effective_status==='pass','ADJUDICATION_NOT_APPROVED');
    const checked=verifySecretAdjudication({repo:gate0.repo,base:gate0.base,head:gate0.commit,reportPath:layer.raw_scanner.report.path,reportSha256:layer.raw_scanner.report.sha256,proofPath:saved.review.proof_path,runtimePath:saved.review.runtime_path});
    requireValue(canonical(checked)===canonical(saved),'ADJUDICATION_RECEIPT_DRIFT');
  }else requireValue(!(gate0.status==='pass'&&layer.status==='fail'),'ADJUDICATION_INDEPENDENT_PROOF_REQUIRED');
}

// A consumer may aggregate the effective result only after independent proof readback.
export function verifiedSecretStatus(gate0){
  verifyGate0SecretAdjudication(gate0);
  return gate0?.layers?.secret?.effective_status ?? gate0?.layers?.secret?.status;
}
