import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fail, parseFlags, runEntrypoint, stableJson } from './lib/core.mjs';
import { prepareBoardReview, attestBoardReview, verifyBoardReview, checkBoardQuality, boardReviewPrepareCode, dispatchBoardReviewClaude } from './lib/board-quality.mjs';
import { readJson } from './lib/core.mjs';
import { prepareBoardWrite } from './lib/board-write-admission.mjs';

export function boardQualityCommand(action, args) {
  if (action === 'prepare' || action === 'recipe') {
    const o = parseFlags(args, { '--file': {key:'file',required:true}, '--out-dir': {key:'outDir',required:true},
      '--parent-source': {key:'parentSourcePath',required:true}, '--author-source': {key:'authorSourcePath',required:true},
      '--task-name': {key:'taskName',required:true}, '--model': {key:'model',required:true}, '--effort': {key:'effort',required:true} });
    if (action === 'recipe') { console.log(boardReviewPrepareCode(o)); return; }
    const result = prepareBoardReview(o);
    console.log(`TEAMQA_NATIVE_PREPARED sha256=${result.intentSha256}`);
    console.log(stableJson(result)); return;
  }
  if (action === 'dispatch') {
    const o = parseFlags(args, { '--intent': {key:'intentPath',required:true} });
    const result = dispatchBoardReviewClaude(o);
    console.log(`TEAMQA_BOARD_REVIEW_DISPATCHED intent=${result.intentSha256} session=${result.sessionId} child=${result.childSourcePath}`);
    console.log(stableJson(result)); return;
  }
  if (action === 'attest') {
    const o = parseFlags(args, { '--intent': {key:'intentPath',required:true}, '--child-source': {key:'childSourcePath',required:true}, '--out': {key:'out',required:true} });
    const result = attestBoardReview(o); console.log(stableJson(result));
    if (result.verdict !== 'PASS') process.exitCode = 3;
    return;
  }
  if (action === 'verify') {
    const o = parseFlags(args, { '--file': {key:'file',required:true}, '--receipt': {key:'receiptPath',required:true} });
    const result = verifyBoardReview(o); console.log(stableJson({ verdict: result.verdict, canonical: result.canonical, reviewerSessionId: result.reviewerSessionId })); return;
  }
  if (action === 'inspect') {
    const o = parseFlags(args, { '--file': {key:'file',required:true} });
    console.log(stableJson(checkBoardQuality(o).result)); return;
  }
  if (action === 'write-request') {
    const o = parseFlags(args, { '--file': {key:'file',required:true}, '--payload': {key:'artifactPath',required:true},
      '--destination': {key:'destinationPath',required:true}, '--out': {key:'out',required:true} });
    const request = prepareBoardWrite({ file: o.file, artifactPath: o.artifactPath,
      destination: readJson(o.destinationPath), out: o.out });
    console.log(stableJson(request)); return;
  }
  fail(2, 'BOARD_QUALITY_COMMAND', 'inspect|recipe|prepare|dispatch|attest|verify|write-request');
}
// Compare real paths: a skill installed behind a symlink otherwise exits silently without running.
if (process.argv[1] && realpathSync(resolve(process.argv[1])) === fileURLToPath(import.meta.url)) await runEntrypoint(() => boardQualityCommand(process.argv[2], process.argv.slice(3)));
