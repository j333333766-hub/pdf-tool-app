// 화면 테스트: node test/e2e.mjs  (스크린샷은 test/shots/)
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { _electron as electron } from 'playwright-core';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { PDFDocument, StandardFonts, degrees, rgb } = require('pdf-lib');

const shots = 'test/shots'; fs.mkdirSync(shots, { recursive: true });
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdftool-e2e-'));
async function make(name, n, rotate = 0) {
  const d = await PDFDocument.create();
  const f = await d.embedFont(StandardFonts.HelveticaBold);
  for (let i = 0; i < n; i++) {
    const p = d.addPage([595, 842]);
    p.drawRectangle({ x: 30, y: 30, width: 535, height: 782, borderColor: rgb(0.7, 0.7, 0.7), borderWidth: 2 });
    p.drawText(`${name} - page ${i + 1}`, { x: 60, y: 760, size: 32, font: f });
    p.drawText('SIGN HERE >', { x: 300, y: 120, size: 18, font: f });
    if (rotate) p.setRotation(degrees(rotate));
  }
  const fp = path.join(dir, `${name}.pdf`);
  fs.writeFileSync(fp, await d.save());
  return fp;
}
const a = await make('Doc A', 3), b = await make('Doc B', 2), c = await make('Doc C', 1), r = await make('Rotated', 2, 90);
const electronBin = require('electron');
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

const app = await electron.launch({ args: ['.', '--merge', b] });
const win = await app.firstWindow();
await win.setViewportSize({ width: 1200, height: 800 });
await sleep(1500);
// 우클릭으로 다른 파일들을 따로따로 실행한 상황 흉내 (두 번째 실행 → 첫 창으로 전달)
for (const f of [c, a]) spawn(electronBin, ['.', '--merge', f], { stdio: 'ignore' });
await sleep(4000);
const names = await win.$$eval('#mList li .nm b', (els) => els.map((e) => e.textContent));
console.log('합치기 목록:', names);
await win.screenshot({ path: `${shots}/1-merge.png` });

// 저장 대화상자 대신 정해진 경로를 돌려주게
const outMerge = path.join(dir, 'merged.pdf');
const outSign = path.join(dir, 'signed.pdf');
await app.evaluate(({ dialog }, paths) => {
  const q = [...paths];
  dialog.showSaveDialog = async () => ({ canceled: false, filePath: q.shift() });
}, [outMerge, outSign]);
await win.locator('#mList li', { hasText: 'Doc A.pdf' }).locator('.rg').fill('1, 3');
await win.click('#mRun');
await sleep(1500);
console.log('합친 쪽 수:', (await PDFDocument.load(fs.readFileSync(outMerge))).getPageCount(), '(기대 5 = A 2쪽 + B 2쪽 + C 1쪽)');
await win.screenshot({ path: `${shots}/2-merged-toast.png` });

// 나누기
await win.click('.tab[data-tab=split]');
await app.evaluate(({ BrowserWindow }, f) => BrowserWindow.getAllWindows()[0].webContents.send('open-files', { mode: 'split', files: [f] }), a);
await sleep(2000);
await win.click('.thumb[data-p="1"]');
await win.click('.thumb[data-p="2"]');
await sleep(400);
await win.screenshot({ path: `${shots}/3-split.png` });
console.log('나누기 미리보기:', await win.textContent('#sPreview'));
await win.click('#sRun');
await sleep(1500);
console.log('나누기 결과:', fs.readdirSync(dir).filter((n) => n.startsWith('Doc A_')));

// 서명: 패드에 그리기
await win.click('.tab[data-tab=sign]');
await win.click('#gDraw');
const box = await win.locator('#pad').boundingBox();
await win.mouse.move(box.x + 80, box.y + 200);
await win.mouse.down();
for (let i = 0; i <= 40; i++) await win.mouse.move(box.x + 80 + i * 14, box.y + 150 + Math.sin(i / 3) * 60);
await win.mouse.up();
await win.screenshot({ path: `${shots}/4-pad.png` });
await win.click('#padOk');
await sleep(800);
await app.evaluate(({ BrowserWindow }, f) => BrowserWindow.getAllWindows()[0].webContents.send('open-files', { mode: 'sign', files: [f] }), r);
await sleep(2500);
// 회전된 첫 쪽의 오른쪽 아래 쯤을 누름
const pg = await win.locator('.page[data-p="0"]').boundingBox();
await win.mouse.click(pg.x + pg.width * 0.75, pg.y + pg.height * 0.8);
await sleep(500);
await win.screenshot({ path: `${shots}/5-placed.png` });
await win.click('#gRun');
await sleep(1500);
console.log('서명 파일 크기:', fs.statSync(outSign).size);
// 결과 파일을 다시 열어 같은 자리에 찍혔는지 눈으로 확인
await app.evaluate(({ BrowserWindow }, f) => BrowserWindow.getAllWindows()[0].webContents.send('open-files', { mode: 'sign', files: [f] }), outSign);
await sleep(2500);
await win.screenshot({ path: `${shots}/6-signed-reopened.png` });
await app.close();
console.log('완료', dir);
