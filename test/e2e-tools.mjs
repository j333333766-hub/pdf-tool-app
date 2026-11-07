// PDF 종합툴에서 가져온 화면 테스트: node test/e2e-tools.mjs  (스크린샷은 test/shots/t*.png)
import fs from 'fs';
import os from 'os';
import path from 'path';
import { _electron as electron } from 'playwright-core';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { PDFDocument, StandardFonts, degrees, rgb } = require('pdf-lib');
const JSZip = require('jszip');

const shots = 'test/shots'; fs.mkdirSync(shots, { recursive: true });
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdftool-tools-'));
async function make(name, n, { size = [595, 842], rotate = 0 } = {}) {
  const d = await PDFDocument.create();
  const f = await d.embedFont(StandardFonts.HelveticaBold);
  for (let i = 0; i < n; i++) {
    const p = d.addPage(size);
    p.drawRectangle({ x: 20, y: 20, width: size[0] - 40, height: size[1] - 40, borderColor: rgb(0.6, 0.6, 0.6), borderWidth: 2 });
    p.drawText(`${name} p${i + 1}`, { x: 50, y: size[1] - 80, size: 30, font: f });
    if (size[0] > size[1]) {
      p.drawText('LEFT', { x: size[0] / 4 - 30, y: size[1] / 2, size: 30, font: f });
      p.drawText('RIGHT', { x: (3 * size[0]) / 4 - 40, y: size[1] / 2, size: 30, font: f });
    }
    if (rotate) p.setRotation(degrees(rotate));
  }
  const fp = path.join(dir, `${name}.pdf`);
  fs.writeFileSync(fp, await d.save());
  return fp;
}
const A = await make('Doc A', 4);
const W = await make('Wide', 3, { size: [842, 595] });
const load = async (fp) => PDFDocument.load(fs.readFileSync(fp));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const check = (label, ok, extra = '') => console.log(`${ok ? '✓' : '✗'} ${label}${extra ? ` — ${extra}` : ''}`);

// 학생 명렬표: 샘플 양식의 시트에 1학년 1반 4명 + 1학년 2반 1명
const zip = await JSZip.loadAsync(fs.readFileSync('app/assets/roster-sample.xlsx'));
const cell = (r, c, v) => `<c r="${c}${r}" t="inlineStr"><is><t>${v}</t></is></c>`;
const rows = [['학년', '반', '번호', '이름'], [1, 1, 1, '홍길동'], [1, 1, 2, '김철수'], [1, 1, 3, '이영희'], [1, 1, 4, '박민수'], [1, 2, 1, '최다른']];
let sheet = await zip.file('xl/worksheets/sheet1.xml').async('string');
sheet = sheet.replace(/<sheetData>[\s\S]*<\/sheetData>|<sheetData\/>/, `<sheetData>${rows.map((r, i) => `<row r="${i + 1}">${r.map((v, j) => cell(i + 1, 'ABCD'[j], v)).join('')}</row>`).join('')}</sheetData>`);
zip.file('xl/worksheets/sheet1.xml', sheet);
const rosterXlsx = path.join(dir, '명렬표.xlsx');
fs.writeFileSync(rosterXlsx, await zip.generateAsync({ type: 'nodebuffer' }));

// 설정 폴더를 따로 써서 실제 명렬표·서명을 건드리지 않는다
const app = await electron.launch({ args: ['.', `--user-data-dir=${path.join(dir, 'userdata')}`] });
const win = await app.firstWindow();
await win.setViewportSize({ width: 1280, height: 860 });
await sleep(1200);
// 파일 열기·저장 대화상자 대신 정해 둔 경로를 돌려준다
const nextOpen = (paths) => app.evaluate(({ dialog }, p) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: p }); }, paths);
const nextSave = (p) => app.evaluate(({ dialog }, f) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: f }); }, p);
const tab = (t) => win.click(`.tab[data-tab=${t}]`);
const openIn = async (p, file) => { await nextOpen([file]); await win.click(`#${p}Open`); await sleep(1200); };
const waitFile = async (f, ms = 30000) => { const t = Date.now(); while (!fs.existsSync(f)) { if (Date.now() - t > ms) return false; await sleep(200); } await sleep(400); return true; };
win.on('dialog', (d) => d.accept()); // confirm()

// 1) 합치기 + 그림
await tab('merge');
await nextOpen([A, path.resolve('test/fixtures/sample.jpg'), path.resolve('app/icon.png')]);
await win.click('#mAdd');
await sleep(800);
let out = path.join(dir, 'merged.pdf');
await nextSave(out);
await win.click('#mRun');
check('합치기 + 그림 2장', await waitFile(out) && (await load(out)).getPageCount() === 6, `${(await load(out)).getPageCount()}쪽`);
await win.screenshot({ path: `${shots}/t1-merge-images.png` });

// 2) 나누기: 범위 · 파일 이름 표 (엑셀 붙여넣기 흉내)
await tab('split');
await openIn('s', A);
await win.check('input[name=sMode][value=named]');
await win.locator('#sNamedRows .rg').first().click();
await win.evaluate(() => {
  const dt = new DataTransfer(); dt.setData('text', '1~2\t앞부분\n3, 4\t뒷부분');
  document.querySelector('#sNamedRows .rg').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true }));
});
await sleep(600);
console.log('  나누기 미리보기:', (await win.textContent('#sPreview')).replace(/\n/g, ' / '));
await win.click('#sRun');
check('나누기 표 → 이름 붙은 파일', await waitFile(path.join(dir, '뒷부분.pdf')) && (await load(path.join(dir, '앞부분.pdf'))).getPageCount() === 2);
await win.screenshot({ path: `${shots}/t2-split-named.png` });

// 3) 평가지 학생별 분할
await tab('essay');
await nextOpen([rosterXlsx]);
await win.click('#eRosterLoad');
await sleep(1000);
console.log('  명렬표:', await win.textContent('#eRosterInfo'));
await win.fill('#ePps', '1');
await openIn('e', A);
console.log('  요약:', (await win.textContent('#eSummary')).replace(/\n/g, ' / '));
const enabled4 = !(await win.isDisabled('#eRun'));
await win.locator('#eRows tr').nth(1).locator('.absent').check();
const disabledAbsent = await win.isDisabled('#eRun');
await win.click('#eAddRow');
await win.locator('#eRows tr').last().locator('.n').fill('9');
await win.locator('#eRows tr').last().locator('.nm').fill('전학생');
await sleep(300);
console.log('  결시 1 + 추가 1:', (await win.textContent('#eSummary')).replace(/\n/g, ' / '));
await win.screenshot({ path: `${shots}/t3-essay.png` });
await win.click('#eRun');
const sdir = path.join(dir, 'Doc A_학생별');
await waitFile(sdir);
await sleep(800);
const made = fs.existsSync(sdir) ? fs.readdirSync(sdir).sort() : [];
check('학생별 분할(결시 제외·추가 응시자)', enabled4 && disabledAbsent && made.join(',') === '10101홍길동.pdf,10103이영희.pdf,10104박민수.pdf,10109전학생.pdf', made.join(', '));
const kept = fs.existsSync(path.join(dir, 'userdata', 'roster.json'));
check('명렬표 보관(앱 설정 폴더)', kept);

// 4) 쪽 정리: 2쪽 지우기, 첫 쪽 돌리기, 순서 뒤집기
await tab('organize');
await openIn('o', A);
await sleep(800);
await win.locator('#oGrid .thumb').nth(1).locator('[data-a=del]').click();
await win.locator('#oGrid .thumb').nth(0).locator('[data-a=rot]').click();
await win.click('#oReverse');
await sleep(500);
await win.screenshot({ path: `${shots}/t4-organize.png` });
out = path.join(dir, 'organized.pdf');
await nextSave(out);
await win.click('#oRun');
if (await waitFile(out)) {
  const p = (await load(out)).getPages();
  check('쪽 정리', p.length === 3 && p[2].getRotation().angle === 90, `${p.length}쪽, 마지막 쪽 ${p[2].getRotation().angle}°`);
} else check('쪽 정리', false, '파일 없음');

// 5) 쪽 회전: 2~4 중 짝수 → 2, 4쪽
await tab('rotate');
await openIn('r', A);
await win.fill('#rRange', '2~4');
await win.check('input[name=rParity][value=even]');
await sleep(800);
await win.screenshot({ path: `${shots}/t5-rotate.png` });
out = path.join(dir, 'rotated.pdf');
await nextSave(out);
await win.click('#rRun');
if (await waitFile(out)) {
  const a = (await load(out)).getPages().map((p) => p.getRotation().angle);
  check('쪽 회전(짝수만)', a.join() === '0,90,0,90', a.join());
} else check('쪽 회전', false);

// 6) 두 쪽 → 한 쪽씩: 2~끝
await tab('unspread');
await openIn('u', W);
await win.fill('#uRange', '2~끝');
await win.click('#uNext');
await sleep(900);
await win.screenshot({ path: `${shots}/t6-unspread.png` });
out = path.join(dir, 'unspread.pdf');
await nextSave(out);
await win.click('#uRun');
if (await waitFile(out)) {
  const p = (await load(out)).getPages();
  check('두 쪽 → 한 쪽씩', p.length === 5 && Math.round(p[1].getWidth()) === 421, p.map((x) => Math.round(x.getWidth())).join(','));
} else check('두 쪽 → 한 쪽씩', false);

// 7) 영역 자르기: 오른쪽 아래 모서리를 끌어 줄이고, 홀수 쪽만
await tab('crop');
await openIn('c', A);
await sleep(600);
const se = await win.locator('#cRect i[data-hd=se]').boundingBox();
await win.mouse.move(se.x + 7, se.y + 7);
await win.mouse.down();
await win.mouse.move(se.x - 150, se.y - 200, { steps: 8 });
await win.mouse.up();
const box0 = await win.locator('#cRect').boundingBox();
await win.mouse.move(box0.x + box0.width / 2, box0.y + box0.height / 2);
await win.mouse.down();
await win.mouse.move(box0.x + box0.width / 2 + 20, box0.y + box0.height / 2 + 15, { steps: 5 });
await win.mouse.up();
const box1 = await win.locator('#cRect').boundingBox();
check('자르기 상자 옮기기(크기 그대로)', Math.abs(box1.width - box0.width) < 1 && Math.abs(box1.height - box0.height) < 1);
await win.check('input[name=cParity][value=odd]');
await sleep(400);
console.log('  자르기:', await win.textContent('#cDim'), '/', await win.textContent('#cNote'));
await win.screenshot({ path: `${shots}/t7-crop.png` });
out = path.join(dir, 'cropped.pdf');
await nextSave(out);
await win.click('#cRun');
if (await waitFile(out)) {
  const p = (await load(out)).getPages().map((x) => Math.round(x.getWidth()));
  check('영역 자르기(홀수 쪽만)', p[0] < 595 && p[1] === 595 && p[2] === p[0], p.join(','));
} else check('영역 자르기', false);

// 8) 쪽번호 · 워터마크
await tab('stamp');
await openIn('t', A);
await win.fill('#tWm', '배포금지');
out = path.join(dir, 'stamped.pdf');
await nextSave(out);
await win.click('#tRun');
check('쪽번호·워터마크', await waitFile(out) && fs.statSync(out).size > fs.statSync(A).size + 1000, `${fs.statSync(A).size} → ${fs.existsSync(out) ? fs.statSync(out).size : 0}바이트`);

// 9) 용량 줄이기 (쪽 크기 유지)
await tab('compress');
await openIn('z', W);
await win.fill('#zRange', '9');
await win.dispatchEvent('#zRange', 'input');
out = path.join(dir, 'small.pdf');
await nextSave(out);
await win.click('#zRun');
if (await waitFile(out, 60000)) {
  const p = (await load(out)).getPages();
  check('용량 줄이기', p.length === 3 && Math.round(p[0].getWidth()) === 842, (await win.textContent('#zNote')).replace(/\n/g, ' '));
} else check('용량 줄이기', false);
await win.screenshot({ path: `${shots}/t9-compress.png` });

// 10) PDF → 그림 (1, 3쪽 PNG)
await tab('toimage');
await openIn('i', A);
await win.fill('#iRange', '1, 3');
await sleep(300);
await win.click('#iRun');
const idir = path.join(dir, 'Doc A_그림');
await waitFile(idir);
await sleep(1500);
const imgs = fs.existsSync(idir) ? fs.readdirSync(idir) : [];
check('PDF → 그림', imgs.join(',') === 'Doc A_001.png,Doc A_003.png', imgs.join(', '));

await app.close();
console.log('작업 폴더:', dir);
