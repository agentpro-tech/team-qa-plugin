import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { renderAnnotatedPng } from '../scripts/loop8/annotation-renderer.mjs';

const execFileAsync = promisify(execFile);

test('V8.2 keeps a DPR=1 narrow legend inside the appended panel', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'qa-gui-loop8-narrow-'));
  const inputPath = path.join(directory, 'capture.png');
  const outputPath = path.join(directory, 'capture.annotated.png');

  await execFileAsync('magick', [
    '-size', '320x740', 'xc:#F2F4F7',
    '-strip', '-define', 'png:exclude-chunk=date,time', inputPath,
  ]);
  await renderAnnotatedPng({
    inputPath,
    outputPath,
    findings: [{
      rule: 'unintended-text-overflow',
      severity: 'high',
      selector: '#support-link',
      caption: 'Liên kết #support-link tràn 9 CSS px sang phải (317 so với 308), làm nội dung vượt khỏi thẻ đăng nhập ở cỡ 320 × 740. Thu gọn chiều rộng theo khối cha hoặc cho phép nội dung xuống dòng.',
      language: 'vi',
      bbox: { x: 29, y: 337.046875, width: 288, height: 44, dpr: 1, unit: 'css-px' },
    }],
  });

  const { stdout: heightText } = await execFileAsync('magick', [outputPath, '-format', '%h', 'info:']);
  const panelInnerHeight = Number(heightText) - 744;
  assert.ok(panelInnerHeight > 0, 'the annotated image must append a legend panel');

  const { stdout: edgeMeanText } = await execFileAsync('magick', [
    outputPath,
    '-crop', `4x${panelInnerHeight}+314+742`, '+repage',
    '-fuzz', '2%', '-transparent', 'white', '-alpha', 'extract',
    '-format', '%[fx:mean]', 'info:',
  ]);
  const edgeMean = Number(edgeMeanText);
  assert.ok(
    edgeMean < 0.001,
    `legend copy reaches the right clipping strip (non-white mean ${edgeMean})`,
  );
});
