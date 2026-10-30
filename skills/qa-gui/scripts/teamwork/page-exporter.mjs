import crypto from 'node:crypto';

const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const inline = value => String(value ?? '').replace(/([\\`*_[\]<>])/g, '\\$1').replace(/\r?\n/g, ' ');
const prose = value => String(value ?? '').replace(/\r\n/g, '\n').replace(/([\\`*_[\]<>#])/g, '\\$1');
const json = value => inline(JSON.stringify(value));
const isRemote = value => typeof value === 'string' && /^(https:\/\/[^\s<>()[\]\\]+|(?:library-file|project-file):[^\s<>()[\]\\]+)$/.test(value);
// Pages stores individual list items as separate blocks. Collapse only their blank separators;
// exact markers, numbering, indentation and item text still participate in comparison.
const normalize = blocks => {
  const text = blocks.map(block => block.trim()).join('\n\n').replace(/\n[ \t]*\n(?:[ \t]*\n)+/g, '\n\n');
  const lines = text.split('\n');
  const listKind = line => /^([-+*]) /.test(line) ? 'unordered' : /^\d+[.)] /.test(line) ? 'ordered' : null;
  return lines.filter((line, i) => !(line === '' && listKind(lines[i - 1] || '') && listKind(lines[i - 1]) === listKind(lines[i + 1] || ''))).join('\n');
};

/** A projection only: edits continue to originate in canonical data. */
export function exportPage(data, sha256, evidenceMap = {}) {
  if (!evidenceMap || typeof evidenceMap !== 'object' || Array.isArray(evidenceMap)) throw new Error('evidence map must be an object keyed by exact canonical evidence path');
  const knownPaths = new Set([
    ...(data.evidenceManifest || []).map(e => e.path),
    ...data.cases.flatMap(c => [...(c.evidence || []), ...(c.results || []).flatMap(r => r.evidence || [])]),
    ...data.defects.flatMap(d => [...(d.evidence || []), ...(d.fixEvidence || [])].map(e => e.path)),
  ]);
  for (const [key, entry] of Object.entries(evidenceMap)) {
    if (!knownPaths.has(key)) throw new Error(`unknown canonical evidence path ${key}`);
    if (entry?.verified !== true || !isRemote(entry.reference)) throw new Error(`evidence map ${key} requires verified:true and an observed HTTPS/library-file/project-file reference`);
  }
  const vi = data.language === 'vi';
  const t = (vn, en) => vi ? vn : en;
  const evidence = path => {
    const reference = evidenceMap[path]?.reference || (isRemote(path) ? path : null);
    return reference ? `[${inline(path)}](${reference})` : `${inline(path)} — ${t('bằng chứng cục bộ chưa truy cập được trên Page; cần tải lên','local evidence unavailable on Page; upload required')}`;
  };
  const caseWork = work => {
    if (!work) return t('Chưa ghi nhận tiến độ tiếp theo.','No next-step progress recorded.');
    const lines = [
      `**${t('Tiến độ','Progress')}:** ${inline(work.state)}`,
      `**${t('Việc tiếp theo','Next action')}:** ${prose(work.nextAction)}`,
      `**${t('Còn cần kiểm tra','Remaining checks')}:** ${(work.remainingChecks || []).map(prose).join(' · ')}`,
    ];
    if (work.blocker) lines.push(`**${t('Đang chặn','Blocked')}:** ${inline(work.blocker.kind)} · ${prose(work.blocker.operation)} · ${prose(work.blocker.code)} · ${prose(work.blocker.owner)} · ${prose(work.blocker.unblockCondition)}`);
    if (work.attemptRef) lines.push(`**${t('Lần thử','Attempt')}:** ${inline(work.attemptRef)}`);
    return lines.join('\n\n');
  };
  const blocks = [];
  const add = text => blocks.push(text);
  add(`**${t('Ứng dụng','App')}:** ${inline(data.app)} · **${t('Môi trường và cơ sở dữ liệu','Environment and database')}:** ${inline(data.envDb)}

**Build:** ${inline(data.build)} · **${t('Vai trò kiểm thử','Test role')}:** ${inline(data.role)} · **${t('Hồ sơ kiểm thử','Test profile')}:** ${inline(data.testProfile)}`);
  const defect = d => {
    const c = data.cases.find(c => c.id === d.caseId);
    const handoff = d.handoff
      ? `**${t('Yêu cầu bàn giao','Handoff')} · ${inline(d.handoff.kind)}**\n\n**${t('Vấn đề','Problem')}:** ${prose(d.handoff.problem)}\n\n**${t('Đề nghị','Request')}:** ${prose(d.handoff.request)}\n\n**${t('Kết quả cần đạt','Expected outcome')}:** ${prose(d.handoff.expected)}`
      : `**${t('Thực tế','Actual')}:** ${prose(d.actual)}\n\n**${t('Mong đợi','Expected')}:** ${prose(d.expected)}`;
    add(`### ${inline(d.title)}\n\n${inline(d.id)} · ${inline(d.status)} · ${inline(d.priority)}\n\n**${t('Người phụ trách','Assignee')}:** ${inline(d.assignee)}\n\n**${t('Vị trí','Location')}:** ${inline(data.app)} · ${inline(data.envDb)} · ${inline(data.viewport)} · ${t('Ca','Case')} ${inline(d.caseId)} ${inline(c?.title)}\n\n${handoff}\n\n**${t('Bằng chứng QA','QA evidence')}:**\n\n${(d.evidence || []).map(e => `- ${inline(e.id)} · ${inline(e.role)} · ${evidence(e.path)}`).join('\n') || t('Chưa có.','None recorded.')}\n\n**${t('Các bước tái hiện','Reproduction steps')}:**\n\n${prose(d.repro)}\n\n**${t('Quan sát gốc','Observed actual')}:** ${prose(d.actual)}\n\n**${t('Kỳ vọng gốc','Product expectation')}:** ${prose(d.expected)}\n\n**${t('Bằng chứng sửa lỗi','Fix evidence')}:**\n\n${(d.fixEvidence || []).map(e => `- ${evidence(e.path)}`).join('\n') || t('Chưa có.','None recorded.')}`);
  };
  for (const [heading, matches] of [
    [t('Lỗi đang xử lý','Active defects'), d => !['RETEST','VERIFIED','CLOSED','REJECTED','DEFERRED'].includes(d.status)],
    [t('Chờ QA kiểm tra lại','Waiting for QA retest'), d => ['RETEST','VERIFIED'].includes(d.status)],
    [t('Lỗi đã giải quyết','Resolved defects'), d => ['CLOSED','REJECTED'].includes(d.status)],
    [t('Lỗi hoãn xử lý','Deferred defects'), d => d.status === 'DEFERRED'],
  ]) {
    add(`## ${heading}`);
    const entries = data.defects.filter(matches);
    if (!entries.length) add(t('Chưa có lỗi trong nhóm này.','No defects in this group.'));
    entries.forEach(defect);
  }
  add(`## ${t('Phạm vi và kết quả vòng QA','QA scope and round result')}`);
  add(`${inline(data.app)} · ${inline(data.envDb)} · ${inline(data.viewport)}\n\n${t('Kết luận phát hành','Release verdict')}: ${inline(data.release.verdict)}\n\n${(data.release.risks || []).map(r => `- ${prose(r)}`).join('\n')}\n\n${data.rounds.map(r => `- ${t('Vòng','Round')} ${r.round}: ${prose(r.scope)}`).join('\n')}`);
  add(`## ${t('Tất cả ca kiểm thử','All test cases')}`);
  for (const c of data.cases) {
    add(`### ${inline(c.title)}\n\n${inline(c.id)} · ${inline(c.status)} · ${inline(c.priority)} · Function: ${inline(c.functionVerdict)} · UI: ${inline(c.uiVerdict)}\n\n${t('Nguồn','Sources')}: ${(c.sourceRefs || []).map(inline).join(', ')}\n\n${t('Yêu cầu','Requirement')}: ${inline(c.requirement)}\n\n**${t('Các bước kiểm thử','Test steps')}:**\n\n${prose(c.steps || t('Chưa ghi nhận.','Not recorded.'))}\n\n**${t('Mong đợi','Expected')}:** ${prose(c.expected || t('Chưa ghi nhận.','Not recorded.'))}\n\n${caseWork(c.work)}\n\n**Function:** ${prose(c.humanSummary?.function)}\n\n**UI:** ${prose(c.humanSummary?.ui)}\n\n${(c.evidence || []).map(e => `- ${evidence(e)}`).join('\n')}`);
  }
  add(`## ${t('Tham chiếu kỹ thuật','Technical references')}`);
  add(`canonical sha256 ${sha256} · revision ${data.rev} · board ${inline(data.boardId)}\n\n${t('Định danh bản chạy','Run identity')}: ${json({runUuid:data.runUuid,commit:data.commit,build:data.build,env:data.env,db:data.db,role:data.role,testProfile:data.testProfile,currentRound:data.currentRound})}`);
  add(`### ${t('Nguồn yêu cầu','Source registry')}\n\n${(data.sourceItems || []).map(s => `- ${json(s)}`).join('\n') || t('Chưa có.','None recorded.')}`);
  for (const c of data.cases) {
    add(`### ${inline(c.id)} ${t('Nhật ký ca kiểm thử','Case logs')}\n\n${['assignee','requirements','machine','states','stateReceipts','work','results','comments','history'].map(k=>`- ${k}: ${json(c[k])}`).join('\n')}`);
    for (const result of c.results || []) {
      if (result.evidence?.length) add(`**${t('Bằng chứng lịch sử','Historical evidence')} · ${inline(c.id)} · ${t('Vòng','Round')} ${result.round}:**\n\n${result.evidence.map(path => `- ${evidence(path)}`).join('\n')}`);
    }
  }
  for (const d of data.defects) add(`### ${inline(d.id)} ${t('Nhật ký lỗi','Defect logs')}\n\n${['caseId','assignee','createdBy','handoff','findings','fixEvidence','lastRetestFixEvidenceCount','comments','history','rejectionReason'].map(k=>`- ${k}: ${json(d[k])}`).join('\n')}`);
  add(`### ${t('Độ bao phủ và phần chưa kiểm thử','Coverage and untested scope')}\n\n${['coverage','untested','rounds','evidenceManifest','release'].map(k=>`- ${k}: ${json(data[k])}`).join('\n')}`);
  return {protocol:'qa-gui/page-export/v1',title:data.title,initial_blocks:blocks,canonical:{boardId:data.boardId,rev:data.rev,sha256}};
}

/** Compare an independent full read_page response, never the export payload itself. */
export function comparePage(expected, snapshot) {
  const actual = snapshot?.structuredContent || snapshot;
  if (actual?.error) throw new Error('Page readback contains an error');
  if (actual?.view === 'excerpts' || actual?.block_excerpts || (actual?.selection && actual.selection.whole_page_complete !== true)) throw new Error('Page comparison requires a complete read_page snapshot');
  const content = actual?.content;
  if (!content || !Array.isArray(content.blocks) || typeof content.title !== 'string' || typeof content.page_id !== 'string') throw new Error('Page snapshot requires read_page content.title, page_id and complete blocks');
  if (!isRemote(actual?.metadata?.url) || !actual.metadata.url.startsWith('https://')) throw new Error('Page snapshot requires observed metadata.url HTTPS link');
  if (actual.metadata.page_id !== content.page_id || actual.metadata.stream_kind === 'scratch') throw new Error('Page snapshot identity or stream mismatch');
  if (content.blocks.some(b => b.kind !== 'markdown' || typeof b.markdown !== 'string' || typeof b.id !== 'string' || typeof b.hash !== 'string')) throw new Error('Page snapshot blocks must be complete native Markdown blocks with observed ids and hashes');
  const expectedMarkdown = normalize(expected.initial_blocks);
  const actualMarkdown = normalize(content.blocks.map(b => b.markdown));
  const mismatches = [];
  if (content.title !== expected.title) mismatches.push('title');
  if (actualMarkdown !== expectedMarkdown) mismatches.push('content');
  const receipt = {protocol:'qa-gui/page-readback/v1',ok:mismatches.length===0,operation:'compare-page',pageId:content.page_id,url:actual.metadata.url,canonical:expected.canonical,expectedContentSha256:digest(expectedMarkdown),actualContentSha256:digest(actualMarkdown),snapshotSha256:digest(JSON.stringify(snapshot)),matchPercent:mismatches.length===0?100:0,mismatches};
  return {...receipt,seal:digest(JSON.stringify(receipt))};
}
