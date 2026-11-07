// PDF 처리 핵심 — 합치기·나누기·서명 넣기 (Electron 없이 node로도 테스트 가능)
const fs = require('fs');
const path = require('path');
const { PDFDocument, degrees, StandardFonts, rgb } = require('pdf-lib');

class PdfError extends Error {}

// pdf-lib은 Node Buffer가 큰 메모리 덩어리의 중간을 가리키면 잘못 읽는다(작은 JPEG "SOI not found") → 딱 맞는 사본으로
const bytesOf = (b) => Uint8Array.from(b);

async function load(file) {
  const bytes = await fs.promises.readFile(file);
  try {
    return await PDFDocument.load(bytes, { updateMetadata: false });
  } catch (e) {
    if (/encrypt/i.test(String(e && e.message))) {
      throw new PdfError(`암호가 걸린 PDF는 처리할 수 없습니다: ${path.basename(file)}`);
    }
    throw new PdfError(`PDF를 읽을 수 없습니다: ${path.basename(file)} (${e.message})`);
  }
}

async function pageCount(file) {
  return (await load(file)).getPageCount();
}

const A4 = [595.28, 841.89];

// 그림 한 장 = 한 쪽. fit 'a4': A4(가로·세로 자동)에 맞춰 가운데, 'orig': 그림 크기(96dpi 기준) 그대로
//   bytes가 있으면(화면에서 PNG/JPG로 바꿔 넘긴 것) 그것을, 없으면 파일을 그대로 넣는다
async function addImagePage(out, f, fit) {
  const bytes = bytesOf(f.bytes || await fs.promises.readFile(f.path));
  const isPng = bytes[0] === 0x89 && bytes[1] === 0x50;
  let img;
  try { img = isPng ? await out.embedPng(bytes) : await out.embedJpg(bytes); } catch (e) {
    throw new PdfError(`그림을 읽을 수 없습니다: ${path.basename(f.path)}`);
  }
  let pw, ph, dw, dh;
  if (fit === 'orig') {
    pw = dw = (img.width * 72) / 96;
    ph = dh = (img.height * 72) / 96;
  } else {
    const landscape = img.width > img.height;
    [pw, ph] = landscape ? [A4[1], A4[0]] : A4;
    const k = Math.min(pw / img.width, ph / img.height);
    dw = img.width * k; dh = img.height * k;
  }
  out.addPage([pw, ph]).drawImage(img, { x: (pw - dw) / 2, y: (ph - dh) / 2, width: dw, height: dh });
}

// files: [{ path, pages?: [0-based 쪽 번호] } | { path, kind: 'img', bytes? }]  pages가 없으면 전체
async function merge(files, outPath, { imageFit = 'a4' } = {}) {
  if (!files.length) throw new PdfError('합칠 파일이 없습니다.');
  const out = await PDFDocument.create();
  for (const f of files) {
    if (f.kind === 'img') { await addImagePage(out, f, imageFit); continue; }
    const src = await load(f.path);
    const idx = f.pages || src.getPageIndices();
    const copied = await out.copyPages(src, idx);
    copied.forEach((p) => out.addPage(p));
  }
  await fs.promises.writeFile(outPath, await out.save());
  return { outPath, pages: out.getPageCount() };
}

// "1-3, 5, 7-" → [[0,1,2],[4],[6..끝]]  (쉼표 하나가 파일 하나)
function parseRanges(text, total) {
  const groups = [];
  for (const part of String(text).split(/[,，]/).map((s) => s.trim()).filter(Boolean)) {
    const m = part.match(/^(\d*)\s*[-~]\s*(\d*)$/) || part.match(/^(\d+)$/);
    if (!m) throw new PdfError(`쪽 범위를 알아볼 수 없습니다: "${part}"`);
    let a, b;
    if (m.length === 2) a = b = Number(m[1]);
    else { a = m[1] ? Number(m[1]) : 1; b = m[2] ? Number(m[2]) : total; }
    if (a < 1 || b > total || a > b) throw new PdfError(`쪽 범위가 맞지 않습니다: "${part}" (전체 ${total}쪽)`);
    const g = [];
    for (let i = a; i <= b; i++) g.push(i - 1);
    groups.push(g);
  }
  if (!groups.length) throw new PdfError('쪽 범위를 입력하세요.');
  return groups;
}

function label(pages) {
  const a = pages[0] + 1, b = pages[pages.length - 1] + 1;
  const contiguous = pages.every((p, i) => i === 0 || p === pages[i - 1] + 1);
  if (pages.length === 1) return `${a}쪽`;
  return contiguous ? `${a}-${b}쪽` : `${a}쪽외${pages.length - 1}`;
}

// 파일 이름에 못 쓰는 글자를 _로, 끝의 점·공백 제거
function safeName(name) {
  const s = String(name).replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/[. ]+$/g, '').trim();
  if (!s || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(s)) throw new PdfError(`쓸 수 없는 파일 이름입니다: "${name}"`);
  return s;
}
// 같은 이름이 있으면 "이름(2).확장자"
function freePath(dir, name, ext) {
  let p = path.join(dir, `${name}${ext}`);
  for (let n = 2; fs.existsSync(p); n++) p = path.join(dir, `${name}(${n})${ext}`);
  return p;
}
// 결과를 담을 새 폴더 — 있으면 "이름(2)"
async function newFolder(parent, name) {
  const dir = freePath(parent, safeName(name), '');
  await fs.promises.mkdir(dir, { recursive: true });
  return dir;
}

// groups: [[0-based 쪽...], ...] 묶음마다 파일 하나. names가 있으면 그 이름(.pdf 자동)
async function split(file, groups, outDir, names = null) {
  const src = await load(file);
  const base = path.basename(file).replace(/\.pdf$/i, '');
  const written = [];
  for (const [i, g] of groups.entries()) {
    const out = await PDFDocument.create();
    (await out.copyPages(src, g)).forEach((p) => out.addPage(p));
    const target = names && names[i]
      ? freePath(outDir, safeName(String(names[i]).replace(/\.pdf$/i, '')), '.pdf')
      : freePath(outDir, `${base}_${label(g)}`, '.pdf');
    await fs.promises.writeFile(target, await out.save());
    written.push(target);
  }
  return written;
}

// stamps: [{ page, png: Uint8Array|Buffer, x, y, width, height, rotate }]
//   x,y,width,height,rotate는 PDF 사용자 좌표(화면에서 pdf.js convertToPdfPoint로 계산해 넘김)
async function sign(file, stamps, outPath) {
  const doc = await load(file);
  const cache = new Map();
  for (const s of stamps) {
    const key = Buffer.from(s.png).toString('base64');
    if (!cache.has(key)) cache.set(key, await doc.embedPng(bytesOf(s.png)));
    const page = doc.getPage(s.page);
    page.drawImage(cache.get(key), {
      x: s.x, y: s.y, width: s.width, height: s.height, rotate: degrees(s.rotate || 0),
    });
  }
  await fs.promises.writeFile(outPath, await doc.save());
  return { outPath };
}

// "1~5, 8, 10-끝" → [0..4, 7, 9..] 쪽 모음(겹치면 한 번, 오름차순). 비우면 전체
function parsePages(text, total) {
  const set = new Set();
  const t = String(text || '').trim();
  if (!t) return Array.from({ length: total }, (_, i) => i);
  for (const part of t.split(/[,，;]/).map((x) => x.trim()).filter(Boolean)) {
    const m = part.match(/^(\d*)\s*[-~]\s*(\d*|끝)$/) || part.match(/^(\d+)$/);
    if (!m) throw new PdfError(`쪽 범위를 알아볼 수 없습니다: "${part}"`);
    let a, b;
    if (m.length === 2) a = b = Number(m[1]);
    else { a = m[1] ? Number(m[1]) : 1; b = m[2] && m[2] !== '끝' ? Number(m[2]) : total; }
    if (a > b) [a, b] = [b, a];
    if (a < 1 || b > total) throw new PdfError(`쪽 범위가 맞지 않습니다: "${part}" (전체 ${total}쪽)`);
    for (let i = a; i <= b; i++) set.add(i - 1);
  }
  return [...set].sort((x, y) => x - y);
}

const turn = (page, by) => page.setRotation(degrees((((page.getRotation().angle || 0) + by) % 360 + 360) % 360));

// 고른 쪽을 지금 방향에서 angle(90/180/270)만큼 더 돌린다
async function rotate(file, pages, angle, outPath) {
  const doc = await load(file);
  const all = doc.getPages();
  for (const i of pages) turn(all[i], angle);
  await fs.promises.writeFile(outPath, await doc.save());
  return { outPath, count: pages.length };
}

// order: [{ p: 원본 0-based 쪽, rot: 더 돌릴 각도 }] — 빠진 쪽은 지운 것
async function organize(file, order, outPath) {
  if (!order.length) throw new PdfError('남은 쪽이 없습니다.');
  const src = await load(file);
  const out = await PDFDocument.create();
  const copied = await out.copyPages(src, order.map((o) => o.p));
  copied.forEach((pg, i) => { if (order[i].rot) turn(pg, order[i].rot); out.addPage(pg); });
  await fs.promises.writeFile(outPath, await out.save());
  return { outPath, pages: out.getPageCount() };
}

// 쪽번호(숫자라 기본 글꼴로 충분) + 워터마크(화면에서 한글을 그려 만든 PNG)
//   num: { fmt: 'n'|'n/t'|'-n-', pos: 'bc'|'br'|'bl'|'tr', start, size } | null,  wm: { png } | null
async function stamp(file, { num = null, wm = null }, outPath) {
  if (!num && !wm) throw new PdfError('쪽번호나 워터마크 중 하나는 고르세요.');
  const doc = await load(file);
  const pages = doc.getPages();
  const font = num ? await doc.embedFont(StandardFonts.Helvetica) : null;
  const wmImg = wm ? await doc.embedPng(bytesOf(wm.png)) : null;
  pages.forEach((page, i) => {
    // 돌아간 쪽도 '보이는 방향' 기준으로 넣는다: 보이는 크기·좌표를 계산해 PDF 좌표로 바꾼다
    const rot = ((page.getRotation().angle || 0) % 360 + 360) % 360;
    const { x: bx, y: by, width: bw, height: bh } = page.getCropBox();
    const vw = rot % 180 ? bh : bw, vh = rot % 180 ? bw : bh;
    // 보이는 좌표(u,v: 왼쪽 아래 원점) → PDF 좌표
    const toPdf = (u, v) => (rot === 90 ? [bx + bw - v, by + u]
      : rot === 180 ? [bx + bw - u, by + bh - v]
        : rot === 270 ? [bx + v, by + bh - u] : [bx + u, by + v]);
    if (wmImg) {
      const k = Math.min((vw * 0.72) / wmImg.width, (vh * 0.72) / wmImg.height);
      const dw = wmImg.width * k, dh = wmImg.height * k;
      const [x, y] = toPdf((vw - dw) / 2, (vh - dh) / 2);
      page.drawImage(wmImg, { x, y, width: dw, height: dh, rotate: degrees(rot) });
    }
    if (num) {
      const no = num.start + i;
      const text = num.fmt === 'n/t' ? `${no} / ${num.start + pages.length - 1}` : num.fmt === '-n-' ? `- ${no} -` : String(no);
      const tw = font.widthOfTextAtSize(text, num.size);
      const u = num.pos === 'bc' ? (vw - tw) / 2 : num.pos === 'bl' ? 28 : vw - tw - 28;
      const v = num.pos === 'tr' ? vh - 26 : 18;
      const [x, y] = toPdf(u, v);
      page.drawText(text, { x, y, size: num.size, font, color: rgb(0.25, 0.29, 0.36), rotate: degrees(rot) });
    }
  });
  await fs.promises.writeFile(outPath, await doc.save());
  return { outPath };
}

// 보이는 방향 기준 [왼쪽(위) 반, 오른쪽(아래) 반] — 쪽 회전을 고려한 PDF 좌표 상자
function halves(box, rot, dir) {
  const { x, y, width: w, height: h } = box;
  const L = { x, y, w: w / 2, h }, R = { x: x + w / 2, y, w: w / 2, h };
  const B = { x, y, w, h: h / 2 }, T = { x, y: y + h / 2, w, h: h / 2 };
  rot = ((rot % 360) + 360) % 360;
  if (dir === 'lr') return { 0: [L, R], 90: [B, T], 180: [R, L], 270: [T, B] }[rot] || [L, R];
  return { 0: [T, B], 90: [L, R], 180: [B, T], 270: [R, L] }[rot] || [T, B];
}

// 두 쪽 모아찍기를 한 쪽씩 — scope 안의 쪽만 반으로, 나머지는 그대로
async function unspread(file, scope, dir, swap, outPath) {
  const src = await load(file);
  const set = new Set(scope);
  const idx = [], plan = [];
  for (let i = 0; i < src.getPageCount(); i++) {
    if (set.has(i)) { idx.push(i, i); plan.push(0, 1); } else { idx.push(i); plan.push(-1); }
  }
  const out = await PDFDocument.create();
  const copied = await out.copyPages(src, idx);
  copied.forEach((pg, k) => {
    if (plan[k] >= 0) {
      let pair = halves(pg.getCropBox(), pg.getRotation().angle || 0, dir);
      if (swap) pair = [pair[1], pair[0]];
      const b = pair[plan[k]];
      pg.setMediaBox(b.x, b.y, b.w, b.h);
      pg.setCropBox(b.x, b.y, b.w, b.h);
    }
    out.addPage(pg);
  });
  await fs.promises.writeFile(outPath, await out.save());
  return { outPath, from: src.getPageCount(), pages: out.getPageCount() };
}

// box: PDF 좌표 { x, y, w, h } (화면에서 pdf.js convertToPdfPoint로 계산)
async function crop(file, pages, box, outPath) {
  const doc = await load(file);
  const all = doc.getPages();
  for (const i of pages) {
    all[i].setMediaBox(box.x, box.y, box.w, box.h);
    all[i].setCropBox(box.x, box.y, box.w, box.h);
  }
  await fs.promises.writeFile(outPath, await doc.save());
  return { outPath, count: pages.length };
}

// 용량 줄이기: 화면에서 쪽마다 JPEG로 그린 것을 원래 쪽 크기 그대로 다시 묶는다
//   pages: [{ jpg, w, h }] (w,h = 보이는 방향의 쪽 크기, pt)
async function fromJpegs(pages, outPath) {
  const out = await PDFDocument.create();
  for (const p of pages) {
    const img = await out.embedJpg(bytesOf(p.jpg));
    out.addPage([p.w, p.h]).drawImage(img, { x: 0, y: 0, width: p.w, height: p.h });
  }
  await fs.promises.writeFile(outPath, await out.save());
  return { outPath, size: (await fs.promises.stat(outPath)).size };
}

// 이름 붙여 나누기(학생별 등) — tasks: [{ name, pages: [0-based] }], 새 폴더에 저장
async function splitNamed(file, tasks, parentDir, folderName) {
  const src = await load(file);
  const dir = await newFolder(parentDir, folderName);
  for (const t of tasks) {
    const out = await PDFDocument.create();
    (await out.copyPages(src, t.pages)).forEach((p) => out.addPage(p));
    await fs.promises.writeFile(freePath(dir, safeName(t.name), '.pdf'), await out.save());
  }
  return { dir, count: tasks.length };
}

// 그림 여러 장을 새 폴더에 — files: [{ name(확장자 포함), bytes }]
async function writeFiles(parentDir, folderName, files) {
  const dir = await newFolder(parentDir, folderName);
  for (const f of files) {
    const ext = path.extname(f.name);
    await fs.promises.writeFile(freePath(dir, safeName(path.basename(f.name, ext)), ext), Buffer.from(f.bytes));
  }
  return { dir, count: files.length };
}

module.exports = {
  PdfError, pageCount, merge, split, parseRanges, parsePages, sign,
  rotate, organize, stamp, unspread, crop, fromJpegs, splitNamed, writeFiles, safeName,
};
