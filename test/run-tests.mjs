// 핵심 기능 테스트: node test/run-tests.mjs
import fs from 'fs';
import os from 'os';
import path from 'path';
import assert from 'assert/strict';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const core = require('../app/core.js');
const { PDFDocument, StandardFonts, degrees } = require('pdf-lib');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdftool-'));
async function make(name, n, opts = {}) {
  const d = await PDFDocument.create();
  const f = await d.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < n; i++) {
    const p = d.addPage([595, 842]);
    p.drawText(`${name} p${i + 1}`, { x: 50, y: 780, size: 24, font: f });
    if (opts.rotate) p.setRotation(degrees(opts.rotate));
  }
  const fp = path.join(dir, `${name}.pdf`);
  fs.writeFileSync(fp, await d.save());
  return fp;
}
let pass = 0;
const t = async (name, fn) => { await fn(); pass++; console.log('✓', name); };

const a = await make('A', 3), b = await make('B', 2), r = await make('R', 1, { rotate: 90 });

await t('합치기 전체', async () => {
  const out = path.join(dir, 'm.pdf');
  const res = await core.merge([{ path: a }, { path: b }], out);
  assert.equal(res.pages, 5);
  assert.equal((await PDFDocument.load(fs.readFileSync(out))).getPageCount(), 5);
});
await t('합치기 쪽 지정', async () => {
  const out = path.join(dir, 'm2.pdf');
  const res = await core.merge([{ path: a, pages: [2, 0] }, { path: b }], out);
  assert.equal(res.pages, 4);
});
await t('범위 해석', async () => {
  assert.deepEqual(core.parseRanges('1-2, 3', 3), [[0, 1], [2]]);
  assert.deepEqual(core.parseRanges('2-', 3), [[1, 2]]);
  assert.deepEqual(core.parseRanges('-2', 3), [[0, 1]]);
  assert.deepEqual(core.parseRanges('1~3', 3), [[0, 1, 2]]);
  assert.throws(() => core.parseRanges('4', 3), core.PdfError);
  assert.throws(() => core.parseRanges('3-1', 3), core.PdfError);
  assert.throws(() => core.parseRanges('가', 3), core.PdfError);
  assert.throws(() => core.parseRanges('', 3), core.PdfError);
});
await t('나누기 + 같은 이름 피하기', async () => {
  const sd = path.join(dir, 'split'); fs.mkdirSync(sd);
  const w = await core.split(a, [[0], [1, 2]], sd);
  assert.deepEqual(w.map((x) => path.basename(x)), ['A_1쪽.pdf', 'A_2-3쪽.pdf']);
  const w2 = await core.split(a, [[0]], sd);
  assert.equal(path.basename(w2[0]), 'A_1쪽(2).pdf');
  assert.equal((await PDFDocument.load(fs.readFileSync(w[1]))).getPageCount(), 2);
});
await t('서명 넣기(회전 쪽 포함)', async () => {
  const png = fs.readFileSync('app/icon.png');
  const out = path.join(dir, 's.pdf');
  await core.sign(r, [{ page: 0, png, x: 100, y: 100, width: 80, height: 80, rotate: 90 }], out);
  const d = await PDFDocument.load(fs.readFileSync(out));
  assert.equal(d.getPage(0).getRotation().angle, 90);
  assert.ok(fs.statSync(out).size > fs.statSync(r).size);
});
await t('암호 PDF 안내', async () => {
  const fp = path.join(dir, 'enc.pdf');
  // 암호화 사전이 있는 최소 PDF
  const d = await PDFDocument.create(); d.addPage();
  let s = Buffer.from(await d.save({ useObjectStreams: false })).toString('latin1');
  s = s.replace('trailer\n<<', 'trailer\n<<\n/Encrypt << /Filter /Standard /V 1 /R 2 /O <00> /U <00> /P -4 >>');
  fs.writeFileSync(fp, Buffer.from(s, 'latin1'));
  await assert.rejects(core.pageCount(fp), (e) => e instanceof core.PdfError && /암호/.test(e.message));
});
await t('PDF 아닌 파일', async () => {
  const fp = path.join(dir, 'x.pdf'); fs.writeFileSync(fp, 'hello');
  await assert.rejects(core.pageCount(fp), core.PdfError);
});
// ── PDF 종합툴에서 가져온 기능 ──
const pages = async (fp) => (await PDFDocument.load(fs.readFileSync(fp))).getPages();
await t('쪽 모음 해석(비우면 전체·끝·겹침)', async () => {
  assert.deepEqual(core.parsePages('', 3), [0, 1, 2]);
  assert.deepEqual(core.parsePages('3, 1~2, 2', 5), [0, 1, 2]);
  assert.deepEqual(core.parsePages('4-끝', 5), [3, 4]);
  assert.deepEqual(core.parsePages('3~1', 5), [0, 1, 2]);
  assert.throws(() => core.parsePages('9', 5), core.PdfError);
});
await t('합치기에 그림 넣기(A4 맞춤·원본 크기)', async () => {
  const out = path.join(dir, 'mi.pdf');
  await core.merge([{ path: a, pages: [0] }, { path: 'app/icon.png', kind: 'img' }], out);
  const p = await pages(out);
  assert.equal(p.length, 2);
  assert.deepEqual([Math.round(p[1].getWidth()), Math.round(p[1].getHeight())], [595, 842]);
  const out2 = path.join(dir, 'mi2.pdf');
  await core.merge([{ path: 'app/icon.png', kind: 'img' }], out2, { imageFit: 'orig' });
  // 원본 크기: 96dpi 기준 → 픽셀 × 0.75pt
  assert.equal((await pages(out2))[0].getWidth(), fs.readFileSync("app/icon.png").readUInt32BE(16) * 0.75);
});
await t('범위 나누기에 파일 이름 붙이기', async () => {
  const sd = path.join(dir, 'named'); fs.mkdirSync(sd);
  const w = await core.split(a, [[0], [1, 2]], sd, ['표지', '본문.pdf']);
  assert.deepEqual(w.map((x) => path.basename(x)), ['표지.pdf', '본문.pdf']);
});
await t('쪽 회전(지금 방향에서 더)', async () => {
  const out = path.join(dir, 'rot.pdf');
  await core.rotate(r, [0], 90, out);
  assert.deepEqual((await pages(out)).map((p) => p.getRotation().angle), [180]);
});
await t('쪽 정리(순서·회전·삭제)', async () => {
  const out = path.join(dir, 'org.pdf');
  await core.organize(a, [{ p: 2, rot: 0 }, { p: 0, rot: 270 }], out);
  const p = await pages(out);
  assert.equal(p.length, 2);
  assert.equal(p[1].getRotation().angle, 270);
});
await t('쪽번호·워터마크(돌아간 쪽 포함)', async () => {
  const out = path.join(dir, 'st.pdf');
  await core.stamp(r, { num: { fmt: 'n/t', pos: 'bc', start: 1, size: 11 }, wm: { png: fs.readFileSync('app/icon.png') } }, out);
  assert.ok(fs.statSync(out).size > fs.statSync(r).size);
  await assert.rejects(core.stamp(r, {}, out), core.PdfError);
});
await t('두 쪽 모아찍기 나누기(범위 밖은 그대로, 회전 고려)', async () => {
  const wide = await make('W', 3);
  const out = path.join(dir, 'us.pdf');
  const res = await core.unspread(wide, [1, 2], 'lr', false, out);
  assert.equal(res.pages, 5);
  const p = await pages(out);
  assert.equal(Math.round(p[0].getWidth()), 595);
  assert.equal(Math.round(p[1].getWidth()), 298);
  assert.equal(Math.round(p[2].getMediaBox().x), 298);
  // 90° 돌아간 쪽: 보이는 왼쪽 = PDF 아래 반
  const out2 = path.join(dir, 'us2.pdf');
  await core.unspread(r, [0], 'lr', false, out2);
  const q = await pages(out2);
  assert.deepEqual([Math.round(q[0].getMediaBox().y), Math.round(q[0].getHeight())], [0, 421]);
  assert.equal(Math.round(q[1].getMediaBox().y), 421);
});
await t('영역 자르기', async () => {
  const out = path.join(dir, 'cr.pdf');
  await core.crop(a, [0, 2], { x: 50, y: 60, w: 300, h: 400 }, out);
  const p = await pages(out);
  assert.deepEqual([p[0].getWidth(), p[1].getWidth(), p[2].getHeight()], [300, 595, 400]);
});
await t('용량 줄이기 묶기(쪽 크기 유지)', async () => {
  const jpg = fs.readFileSync('test/fixtures/sample.jpg');
  const out = path.join(dir, 'cp.pdf');
  await core.fromJpegs([{ jpg, w: 842, h: 595 }, { jpg, w: 500, h: 700 }], out);
  const p = await pages(out);
  assert.deepEqual(p.map((x) => [Math.round(x.getWidth()), Math.round(x.getHeight())]), [[842, 595], [500, 700]]);
});
await t('학생별 나누기·그림 저장은 새 폴더에', async () => {
  const r1 = await core.splitNamed(a, [{ name: '10101홍길동', pages: [0, 1] }, { name: '10102김철수', pages: [2] }], dir, '학생별');
  assert.deepEqual(fs.readdirSync(r1.dir).sort(), ['10101홍길동.pdf', '10102김철수.pdf']);
  const r2 = await core.splitNamed(a, [{ name: 'x', pages: [0] }], dir, '학생별');
  assert.equal(path.basename(r2.dir), '학생별(2)');
  const r3 = await core.writeFiles(dir, 'A_이미지', [{ name: 'A_001.png', bytes: fs.readFileSync('app/icon.png') }]);
  assert.deepEqual(fs.readdirSync(r3.dir), ['A_001.png']);
  assert.throws(() => core.safeName('con'), core.PdfError);
});
console.log(`\n${pass}개 통과`);
