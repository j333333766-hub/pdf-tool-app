// 한글 → PDF 화면 테스트: node test/e2e-hwp.mjs <한글 문서 폴더>  (한글 프로그램 필요, 스크린샷은 test/shots/)
//   폴더 안 hwp/hwpx를 사본 폴더로 복사해 쓴다. 원본 폴더에는 아무것도 만들지 않는다.
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { _electron as electron } from 'playwright-core';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { PDFDocument } = require('pdf-lib');

const srcDir = process.argv[2];
if (!srcDir) { console.error('사용법: node test/e2e-hwp.mjs <한글 문서 폴더>'); process.exit(1); }
const shots = 'test/shots'; fs.mkdirSync(shots, { recursive: true });
// 한글은 Temp 아래 일부 경로의 파일을 못 여는 일이 있어 문서 폴더에 작업 폴더를 만든다
const dir = path.join(path.dirname(path.resolve(srcDir)), `_e2e_hwp_${Date.now()}`);
fs.mkdirSync(dir);
const files = fs.readdirSync(srcDir).filter((f) => /\.hwpx?$/i.test(f)).map((f) => {
  fs.copyFileSync(path.join(srcDir, f), path.join(dir, f));
  return path.join(dir, f);
});
fs.writeFileSync(path.join(dir, '가짜 문서.hwp'), 'not a hwp');
const all = [...files, path.join(dir, '가짜 문서.hwp')];
const electronBin = require('electron');
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const waitFor = async (fn, ms = 120000) => { const t = Date.now(); while (!(await fn())) { if (Date.now() - t > ms) throw new Error('시간 초과'); await sleep(500); } };

// 1) 우클릭 'PDF로 변환' — 파일마다 따로 실행되는 상황 흉내
const app = await electron.launch({ args: ['.', '--hwp2pdf', all[0]] });
const win = await app.firstWindow();
await win.setViewportSize({ width: 1200, height: 800 });
await sleep(1200);
for (const f of all.slice(1)) spawn(electronBin, ['.', '--hwp2pdf', f], { stdio: 'ignore' });
await sleep(1500);
await win.screenshot({ path: `${shots}/h1-running.png` });
await waitFor(async () => (await win.$$eval('#hList .chip', (els) => els.every((e) => /완료|실패/.test(e.textContent)))) && !(await win.isVisible('#hStop')));
const rows = await win.$$eval('#hList li', (els) => els.map((e) => `${e.querySelector('.nm b').textContent} | ${e.querySelector('.chip').textContent} | ${e.querySelector('.nm span').textContent}`));
console.log('변환 목록:\n ' + rows.join('\n '));
await win.screenshot({ path: `${shots}/h2-done.png` });
const pdfs = fs.readdirSync(dir).filter((f) => f.endsWith('.pdf'));
console.log('원본 옆에 생긴 PDF:', pdfs);

// 2) 우클릭 'PDF로 변환해서 합치기'
const outMerge = path.join(dir, '합본.pdf');
await app.evaluate(({ dialog }, p) => { dialog.showSaveDialog = async (_w, o) => { console.log('기본 저장 경로', o.defaultPath); return { canceled: false, filePath: p }; }; }, outMerge);
// 탐색기처럼 파일마다 따로, 조금씩 늦게
for (const f of all) { spawn(electronBin, ['.', '--hwpmerge', f], { stdio: 'ignore' }); await sleep(600); }
await sleep(1000);
await win.screenshot({ path: `${shots}/h3-merge-busy.png` });
await waitFor(async () => !(await win.isVisible('#busy')) && (await win.$$('#mList li')).length > 0);
const mnames = await win.$$eval('#mList li', (els) => els.map((e) => `${e.querySelector('.nm b').textContent} (${e.querySelector('.pc').textContent})`));
console.log('합치기 목록:', mnames);
await win.screenshot({ path: `${shots}/h4-merge-list.png` });
await win.click('#mRun');
await waitFor(() => fs.existsSync(outMerge));
await sleep(500);
const expected = await Promise.all(pdfs.filter((f) => !/\(\d+\)\.pdf$/.test(f)).map(async (f) => (await PDFDocument.load(fs.readFileSync(path.join(dir, f)))).getPageCount()));
console.log('합본 쪽 수:', (await PDFDocument.load(fs.readFileSync(outMerge))).getPageCount(), '기대', expected.reduce((a, b) => a + b, 0));
console.log('남은 파일:', fs.readdirSync(dir));
await win.screenshot({ path: `${shots}/h5-merged.png` });

// 3) 우클릭 'HWPX로 변환' (hwp에만 메뉴가 있음 — hwpx를 섞어 보내도 걸러져야 함)
const before = new Set(fs.readdirSync(dir));
for (const f of all) { spawn(electronBin, ['.', '--hwp2hwpx', f], { stdio: 'ignore' }); await sleep(400); }
await sleep(1500);
await waitFor(async () => (await win.$$eval('#hList .chip', (els) => els.length > 0 && els.every((e) => /완료|실패/.test(e.textContent)))) && !(await win.isVisible('#hStop')));
console.log('HWPX 변환 목록:\n ' + (await win.$$eval('#hList li', (els) => els.map((e) => `${e.querySelector('.nm b').textContent} | ${e.querySelector('.chip').textContent} | ${e.querySelector('.nm span').textContent}`))).join('\n '));
const made = fs.readdirSync(dir).filter((f) => !before.has(f));
console.log('새로 생긴 파일:', made);
for (const f of made.filter((x) => x.endsWith('.hwpx'))) {
  const head = fs.readFileSync(path.join(dir, f)).subarray(0, 4).toString('latin1');
  console.log(' ', f, head === 'PK\u0003\u0004' ? 'ZIP 정상' : `이상(${head})`);
}
await win.screenshot({ path: `${shots}/h6-hwpx.png` });
await app.close();
console.log('작업 폴더:', dir);
