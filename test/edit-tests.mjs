// 글자·그림 편집 엔진 테스트: node test/edit-tests.mjs  (한글 문서에서 만든 PDF가 있으면 그것도 씀)
import fs from 'fs';
import os from 'os';
import path from 'path';
import assert from 'assert/strict';
import * as mupdf from 'mupdf';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const ed = require('../app/pdfedit.js');
const { PDFDocument, StandardFonts, degrees } = require('pdf-lib');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdftool-edit-'));
let pass = 0;
const t = async (name, fn) => { const t0 = Date.now(); await fn(); pass++; console.log('✓', name, `(${Date.now() - t0}ms)`); };
const textOf = (file, p = 0) => {
  const d = mupdf.Document.openDocument(fs.readFileSync(file), 'application/pdf');
  const s = d.loadPage(p).toStructuredText('preserve-whitespace').asText();
  d.destroy();
  return s;
};

// 시험 문서: 1쪽 글자 3줄 + 그림, 2쪽은 90° 돌아간 쪽
const src = path.join(dir, 'sample.pdf');
{
  const d = await PDFDocument.create();
  const f = await d.embedFont(StandardFonts.Helvetica);
  const p = d.addPage([595, 842]);
  p.drawText('First line keep', { x: 60, y: 760, size: 14, font: f });
  p.drawText('Second line EDIT ME', { x: 60, y: 730, size: 14, font: f });
  p.drawText('Third line keep', { x: 60, y: 700, size: 14, font: f });
  const png = await d.embedPng(fs.readFileSync('app/icon.png'));
  p.drawImage(png, { x: 300, y: 400, width: 120, height: 120 });
  const q = d.addPage([595, 842]);
  q.drawText('Rotated page text', { x: 60, y: 760, size: 14, font: f });
  q.setRotation(degrees(90));
  fs.writeFileSync(src, await d.save());
}

await t('열기·쪽 정보(줄·그림 위치)', async () => {
  const r = await ed.open(src);
  assert.equal(r.pages, 2);
  assert.ok(r.fonts.some((f) => f.key === 'gothic'));
  const info = await ed.pageInfo(0, 1);
  assert.deepEqual(info.lines.map((l) => l.text), ['First line keep', 'Second line EDIT ME', 'Third line keep']);
  assert.equal(info.images.length, 1);
  const [x0, y0, x1, y1] = info.images[0].bbox.map(Math.round);
  assert.deepEqual([x0, y0, x1, y1], [300, 322, 420, 442]);
  assert.ok(info.png.length > 1000);
});
await t('줄 고치기(원래 글자는 실제로 사라짐, 이웃 줄은 그대로)', async () => {
  const line = (await ed.pageInfo(0, 1)).lines[1];
  await ed.apply({ type: 'text', page: 0, ...line, text: '둘째 줄을 고쳤습니다' });
  const out = path.join(dir, 'e1.pdf');
  await ed.save(out);
  const s = textOf(out);
  assert.ok(!s.includes('EDIT ME'));
  assert.ok(s.includes('둘째 줄을 고쳤습니다'));
  assert.ok(s.includes('First line keep') && s.includes('Third line keep'));
  // 새 줄이 같은 자리에 있는지
  const nl = (await ed.pageInfo(0, 1)).lines.find((l) => l.text.includes('둘째'));
  assert.ok(Math.abs(nl.origin[1] - line.origin[1]) < 1 && Math.abs(nl.origin[0] - line.origin[0]) < 1);
});
await t('글꼴에 없는 글자: 한글 가운뎃점(U+2024) → ·, 나머지는 다른 글꼴에서', async () => {
  ed.undo();
  await ed.apply({ type: 'addText', page: 0, x: 60, y: 300, size: 12, color: [0, 0, 0], text: '수집․이용 ★ ①', fontKey: 'gothic' });
  const l = (await ed.pageInfo(0, 1)).lines.find((x) => x.text.includes('수집'));
  assert.ok(l && l.text.includes('수집·이용') && l.text.includes('★'), l && l.text);
  ed.undo();
  // 앞 테스트의 줄 고치기를 다시 해 둔다(되돌리기 테스트용)
  const line = (await ed.pageInfo(0, 1)).lines[1];
  await ed.apply({ type: 'text', page: 0, ...line, text: '둘째 줄을 고쳤습니다' });
});
await t('되돌리기', async () => {
  const r = ed.undo();
  assert.equal(r.canUndo, false);
  assert.ok((await ed.pageInfo(0, 1)).lines.some((l) => l.text.includes('EDIT ME')));
});
await t('글상자 넣기(여러 줄, 함초롬바탕 있으면 그 글꼴)', async () => {
  const fonts = ed.availableFonts();
  const key = fonts.some((f) => f.key === 'batang') ? 'batang' : 'gothic';
  await ed.apply({ type: 'addText', page: 0, x: 60, y: 200, size: 12, color: [0, 0, 1], text: '새 글상자\n둘째 줄', fontKey: key });
  const ls = (await ed.pageInfo(0, 1)).lines.filter((l) => /새 글상자|둘째 줄/.test(l.text));
  assert.equal(ls.length, 2);
  assert.ok(ls[1].origin[1] > ls[0].origin[1] + 12);
  console.log('   글꼴:', key, ls[0].font);
});
await t('그림 옮기기', async () => {
  await ed.apply({ type: 'moveImage', page: 0, index: 0, rect: [100, 500, 200, 600] });
  const imgs = (await ed.pageInfo(0, 1)).images;
  assert.equal(imgs.length, 1);
  assert.deepEqual(imgs[0].bbox.map(Math.round), [100, 500, 200, 600]);
});
await t('그림 바꾸기(상자 안에 비율 맞춰)', async () => {
  await ed.apply({ type: 'replaceImage', page: 0, index: 0, file: 'test/fixtures/sample.jpg' });
  const b = (await ed.pageInfo(0, 1)).images[0].bbox;
  // 40×30 그림 → 100×75, 가운데
  assert.deepEqual(b.map(Math.round), [100, 513, 200, 588]);
});
await t('그림 지우기', async () => {
  await ed.apply({ type: 'deleteImage', page: 0, index: 0 });
  assert.equal((await ed.pageInfo(0, 1)).images.length, 0);
});
await t('그림 넣기', async () => {
  await ed.apply({ type: 'addImage', page: 0, rect: [300, 300, 400, 400], file: 'app/icon.png' });
  assert.equal((await ed.pageInfo(0, 1)).images.length, 1);
});
await t('영역 지우기(글자·그림)', async () => {
  await ed.apply({ type: 'deleteArea', page: 0, rect: [40, 60, 300, 100] }); // 첫 줄 자리
  const info = await ed.pageInfo(0, 1);
  assert.ok(!info.lines.some((l) => l.text.includes('First line')));
  assert.ok(info.lines.some((l) => l.text.includes('Third line keep')));
});
await t('돌아간 쪽에서 고친 글자도 똑바로', async () => {
  const line = (await ed.pageInfo(1, 1)).lines[0];
  await ed.apply({ type: 'text', page: 1, ...line, text: '돌아간 쪽 고침' });
  const nl = (await ed.pageInfo(1, 1)).lines.find((l) => l.text.includes('고침'));
  assert.ok(nl, '새 줄 없음');
  assert.ok(Math.abs(nl.origin[1] - line.origin[1]) < 1, `기준선 ${nl.origin[1]} vs ${line.origin[1]}`);
  // 화면에서 가로로 쓰였는지: 줄 상자가 높이보다 넓다
  assert.ok(nl.bbox[2] - nl.bbox[0] > nl.bbox[3] - nl.bbox[1]);
});

// 한글 문서에서 만든 PDF가 있으면 실제 문서로도
const real = process.argv[2];
if (real && fs.existsSync(real)) {
  await t(`실제 문서: ${path.basename(real)}`, async () => {
    await ed.open(real);
    const info = await ed.pageInfo(0, 1);
    const line = info.lines.find((l) => /[가-힣]{4,}/.test(l.text));
    console.log('   고칠 줄:', line.text, '|', line.font, line.size, '→', line.fontKey);
    await ed.apply({ type: 'text', page: 0, ...line, text: line.text.replace(/[가-힣]{2}/, '수정') });
    const out = path.join(dir, 'real-edited.pdf');
    await ed.save(out);
    const before = fs.statSync(real).size, after = fs.statSync(out).size;
    console.log(`   용량 ${before} → ${after}`);
    assert.ok(textOf(out).includes(line.text.replace(/[가-힣]{2}/, '수정').replace(/․/g, '·')));
    const d = mupdf.Document.openDocument(fs.readFileSync(out), 'application/pdf');
    fs.writeFileSync(path.join(dir, 'real-edited.png'), d.loadPage(0).toPixmap(mupdf.Matrix.scale(1.2, 1.2), mupdf.ColorSpace.DeviceRGB, false, true).asPNG());
  });
}
console.log(`\n${pass}개 통과 · ${dir}`);
