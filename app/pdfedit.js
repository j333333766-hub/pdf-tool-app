// PDF 글자·그림 편집 — MuPDF(AGPL)로 읽기·그리기·'실제로 지우기(redaction)', pdf-lib으로 새 글자·그림 쓰기.
// 좌표는 화면과 같은 MuPDF 쪽 좌표(왼쪽 위 원점, 아래로 +y, 쪽 회전 반영, 단위 pt)로 주고받는다.
const fs = require('fs');
const path = require('path');
const { PDFDocument, rgb, degrees } = require('pdf-lib');
const fontkit = require('@pdf-lib/fontkit');

let mupdf = null;
const lib = async () => (mupdf ||= await import('mupdf'));

class EditError extends Error {}

// 글꼴: 맑은 고딕은 윈도우에 늘 있고, 함초롬바탕·돋움은 한글 프로그램을 깔면 생긴다
const FONT_DIR = path.join(process.env.WINDIR || 'C:\\Windows', 'Fonts');
const FONTS = {
  gothic: ['malgun.ttf', 'malgunbd.ttf', '맑은 고딕'],
  batang: ['HANBatang.ttf', 'HANBatangB.ttf', '함초롬바탕'],
  dotum: ['HANDotum.ttf', 'HANDotumB.ttf', '함초롬돋움'],
};
const fontCache = new Map();
const kitCache = new Map();
// 글자가 그 글꼴에 있는지 보려고 fontkit으로 한 번 읽어 둔다
function fontKit(key, bold) {
  const data = fontBytes(key, bold);
  if (!data) return null;
  if (!kitCache.has(data)) kitCache.set(data, fontkit.create(data));
  return kitCache.get(data);
}
// 한글 문서가 가운뎃점으로 쓰는 문자 중 맑은 고딕 등에 없는 것 → 표준 가운뎃점
const CHAR_FIX = { '․': '·', '‧': '·', '・': '·' };
function fontBytes(key, bold) {
  const f = FONTS[key] || FONTS.gothic;
  const file = path.join(FONT_DIR, bold ? f[1] : f[0]);
  if (!fontCache.has(file)) {
    if (!fs.existsSync(file)) return key === 'gothic' ? null : fontBytes('gothic', bold);
    fontCache.set(file, fs.readFileSync(file));
  }
  return fontCache.get(file);
}
function availableFonts() {
  return Object.entries(FONTS).filter(([, f]) => fs.existsSync(path.join(FONT_DIR, f[0]))).map(([key, f]) => ({ key, name: f[2] }));
}
// 원래 글꼴 이름으로 비슷한 것 고르기
function guessFont(name) {
  const n = String(name).replace(/^[A-Z]{6}\+/, '');
  if (/batang|myeong|mj|gungsuh|serif|명조|바탕|궁서|hyshinmyeongjo|hysmyeongjo/i.test(n)) return fs.existsSync(path.join(FONT_DIR, FONTS.batang[0])) ? 'batang' : 'gothic';
  if (/hcrdotum|handotum|함초롬돋움/i.test(n)) return fs.existsSync(path.join(FONT_DIR, FONTS.dotum[0])) ? 'dotum' : 'gothic';
  return 'gothic';
}

const u8 = (b) => Uint8Array.from(b);
const toRgb = (c) => {
  if (!c || !c.length) return [0, 0, 0];
  if (c.length === 1) return [c[0], c[0], c[0]];
  if (c.length === 4) return [(1 - c[0]) * (1 - c[3]), (1 - c[1]) * (1 - c[3]), (1 - c[2]) * (1 - c[3])];
  return c.slice(0, 3);
};

// 편집 중인 문서 하나 — 작업마다 PDF 바이트를 새로 만들고, 되돌리기용으로 앞 단계를 쌓아 둔다
const S = { path: null, bytes: null, history: [], doc: null, dirty: false };
const MAX_UNDO = 30;

async function mudoc() {
  const m = await lib();
  if (!S.doc) S.doc = m.Document.openDocument(S.bytes, 'application/pdf');
  return S.doc;
}
function setBytes(bytes, { record = true } = {}) {
  if (record) {
    S.history.push(S.bytes);
    if (S.history.length > MAX_UNDO) S.history.shift();
  }
  S.bytes = bytes;
  if (S.doc) { S.doc.destroy(); S.doc = null; }
  S.dirty = true;
}
const state = () => ({ canUndo: S.history.length > 0, dirty: S.dirty });

async function open(file) {
  const m = await lib();
  const bytes = u8(await fs.promises.readFile(file));
  let doc;
  try { doc = m.Document.openDocument(bytes, 'application/pdf'); } catch (e) {
    throw new EditError(`PDF를 열 수 없습니다: ${path.basename(file)}`);
  }
  if (doc.needsPassword()) { doc.destroy(); throw new EditError(`암호가 걸린 PDF는 편집할 수 없습니다: ${path.basename(file)}`); }
  if (S.doc) S.doc.destroy();
  Object.assign(S, { path: file, bytes, history: [], doc, dirty: false });
  return { pages: doc.countPages(), fonts: availableFonts(), ...state() };
}

// 쪽 그림 + 고칠 수 있는 줄·그림 목록
async function pageInfo(i, scale) {
  const m = await lib();
  const doc = await mudoc();
  const page = doc.loadPage(i);
  try {
    const [x0, y0, x1, y1] = page.getBounds();
    const pix = page.toPixmap(m.Matrix.scale(scale, scale), m.ColorSpace.DeviceRGB, false, true);
    const png = pix.asPNG();
    pix.destroy();
    const lines = [], images = [];
    let cur = null;
    const st = page.toStructuredText('preserve-images,preserve-whitespace');
    st.walk({
      beginLine(bbox) { cur = { bbox, text: '', size: 0, font: '', bold: false, color: [0, 0, 0], origin: null }; },
      onChar(c, origin, font, size, quad, color) {
        if (!cur.origin) Object.assign(cur, { origin, size, font: font.getName(), bold: font.isBold(), color: toRgb(color) });
        cur.text += c;
      },
      endLine() { if (cur && cur.text.trim()) lines.push({ ...cur, text: cur.text.replace(/\s+$/, ''), fontKey: guessFont(cur.font) }); cur = null; },
      onImageBlock(bbox) { images.push({ index: images.length, bbox }); },
    });
    st.destroy();
    return { png, x0, y0, w: x1 - x0, h: y1 - y0, lines, images };
  } finally { page.destroy(); }
}

// MuPDF로 영역 안 내용을 실제로 지우고 새 PDF 바이트를 돌려준다
async function redact(pageNo, rects, { text = true, images = 0, lineArt = 0 } = {}) {
  const m = await lib();
  const doc = m.Document.openDocument(S.bytes, 'application/pdf');
  try {
    const page = doc.loadPage(pageNo);
    for (const r of rects) page.createAnnotation('Redact').setRect(r);
    page.applyRedactions(false, images, lineArt, text ? m.PDFPage.REDACT_TEXT_REMOVE : m.PDFPage.REDACT_TEXT_NONE);
    page.destroy();
    return doc.saveToBuffer('garbage,compress').asUint8Array().slice();
  } finally { doc.destroy(); }
}

// MuPDF 쪽 좌표 → PDF 사용자 좌표 변환기 (pdf-lib으로 그릴 때)
async function userSpace(bytes, pageNo) {
  const m = await lib();
  const doc = m.Document.openDocument(bytes, 'application/pdf');
  try {
    const page = doc.loadPage(pageNo);
    const inv = m.Matrix.invert(page.getTransform());
    page.destroy();
    const tp = ([x, y]) => [inv[0] * x + inv[2] * y + inv[4], inv[1] * x + inv[3] * y + inv[5]];
    // 화면의 오른쪽(+x) 방향이 PDF에서 몇 도인가 — 돌아간 쪽에서도 글자·그림을 똑바로 세운다
    const [ax, ay] = tp([0, 0]), [bx, by] = tp([1, 0]);
    return { tp, angle: (Math.atan2(by - ay, bx - ax) * 180) / Math.PI };
  } finally { doc.destroy(); }
}

// 글자 쓰기: 한 줄씩, (x, baseline y)는 첫 줄 기준 MuPDF 좌표.
// 고른 글꼴에 없는 글자는 다른 글꼴에서 빌려 그 부분만 따로 쓴다
async function drawText(bytes, pageNo, { x, y, size, color, text, fontKey, bold, lineGap = 1.35 }) {
  const { tp, angle } = await userSpace(bytes, pageNo);
  const pdf = await PDFDocument.load(bytes);
  pdf.registerFontkit(fontkit);
  const order = [fontKey, 'gothic', 'batang', 'dotum'].filter((k, i, a) => FONTS[k] && a.indexOf(k) === i && fontBytes(k, bold));
  if (!order.length) throw new EditError('맑은 고딕 글꼴을 찾을 수 없습니다.');
  const embedded = new Map();
  const embed = async (k) => {
    if (!embedded.has(k)) embedded.set(k, await pdf.embedFont(fontBytes(k, bold), { subset: true }));
    return embedded.get(k);
  };
  const pick = (ch) => order.find((k) => fontKit(k, bold).hasGlyphForCodePoint(ch.codePointAt(0))) || order[0];
  const page = pdf.getPage(pageNo);
  const [r, g, b] = color || [0, 0, 0];
  for (const [k, raw] of String(text).split(/\r?\n/).entries()) {
    // 같은 글꼴끼리 묶어 차례로 쓴다 (빈칸은 앞 묶음에 붙인다)
    const runs = [];
    for (const c of raw) {
      const ch = CHAR_FIX[c] || c;
      const key = /\s/.test(ch) && runs.length ? runs[runs.length - 1].key : pick(ch);
      if (runs.length && runs[runs.length - 1].key === key) runs[runs.length - 1].s += ch; else runs.push({ key, s: ch });
    }
    let dx = 0;
    for (const run of runs) {
      const font = await embed(run.key);
      const [ux, uy] = tp([x + dx, y + k * size * lineGap]);
      page.drawText(run.s, { x: ux, y: uy, size, font, color: rgb(r, g, b), rotate: degrees(angle) });
      dx += font.widthOfTextAtSize(run.s, size);
    }
  }
  return u8(await pdf.save());
}

// 그림 그리기: rect = [x0, y0, x1, y1] MuPDF 좌표
async function drawImage(bytes, pageNo, rect, img) {
  const { tp, angle } = await userSpace(bytes, pageNo);
  const pdf = await PDFDocument.load(bytes);
  const isPng = img[0] === 0x89 && img[1] === 0x50;
  let emb;
  try { emb = isPng ? await pdf.embedPng(u8(img)) : await pdf.embedJpg(u8(img)); } catch { throw new EditError('그림을 읽을 수 없습니다(PNG·JPG만 넣을 수 있습니다).'); }
  const [x0, y0, x1, y1] = rect;
  const [ux, uy] = tp([x0, y1]); // 보이는 왼쪽 아래
  pdf.getPage(pageNo).drawImage(emb, { x: ux, y: uy, width: x1 - x0, height: y1 - y0, rotate: degrees(angle) });
  return u8(await pdf.save());
}

// PDF 그림은 색과 투명도(마스크)를 따로 담는 경우가 많다 → 하나의 투명 PNG로 합친다
function withMask(m, image) {
  const base = image.toPixmap();
  const rgbPix = base.getColorSpace() && base.getColorSpace().getName() === 'DeviceRGB' && !base.getAlpha() ? base : base.convertToColorSpace(m.ColorSpace.DeviceRGB, false);
  const maskPix = image.getMask().toPixmap();
  const w = rgbPix.getWidth(), h = rgbPix.getHeight(), mw = maskPix.getWidth(), mh = maskPix.getHeight();
  const out = new m.Pixmap(m.ColorSpace.DeviceRGB, [0, 0, w, h], true);
  const src = rgbPix.getPixels(), ms = maskPix.getPixels(), dst = out.getPixels();
  const sStride = rgbPix.getStride(), mStride = maskPix.getStride(), mn = maskPix.getNumberOfComponents(), dStride = out.getStride();
  for (let y = 0; y < h; y++) {
    const my = Math.min(mh - 1, Math.floor((y * mh) / h));
    for (let x = 0; x < w; x++) {
      const mx = Math.min(mw - 1, Math.floor((x * mw) / w));
      const a = ms[my * mStride + mx * mn];
      const s = y * sStride + x * 3, d = y * dStride + x * 4;
      // MuPDF 픽스맵은 색에 투명도를 미리 곱해 둔다(premultiplied)
      dst[d] = (src[s] * a) / 255; dst[d + 1] = (src[s + 1] * a) / 255; dst[d + 2] = (src[s + 2] * a) / 255; dst[d + 3] = a;
    }
  }
  const png = out.asPNG().slice();
  [out, maskPix, rgbPix, base].forEach((p, i, all) => { if (all.indexOf(p) === i) p.destroy(); });
  return png;
}

// i번째 그림을 꺼낸다 (옮기기 전에) — 투명한 부분이 있으면 PNG, 아니면 JPG
async function imageBytes(pageNo, index) {
  const m = await lib();
  const doc = await mudoc();
  const page = doc.loadPage(pageNo);
  let out = null, k = 0;
  const st = page.toStructuredText('preserve-images');
  st.walk({
    onImageBlock(bbox, tm, image) {
      if (k++ !== index) return;
      if (image.getMask()) { out = withMask(m, image); return; }
      const pix = image.toPixmap();
      out = (pix.getAlpha() ? pix.asPNG() : pix.asJPEG(92)).slice();
      pix.destroy();
    },
  });
  st.destroy();
  page.destroy();
  if (!out) throw new EditError('그림을 찾지 못했습니다.');
  return out;
}

const overlaps = (a, b) => a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];
// 그림 하나만 지우기 — 다른 그림(예: 스캔 배경)과 겹치면 통째로 지우지 않고 그 자리 픽셀만 지운다
async function removeImage(pageNo, info, index) {
  const m = await lib();
  const target = info.images[index];
  if (!target) throw new EditError('그림을 찾지 못했습니다.');
  const shared = info.images.some((o) => o.index !== index && overlaps(o.bbox, target.bbox));
  return redact(pageNo, [target.bbox], { text: false, images: shared ? m.PDFPage.REDACT_IMAGE_PIXELS : m.PDFPage.REDACT_IMAGE_REMOVE });
}

async function apply(op) {
  const m = await lib();
  const p = op.page;
  let bytes;
  if (op.type === 'text') {
    // 줄 고치기: 원래 줄을 지우고(위아래 이웃 줄을 건드리지 않게 조금 줄인 상자) 같은 자리에 새 글자
    const [x0, y0, x1, y1] = op.bbox, h = y1 - y0;
    bytes = await redact(p, [[x0, y0 + h * 0.12, x1, y1 - h * 0.12]]);
    if (op.text.trim()) bytes = await drawText(bytes, p, { x: op.origin[0], y: op.origin[1], size: op.size, color: op.color, text: op.text, fontKey: op.fontKey, bold: op.bold });
  } else if (op.type === 'addText') {
    if (!op.text.trim()) throw new EditError('넣을 글자를 쓰세요.');
    bytes = await drawText(S.bytes, p, { x: op.x, y: op.y + op.size * 0.88, size: op.size, color: op.color, text: op.text, fontKey: op.fontKey, bold: op.bold });
  } else if (op.type === 'deleteArea') {
    bytes = await redact(p, [op.rect], { text: true, images: m.PDFPage.REDACT_IMAGE_PIXELS, lineArt: m.PDFPage.REDACT_LINE_ART_REMOVE_IF_COVERED });
  } else if (op.type === 'deleteImage' || op.type === 'moveImage' || op.type === 'replaceImage') {
    const info = await pageInfo(p, 0.1);
    const img = op.type === 'moveImage' ? await imageBytes(p, op.index) : op.type === 'replaceImage' ? await fs.promises.readFile(op.file) : null;
    bytes = await removeImage(p, info, op.index);
    if (op.type === 'moveImage') bytes = await drawImage(bytes, p, op.rect, img);
    if (op.type === 'replaceImage') {
      // 새 그림은 원래 자리 상자 안에 비율을 지켜 가운데로
      const box = info.images[op.index].bbox;
      const probe = await PDFDocument.create();
      const e = img[0] === 0x89 ? await probe.embedPng(u8(img)) : await probe.embedJpg(u8(img));
      const bw = box[2] - box[0], bh = box[3] - box[1], k = Math.min(bw / e.width, bh / e.height);
      const w = e.width * k, h = e.height * k, cx = (box[0] + box[2]) / 2, cy = (box[1] + box[3]) / 2;
      bytes = await drawImage(bytes, p, [cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2], img);
    }
  } else if (op.type === 'addImage') {
    bytes = await drawImage(S.bytes, p, op.rect, await fs.promises.readFile(op.file));
  } else throw new EditError(`모르는 작업: ${op.type}`);
  setBytes(bytes);
  return state();
}

// 그림 파일의 크기(px) — 새 그림을 넣을 때 비율을 지키려고
async function imageSize(file) {
  const img = await fs.promises.readFile(file);
  const probe = await PDFDocument.create();
  try {
    const e = img[0] === 0x89 && img[1] === 0x50 ? await probe.embedPng(u8(img)) : await probe.embedJpg(u8(img));
    return { w: e.width, h: e.height };
  } catch { throw new EditError('PNG·JPG 그림만 넣을 수 있습니다.'); }
}

function undo() {
  if (!S.history.length) return state();
  setBytes(S.history.pop(), { record: false });
  S.dirty = S.history.length > 0;
  return state();
}

async function save(out) {
  if (!S.bytes) throw new EditError('열린 PDF가 없습니다.');
  // 마지막으로 MuPDF로 한 번 더 정리(쓰지 않는 개체 지우기)
  const m = await lib();
  const doc = m.Document.openDocument(S.bytes, 'application/pdf');
  try { await fs.promises.writeFile(out, doc.saveToBuffer('garbage,compress').asUint8Array()); } finally { doc.destroy(); }
  S.dirty = false;
  return { out, ...state() };
}

const isDirty = () => !!S.bytes && S.dirty;

module.exports = { EditError, open, pageInfo, apply, undo, save, imageSize, availableFonts, isDirty };
