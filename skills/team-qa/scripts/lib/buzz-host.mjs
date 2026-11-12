// The Buzz host (Team QA 1.17.0). Buzz runs a Claude agent through the Claude Agent SDK, so its transcript has no typed
// human line: every turn arrives as an SDK prompt that carries the Buzz message as a signed Nostr event inside
// <buzz-event>…</buzz-event>. Team QA accepts such a session as the root orchestrator, and such a message as the human's
// word (an "Approve" for the roster or the plan), only when:
//   1. the event's id and BIP-340 signature hold (nostr.mjs), so the agent cannot write it in someone else's name;
//   2. its author is an approver named in the Buzz host grant, which the Team QA owner signs with the owner key for this
//      machine (the same key and rules as the owner grant);
//   3. it was posted in the same Buzz channel and thread as the message that started the session.
// Anything else stays as before: an SDK session without such an event is CLAUDE_HOST_HEADLESS.
import { createPrivateKey, createPublicKey, randomBytes, sign, verify, createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { stableJson } from './core.mjs';
import { defaultPrivateKeyPath, machineFingerprint, readPublicKey } from './owner-grant.mjs';
import { nostrPubkeyHex, verifiedNostrEvent } from './nostr.mjs';

export const BUZZ_GRANT_SCHEMA = 'team-qa/buzz-host-grant/v1';
const MAX_DAYS = 366;
const BUZZ_EVENT = /<buzz-event>([\s\S]*?)<\/buzz-event>/g;
const keyId = key => createHash('sha256').update((key.type === 'public' ? key : createPublicKey(key)).export({ type: 'spki', format: 'der' })).digest('hex');

export const defaultBuzzGrantPath = (home = homedir()) => join(home, '.agentpro', 'teamqa', 'buzz-host-grant.json');

export function issueBuzzGrant({ approvers, days, machine, note = '', privatePath = defaultPrivateKeyPath(), now = Date.now(), id = 'bg-' + randomBytes(6).toString('hex') } = {}) {
  const keys = [...new Set((approvers || []).map(nostrPubkeyHex))];
  if (!keys.length || keys.includes(null)) throw new Error('BUZZ_GRANT_APPROVER_INVALID: give each approver as an npub or a 64-character hex public key');
  if (!Number.isInteger(days) || days < 1 || days > MAX_DAYS) throw new Error(`BUZZ_GRANT_DAYS_INVALID: 1..${MAX_DAYS}`);
  if (!/^mfp-[a-f0-9]{32}$/.test(machine || '')) throw new Error('BUZZ_GRANT_MACHINE_INVALID: give a machine fingerprint (teamqa grant fingerprint)');
  if (!existsSync(privatePath)) throw new Error(`BUZZ_GRANT_KEY_MISSING: the owner key is not on this machine (${privatePath})`);
  const privateKey = createPrivateKey(readFileSync(privatePath));
  const grant = { id, issued_at: new Date(now).toISOString(), expires_at: new Date(now + days * 86400000).toISOString(), machine, approvers: keys.sort(), note: String(note).slice(0, 200) };
  return { schema: BUZZ_GRANT_SCHEMA, key_id: keyId(createPublicKey(privateKey)), grant, signature: sign(null, Buffer.from(stableJson(grant)), privateKey).toString('base64') };
}

export function verifyBuzzGrant(doc, { publicKey = readPublicKey(), machine = machineFingerprint(), now = Date.now() } = {}) {
  const deny = code => ({ ok: false, code, approves: () => false });
  if (!doc) return deny('BUZZ_GRANT_NONE');
  if (!publicKey) return deny('BUZZ_GRANT_NO_PUBLIC_KEY');
  if (doc.schema !== BUZZ_GRANT_SCHEMA || !doc.grant || typeof doc.signature !== 'string') return deny('BUZZ_GRANT_SHAPE');
  if (doc.key_id !== publicKey.key_id) return deny('BUZZ_GRANT_WRONG_KEY');
  let good = false;
  try { good = verify(null, Buffer.from(stableJson(doc.grant)), createPublicKey(publicKey.public_key_pem), Buffer.from(doc.signature, 'base64')); } catch { good = false; }
  if (!good) return deny('BUZZ_GRANT_SIGNATURE');
  const g = doc.grant, issued = Date.parse(g.issued_at), expires = Date.parse(g.expires_at);
  if (!Number.isFinite(issued) || !Number.isFinite(expires) || issued > now + 300000) return deny('BUZZ_GRANT_TIME');
  if (now >= expires) return deny('BUZZ_GRANT_EXPIRED');
  if (g.machine !== machine) return deny('BUZZ_GRANT_OTHER_MACHINE');
  if (!Array.isArray(g.approvers) || !g.approvers.length || g.approvers.some(k => nostrPubkeyHex(k) !== k)) return deny('BUZZ_GRANT_SHAPE');
  return { ok: true, grant: g, approves: pubkey => g.approvers.includes(pubkey) };
}

export function loadBuzzGrant({ path = defaultBuzzGrantPath(), ...options } = {}) {
  if (!existsSync(path)) return verifyBuzzGrant(null, options);
  let doc;
  try { doc = JSON.parse(readFileSync(path, 'utf8')); } catch { return { ok: false, code: 'BUZZ_GRANT_SHAPE', approves: () => false }; }
  return verifyBuzzGrant(doc, options);
}

// Tests swap in a grant signed by a throwaway key; production always reads the grant file.
let grantSource = () => loadBuzzGrant();
export function useBuzzGrantForTests(grant) { grantSource = grant ? () => grant : () => loadBuzzGrant(); }

// The single Buzz event of an SDK prompt line, checked; null when the line is not such a prompt or the event fails.
export function buzzEventOf(entry) {
  const m = entry?.message;
  if (entry?.type !== 'user' || entry.isSidechain === true || entry.isMeta === true || m?.role !== 'user') return null;
  if (!/^sdk/i.test(entry.entrypoint || '') || entry.toolUseResult !== undefined) return null;
  const text = typeof m.content === 'string' ? m.content : Array.isArray(m.content) && m.content.every(c => c?.type === 'text' && typeof c.text === 'string')
    ? m.content.map(c => c.text).join('\n') : null;
  if (text === null) return null;
  const blocks = [...text.matchAll(BUZZ_EVENT)];
  if (blocks.length !== 1) return null;
  let raw;
  try { raw = JSON.parse(blocks[0][1].trim().split('\n')[0]); } catch { return null; }
  const event = verifiedNostrEvent(raw);
  if (!event) return null;
  const tag = name => event.tags.filter(t => t[0] === name).map(t => t[1]);
  const channels = tag('h'), parents = tag('e');
  if (channels.length !== 1 || parents.length > 1) return null;
  return { event, channel: channels[0], thread: parents[0] ?? event.id };
}

// The event that opened a Buzz session: the first SDK prompt of the transcript, from an approver in the grant.
export function buzzSessionRoot(lines, grant = grantSource()) {
  for (const raw of lines) {
    let entry;
    try { entry = JSON.parse(raw); } catch { return null; }
    if (entry?.type !== 'user' || entry.isMeta === true || entry.toolUseResult !== undefined) continue;
    if (Array.isArray(entry.message?.content) && entry.message.content.some(c => c?.type === 'tool_result')) continue;
    const found = buzzEventOf(entry);
    return found && grant.ok && grant.approves(found.event.pubkey) ? found : null;
  }
  return null;
}

// The approver's words in a Buzz SDK prompt, bound to the session's channel and thread; null otherwise.
export function buzzHumanText(entry, root, grant = grantSource()) {
  const found = buzzEventOf(entry);
  if (!found || !root || !grant.ok || !grant.approves(found.event.pubkey)) return null;
  if (found.channel !== root.channel || found.thread !== root.thread) return null;
  const text = found.event.content.trim();
  return text ? { text, event: found.event } : null;
}

export function buzzGrantCommand(args = []) {
  const flag = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  const out = flag('--out') || defaultBuzzGrantPath();
  if (args.includes('--show')) {
    const v = loadBuzzGrant({ path: flag('--file') || out });
    console.log(v.ok ? `verdict=pass BUZZ_GRANT id=${v.grant.id} approvers=${v.grant.approvers.length} expires=${v.grant.expires_at}` : `verdict=ungraded BUZZ_GRANT code=${v.code}`);
    if (!v.ok) process.exitCode = 3;
    return;
  }
  const machine = args.includes('--this-machine') ? machineFingerprint() : flag('--machine');
  const doc = issueBuzzGrant({ approvers: String(flag('--approvers') || '').split(',').filter(Boolean), days: Number(flag('--days')), machine, note: flag('--note') ?? '' });
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(doc, null, 2) + '\n', { mode: 0o600 });
  console.log(`verdict=pass BUZZ_GRANT_ISSUED id=${doc.grant.id} approvers=${doc.grant.approvers.length} expires=${doc.grant.expires_at} path=${out}`);
}
