// 글자·그림 편집 화면 테스트: node test/e2e-edit.mjs <PDF>  (스크린샷 test/shots/d*.png)
import fs from 'fs';
import os from 'os';
import path from 'path';
import * as mupdf from 'mupdf';
import { _electron as electron } from 'playwright-core';

const src = path.resolve(process.argv[2]);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdftool-edit-e2e-'));
const shots = 'test/shots'; fs.mkdirSync(shots, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const check = (label, ok, extra = '') => console.log(`${ok ? '✓' : '✗'} ${label}${extra ? ` — ${extra}` : ''}`);

// PDFTOOL_EXE=dist/win-unpacked/PdfTool.exe 로 설치본 그대로 시험할 수 있다
const exe = process.env.PDFTOOL_EXE;
const app = await electron.launch(exe ? { executablePath: path.resolve(exe), args: [`--user-data-dir=${path.join(dir, 'ud')}`] } : { args: ['.', `--user-data-dir=${path.join(dir, 'ud')}`] });
const win = await app.firstWindow();
await win.setViewportSize({ width: 1360, height: 900 });
await sleep(1200);
const out = path.join(dir, 'edited.pdf');
await app.evaluate(({ dialog }, [s, o]) => {
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [s] });
  dialog.showSaveDialog = async () => ({ canceled: false, filePath: o });
}, [src, out]);
const idle = async () => { await sleep(200); while (await win.isVisible('#busy')) await sleep(100); await sleep(400); };
const titles = () => win.$$eval('#dLayer .ln', (els) => els.map((e) => e.title));

await win.click('.tab[data-tab=edit]');
await win.click('#dOpen');
await idle();
await win.click('#dNext'); // 줄이 많은 2쪽에서
await idle();
const before = await titles();
console.log(`  1쪽 줄 ${before.length}개, 그림 ${await win.locator('#dLayer .im').count()}개`);
await win.screenshot({ path: `${shots}/d1-open.png` });

// 1) 한글 줄 하나 고치기
const idx = before.findIndex((t) => /[가-힣]{3,}/.test(t));
const orig = before[idx];
await win.locator('#dLayer .ln').nth(idx).click();
await sleep(300);
await win.screenshot({ path: `${shots}/d2-editing.png` });
await win.fill('.edit-box textarea', '이 줄을 고쳤습니다');
await win.press('.edit-box textarea', 'Enter');
await idle();
const after1 = await titles();
check('줄 고치기', after1.includes('이 줄을 고쳤습니다') && !after1.includes(orig), `"${orig}" → 고침`);
await win.screenshot({ path: `${shots}/d3-edited.png` });

// 2) 글상자 넣기
await win.click('#dModes [data-m=text]');
await win.fill('#dSize', '16');
await win.fill('#dColor', '#c01818');
const img = await win.locator('#dImg').boundingBox();
await win.mouse.click(img.x + img.width * 0.55, img.y + img.height * 0.08);
await sleep(300);
await win.keyboard.type('새로 넣은 글상자');
await win.keyboard.press('Enter');
await idle();
check('글상자 넣기', (await titles()).includes('새로 넣은 글상자'));

// 3) 그림 넣기 → 옮기기
await app.evaluate(({ dialog }, f) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [f] }); }, path.resolve('app/icon.png'));
const nImg = await win.locator('#dLayer .im').count();
await win.click('#dModes [data-m=image]');
await win.mouse.click(img.x + img.width * 0.75, img.y + img.height * 0.75);
await idle();
check('그림 넣기', (await win.locator('#dLayer .im').count()) === nImg + 1);
await win.click('#dModes [data-m=select]');
if (await win.locator('#dLayer .im').count()) {
  const im = win.locator('#dLayer .im').last();
  const b0 = await im.boundingBox();
  await im.click({ position: { x: 5, y: 5 } });
  await sleep(300);
  const sel = await win.locator('.sel-img').boundingBox();
  await win.mouse.move(sel.x + sel.width / 2, sel.y + sel.height / 2);
  await win.mouse.down();
  await win.mouse.move(sel.x + sel.width / 2 + 60, sel.y + sel.height / 2 + 40, { steps: 6 });
  await win.mouse.up();
  await win.screenshot({ path: `${shots}/d4-image-move.png` });
  await win.click('.float-bar button:has-text("여기에 두기")');
  await idle();
  const b1 = await win.locator('#dLayer .im').last().boundingBox();
  check('그림 옮기기', Math.abs(b1.x - b0.x - 60) < 3 && Math.abs(b1.y - b0.y - 40) < 3, `(${Math.round(b1.x - b0.x)}, ${Math.round(b1.y - b0.y)})px 이동`);
}

// 4) 영역 지우기: 고친 줄 아래 줄 하나를 덮는 상자
await win.click('#dModes [data-m=erase]');
const target = (await titles()).find((t, i, a) => /[가-힣]{3,}/.test(t) && t !== '이 줄을 고쳤습니다' && t !== '새로 넣은 글상자');
const tb = await win.locator(`#dLayer .ln[title="${target.replace(/"/g, '\\"')}"]`).first().boundingBox();
await win.mouse.move(tb.x - 3, tb.y - 2);
await win.mouse.down();
await win.mouse.move(tb.x + tb.width + 3, tb.y + tb.height + 2, { steps: 6 });
await win.mouse.up();
await sleep(200);
await win.screenshot({ path: `${shots}/d5-erase.png` });
await win.click('.float-bar button:has-text("이 부분 지우기")');
await idle();
check('영역 지우기', !(await titles()).includes(target), `"${target.slice(0, 20)}" 지움`);

// 5) 되돌리기(Ctrl+Z) → 지운 줄이 돌아옴
await win.click('#dName');
await win.keyboard.press('Control+z');
await idle();
check('되돌리기', (await titles()).includes(target));

// 6) 저장 → 다른 프로그램(MuPDF)으로 다시 열어 확인
await win.click('#dRun');
await idle();
const d = mupdf.Document.openDocument(fs.readFileSync(out), 'application/pdf');
const text = d.loadPage(1).toStructuredText('preserve-whitespace').asText();
fs.writeFileSync(path.join(shots, 'd6-saved-page2.png'), d.loadPage(1).toPixmap(mupdf.Matrix.scale(1, 1), mupdf.ColorSpace.DeviceRGB, false, true).asPNG());
check('저장 파일', text.includes('이 줄을 고쳤습니다') && text.includes('새로 넣은 글상자') && !text.includes(orig.trim()), `${fs.statSync(src).size} → ${fs.statSync(out).size}바이트`);
await win.screenshot({ path: `${shots}/d7-after-save.png` });
await app.close();
console.log('작업 폴더:', dir);
