import * as pdfjsLib from './vendor/pdf.min.mjs';
import { initTools } from './tools.js';
import { initEdit } from './edit-ui.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = './vendor/pdf.worker.min.mjs';

const $ = (s) => document.querySelector(s);
const api = window.api;
const baseName = (p) => p.split(/[\\/]/).pop();
const dirName = (p) => p.replace(/[\\/][^\\/]*$/, '');
const stamp = () => {
  const d = new Date(), z = (n) => String(n).padStart(2, '0');
  return `${String(d.getFullYear()).slice(2)}${z(d.getMonth() + 1)}${z(d.getDate())}_${z(d.getHours())}${z(d.getMinutes())}`;
};

// ───── 공통 ─────
let toastTimer = null;
function toast(msg, { err = false, actions = [] } = {}) {
  const t = $('#toast');
  t.className = `toast${err ? ' err' : ''}`;
  t.replaceChildren(Object.assign(document.createElement('span'), { textContent: msg }));
  for (const [text, fn] of actions) {
    const b = Object.assign(document.createElement('button'), { textContent: text });
    b.onclick = fn;
    t.append(b);
  }
  const close = Object.assign(document.createElement('button'), { textContent: '닫기' });
  close.onclick = () => t.classList.add('hidden');
  t.append(close);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), actions.length ? 12000 : 5000);
}
function savedToast(msg, file) {
  toast(msg, { actions: [['열기', () => api.openPath(file)], ['폴더 보기', () => api.showInFolder(file)]] });
}
let busyCount = 0;
async function busy(text, fn) {
  $('#busyText').textContent = text;
  $('#busy').classList.remove('hidden');
  busyCount++;
  try { return await fn(); } finally { if (--busyCount === 0) $('#busy').classList.add('hidden'); }
}

async function openPdfJs(file) {
  const r = await api.readFile(file);
  if (!r.ok) throw new Error(r.error);
  return pdfjsLib.getDocument({
    data: r.value,
    cMapUrl: './vendor/cmaps/',
    cMapPacked: true,
    standardFontDataUrl: './vendor/standard_fonts/',
  }).promise;
}
function pdfjsErrorText(e, file) {
  if (e && e.name === 'PasswordException') return `암호가 걸린 PDF는 열 수 없습니다: ${baseName(file)}`;
  return `PDF를 열 수 없습니다: ${baseName(file)} (${e.message || e})`;
}

// 탭
let current = 'merge';
function showTab(name) {
  current = name;
  document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('.panel').forEach((p) => p.classList.toggle('active', p.id === `tab-${name}`));
}
document.querySelectorAll('.tab').forEach((b) => { b.onclick = () => showTab(b.dataset.tab); });

// 끌어다 놓기
const PDF_RE = /\.pdf$/i;
const HWP_RE = /\.hwpx?$/i;
const IMG_RE = /\.(png|jpe?g|gif|webp|bmp)$/i;
function pathsFrom(e, accept) {
  return [...e.dataTransfer.files].map((f) => api.pathOf(f)).filter((p) => accept.test(p));
}
function dropZone(el, onFiles, { accept = PDF_RE, wrong = 'PDF 파일만 넣을 수 있습니다.' } = {}) {
  el.addEventListener('dragover', (e) => {
    if (![...e.dataTransfer.types].includes('Files')) return;
    e.preventDefault();
    el.classList.add('over');
  });
  el.addEventListener('dragleave', (e) => { if (!el.contains(e.relatedTarget)) el.classList.remove('over'); });
  el.addEventListener('drop', (e) => {
    el.classList.remove('over');
    if (![...e.dataTransfer.types].includes('Files')) return;
    e.preventDefault();
    const files = pathsFrom(e, accept);
    if (files.length) onFiles(files);
    else toast(wrong, { err: true });
  });
}
// 창의 다른 곳에 떨어뜨려도 브라우저가 파일을 열어 버리지 않게
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => e.preventDefault());

// ───── 합치기 ─────
// userOrdered: 사용자가 순서를 직접 손댔는지 — 그전까지 우클릭으로 들어온 파일은 이름순으로 맞춘다
// items: { path, pages, range, error, origin } — origin: 한글 문서를 바꿔 넣었으면 그 원본 경로
const merge = { items: [], userOrdered: false };
const shownPath = (it) => it.origin || it.path;

async function addToMerge(paths, { fromShell = false, origins = {} } = {}) {
  const fresh = paths.filter((p) => !merge.items.some((i) => i.path === p));
  for (const p of fresh) {
    const item = { path: p, pages: null, range: '', error: null, origin: origins[p] || null, img: IMG_RE.test(p) };
    merge.items.push(item);
    if (item.img) { item.pages = 1; continue; }
    const r = await api.pageCount(p);
    if (r.ok) item.pages = r.value; else item.error = r.error;
  }
  if (fromShell && !merge.userOrdered) merge.items.sort(byName);
  renderMerge();
  const bad = merge.items.filter((i) => i.error);
  if (bad.length) toast(bad[0].error + (bad.length > 1 ? ` 외 ${bad.length - 1}개` : ''), { err: true });
}

function renderMerge() {
  const list = $('#mList');
  list.replaceChildren();
  merge.items.forEach((it, i) => {
    const li = document.createElement('li');
    li.draggable = true;
    li.dataset.i = i;
    if (it.error) li.classList.add('bad');
    li.innerHTML = `<span class="no">${i + 1}</span>
      <span class="nm"><b></b><span></span></span>
      <span class="pc"></span>
      <input class="rg" type="text" placeholder="전체">
      <span class="acts"><button data-a="up" title="위로">▲</button><button data-a="down" title="아래로">▼</button><button data-a="del" title="빼기">✕</button></span>`;
    li.querySelector('.nm b').textContent = baseName(shownPath(it));
    li.querySelector('.nm span').textContent = it.error ? it.error : dirName(shownPath(it)) + (it.origin ? ' · PDF로 바꿔 넣음' : '');
    li.querySelector('.pc').textContent = it.img ? '그림' : it.pages == null ? (it.error ? '읽기 실패' : '…') : `${it.pages}쪽`;
    const rg = li.querySelector('.rg');
    rg.value = it.range;
    rg.disabled = !!it.error || it.img;
    if (it.img) rg.placeholder = '한 쪽';
    rg.oninput = () => { it.range = rg.value; updateMergeSummary(); };
    rg.addEventListener('mousedown', (e) => e.stopPropagation());
    li.querySelector('.acts').onclick = (e) => {
      const a = e.target.dataset.a;
      if (!a) return;
      if (a !== 'del') merge.userOrdered = true;
      if (a === 'del') merge.items.splice(i, 1);
      if (a === 'up' && i > 0) [merge.items[i - 1], merge.items[i]] = [merge.items[i], merge.items[i - 1]];
      if (a === 'down' && i < merge.items.length - 1) [merge.items[i + 1], merge.items[i]] = [merge.items[i], merge.items[i + 1]];
      renderMerge();
    };
    list.append(li);
  });
  $('#mEmpty').style.display = merge.items.length ? 'none' : '';
  updateMergeSummary();
}

function updateMergeSummary() {
  const ok = merge.items.filter((i) => !i.error && i.pages != null);
  const total = ok.reduce((s, i) => s + i.pages, 0);
  const custom = ok.some((i) => i.range.trim());
  $('#mSummary').textContent = merge.items.length
    ? `${ok.length}개 파일 · ${custom ? '쪽 지정 있음' : `모두 ${total}쪽`}` : '';
  $('#mRun').disabled = ok.length < 1 || merge.items.some((i) => i.error);
}

// 줄 끌어서 순서 바꾸기 (파일 끌어다 놓기와 구별하려고 자체 형식 사용)
let dragFrom = null;
$('#mList').addEventListener('dragstart', (e) => {
  const li = e.target.closest('li');
  if (!li) return;
  dragFrom = Number(li.dataset.i);
  e.dataTransfer.setData('application/x-pdftool-row', String(dragFrom));
  e.dataTransfer.effectAllowed = 'move';
  li.classList.add('dragging');
});
$('#mList').addEventListener('dragover', (e) => {
  if (dragFrom == null) return;
  e.preventDefault();
  document.querySelectorAll('.drop-before').forEach((x) => x.classList.remove('drop-before'));
  const li = e.target.closest('li');
  if (li) li.classList.add('drop-before');
});
$('#mList').addEventListener('drop', (e) => {
  if (dragFrom == null) return;
  e.preventDefault();
  e.stopPropagation();
  const li = e.target.closest('li');
  let to = li ? Number(li.dataset.i) : merge.items.length;
  const [moved] = merge.items.splice(dragFrom, 1);
  if (to > dragFrom) to -= 1;
  merge.items.splice(to, 0, moved);
  merge.userOrdered = true;
  dragFrom = null;
  renderMerge();
});
$('#mList').addEventListener('dragend', () => {
  dragFrom = null;
  document.querySelectorAll('.dragging, .drop-before').forEach((x) => x.classList.remove('dragging', 'drop-before'));
});

const collator = new Intl.Collator('ko', { numeric: true, sensitivity: 'base' });
const byName = (a, b) => collator.compare(baseName(a.origin || a.path || a), baseName(b.origin || b.path || b));

// 합치기 화면에 한글 문서가 들어오면 임시 PDF로 바꿔서 넣는다
async function addHwpToMerge(hwps, opts = {}) {
  hwps = hwps.slice().sort(byName);
  let done = 0;
  const r = await busy('한글 문서를 PDF로 바꾸는 중…', () => convertQueued(hwps, true, (p) => {
    if (p.state !== 'run') done++;
    $('#busyText').textContent = `한글 문서를 PDF로 바꾸는 중… (${Math.min(done + 1, hwps.length)}/${hwps.length})`;
  }));
  if (!r.ok) return toast(r.error, { err: true });
  const ok = r.value.filter((x) => x.out);
  const origins = Object.fromEntries(ok.map((x) => [x.out, x.src]));
  await addToMerge(ok.map((x) => x.out), { ...opts, origins });
  const bad = r.value.filter((x) => x.error);
  if (bad.length) {
    toast(`${baseName(bad[0].src)}: ${bad[0].error}` + (bad.length > 1 ? ` 외 ${bad.length - 1}개도 바꾸지 못했습니다` : ''), { err: true });
  }
}
async function addAnyToMerge(paths, opts) {
  const hwps = paths.filter((p) => HWP_RE.test(p));
  const pdfs = paths.filter((p) => PDF_RE.test(p) || IMG_RE.test(p));
  if (pdfs.length) await addToMerge(pdfs, opts);
  if (hwps.length) await addHwpToMerge(hwps, opts);
}

dropZone($('#mDrop'), (files) => addAnyToMerge(files), { accept: /\.(pdf|hwpx?|png|jpe?g|gif|webp|bmp)$/i, wrong: 'PDF, 그림, 한글 문서만 넣을 수 있습니다.' });
$('#mAdd').onclick = async () => addToMerge(await api.pickPdfsImages());

// PNG는 그대로, 나머지 그림은 화면에서 바꿔 넘긴다 — JPG는 사진의 회전 정보(EXIF)를 반영해 다시 JPG로,
// GIF·WebP·BMP는 PNG로 (pdf-lib은 PNG·JPG만 넣을 수 있다)
async function imageBytes(p) {
  if (/\.png$/i.test(p)) return null;
  const r = await api.readFile(p);
  if (!r.ok) throw new Error(r.error);
  let bmp;
  try { bmp = await createImageBitmap(new Blob([r.value]), { imageOrientation: 'from-image' }); } catch {
    throw new Error(`그림을 읽을 수 없습니다: ${baseName(p)}`);
  }
  const c = document.createElement('canvas');
  c.width = bmp.width; c.height = bmp.height;
  c.getContext('2d').drawImage(bmp, 0, 0);
  const jpg = /\.jpe?g$/i.test(p);
  const blob = await new Promise((res) => c.toBlob(res, jpg ? 'image/jpeg' : 'image/png', 0.92));
  return new Uint8Array(await blob.arrayBuffer());
}
$('#mSort').onclick = () => { merge.items.sort(byName); renderMerge(); };
$('#mClear').onclick = () => { merge.items = []; merge.userOrdered = false; renderMerge(); };
$('#mRun').onclick = async () => {
  const files = [];
  for (const it of merge.items) {
    if (it.img) {
      try { files.push({ path: it.path, kind: 'img', bytes: await imageBytes(it.path) }); } catch (e) { return toast(e.message, { err: true }); }
      continue;
    }
    if (!it.range.trim()) { files.push({ path: it.path }); continue; }
    const r = await api.parseRanges(it.range, it.pages);
    if (!r.ok) return toast(`${baseName(it.path)}: ${r.error}`, { err: true });
    files.push({ path: it.path, pages: r.value.flat() });
  }
  const out = await api.savePdf(`${dirName(shownPath(merge.items[0]))}\\합친파일_${stamp()}.pdf`);
  if (!out) return;
  if (merge.items.some((i) => i.path.toLowerCase() === out.toLowerCase())) {
    return toast('합칠 원본 파일 위에 덮어쓸 수 없습니다. 다른 이름을 고르세요.', { err: true });
  }
  const r = await busy('합치는 중…', () => api.merge(files, out, { imageFit: $('#mFit').value }));
  if (!r.ok) return toast(r.error, { err: true });
  savedToast(`${r.value.pages}쪽짜리 파일로 합쳤습니다: ${baseName(out)}`, out);
};

// ───── 나누기 ─────
const split = { path: null, total: 0, picked: new Set(), outDir: null, doc: null, token: 0 };

async function openSplit(file) {
  const token = ++split.token;
  let doc;
  try { doc = await openPdfJs(file); } catch (e) { return toast(pdfjsErrorText(e, file), { err: true }); }
  if (token !== split.token) return;
  if (split.doc) split.doc.destroy();
  Object.assign(split, { path: file, total: doc.numPages, doc, picked: new Set(), outDir: null });
  $('#sName').textContent = `${baseName(file)} (${doc.numPages}쪽)`;
  $('#sDir').textContent = '원본과 같은 폴더';
  $('#sEmpty').style.display = 'none';
  const wrap = $('#sThumbs');
  wrap.replaceChildren();
  const observer = new IntersectionObserver((entries) => {
    for (const en of entries) {
      if (!en.isIntersecting) continue;
      observer.unobserve(en.target);
      renderThumb(doc, Number(en.target.dataset.p), en.target, token);
    }
  }, { root: $('#sDrop'), rootMargin: '400px' });
  for (let p = 0; p < doc.numPages; p++) {
    const t = document.createElement('div');
    t.className = 'thumb';
    t.dataset.p = p;
    t.innerHTML = `<div class="ph"></div><div class="pn">${p + 1}</div>`;
    t.onclick = () => {
      split.picked.has(p) ? split.picked.delete(p) : split.picked.add(p);
      t.classList.toggle('picked');
      if (split.picked.size) document.querySelector('input[name=sMode][value=picked]').checked = true;
      updateSplitPreview();
    };
    wrap.append(t);
    observer.observe(t);
  }
  updateSplitPreview();
}

async function renderThumb(doc, p, el, token) {
  const page = await doc.getPage(p + 1);
  if (token !== split.token) return;
  const vp1 = page.getViewport({ scale: 1 });
  const vp = page.getViewport({ scale: (140 * devicePixelRatio) / vp1.width });
  const c = document.createElement('canvas');
  c.width = vp.width; c.height = vp.height;
  c.style.width = '140px';
  await page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
  el.querySelector('.ph').replaceWith(c);
}

function splitMode() { return document.querySelector('input[name=sMode]:checked').value; }

async function splitGroups() {
  const n = split.total, mode = splitMode();
  if (mode === 'each') return { ok: true, value: Array.from({ length: n }, (_, i) => [i]) };
  if (mode === 'every') {
    const k = Math.floor(Number($('#sEvery').value));
    if (!(k >= 1)) return { ok: false, error: '묶을 쪽 수를 1 이상으로 쓰세요.' };
    const g = [];
    for (let i = 0; i < n; i += k) g.push(Array.from({ length: Math.min(k, n - i) }, (_, j) => i + j));
    return { ok: true, value: g };
  }
  if (mode === 'ranges') return api.parseRanges($('#sRanges').value, n);
  if (mode === 'named') {
    const rows = namedRows().filter((x) => x.range || x.name);
    if (!rows.length) return { ok: false, error: '표에 쪽 범위와 파일 이름을 쓰세요.' };
    const groups = [];
    for (const [i, x] of rows.entries()) {
      if (!x.range) return { ok: false, error: `${i + 1}번째 줄의 쪽 범위를 쓰세요.` };
      if (!x.name) return { ok: false, error: `${i + 1}번째 줄의 파일 이름을 쓰세요.` };
      const r = await api.parsePages(x.range, n);
      if (!r.ok) return { ok: false, error: `${i + 1}번째 줄: ${r.error}` };
      groups.push(r.value);
    }
    const names = rows.map((x) => x.name.replace(/\.pdf$/i, ''));
    const dup = names.find((x, i) => names.findIndex((y) => y.toLowerCase() === x.toLowerCase()) !== i);
    if (dup) return { ok: false, error: `파일 이름이 겹칩니다: ${dup}` };
    return { ok: true, value: groups, names };
  }
  if (!split.picked.size) return { ok: false, error: '미리보기에서 뽑을 쪽을 눌러 고르세요.' };
  return { ok: true, value: [[...split.picked].sort((a, b) => a - b)] };
}

async function updateSplitPreview() {
  $('#sPickedInfo').textContent = split.picked.size ? `(${split.picked.size}쪽 고름)` : '';
  const note = $('#sPreview');
  if (!split.path) { note.textContent = ''; $('#sRun').disabled = true; return; }
  const r = await splitGroups();
  note.classList.toggle('err', !r.ok);
  if (!r.ok) { note.textContent = r.error; $('#sRun').disabled = true; return; }
  const g = r.value;
  const show = g.slice(0, 4).map((x, i) => (r.names ? `${r.names[i]}.pdf ← ` : '') + (x.length === 1 ? `${x[0] + 1}쪽` : `${x[0] + 1}~${x[x.length - 1] + 1}쪽 (${x.length}쪽)`));
  note.textContent = `파일 ${g.length}개가 생깁니다.\n${show.join('\n')}${g.length > 4 ? '\n…' : ''}`;
  $('#sRun').disabled = false;
}

dropZone($('#sDrop'), (files) => openSplit(files[0]));
$('#sOpen').onclick = async () => { const [f] = await api.pickPdfs(false); if (f) openSplit(f); };
document.querySelectorAll('input[name=sMode]').forEach((r) => {
  r.onchange = () => { $('#sNamed').classList.toggle('hidden', splitMode() !== 'named'); updateSplitPreview(); };
});

// 범위 · 파일 이름 표
function namedRows() {
  return [...$('#sNamedRows').children].map((tr) => ({ range: tr.querySelector('.rg').value.trim(), name: tr.querySelector('.nm').value.trim() }));
}
function addNamedRow(range = '', name = '') {
  const tr = document.createElement('tr');
  tr.innerHTML = '<td><input class="rg" type="text" placeholder="1~5"></td><td><input class="nm" type="text" placeholder="파일 이름"></td><td><button title="지우기">✕</button></td>';
  tr.querySelector('.rg').value = range;
  tr.querySelector('.nm').value = name;
  tr.querySelector('button').onclick = () => { tr.remove(); updateSplitPreview(); };
  tr.oninput = updateSplitPreview;
  $('#sNamedRows').append(tr);
}
addNamedRow();
$('#sNamedAdd').onclick = () => { addNamedRow(); updateSplitPreview(); };
// 엑셀 두 칸(쪽 범위, 파일 이름)을 붙여 넣기
$('#sNamedRows').addEventListener('paste', (e) => {
  const t = e.clipboardData.getData('text');
  if (!t.includes('\t') && !/\n./.test(t.trim())) return;
  e.preventDefault();
  if (namedRows().every((x) => !x.range && !x.name)) $('#sNamedRows').replaceChildren();
  t.split(/\r?\n/).filter((l) => l.trim()).forEach((l) => { const [a, b = ''] = l.split('\t'); addNamedRow(a.trim(), b.trim()); });
  updateSplitPreview();
});
$('#sEvery').oninput = () => { document.querySelector('input[name=sMode][value=every]').checked = true; updateSplitPreview(); };
$('#sRanges').oninput = () => { document.querySelector('input[name=sMode][value=ranges]').checked = true; updateSplitPreview(); };
$('#sPickAll').onclick = () => {
  for (let p = 0; p < split.total; p++) split.picked.add(p);
  document.querySelectorAll('#sThumbs .thumb').forEach((t) => t.classList.add('picked'));
  document.querySelector('input[name=sMode][value=picked]').checked = true;
  updateSplitPreview();
};
$('#sPickNone').onclick = () => {
  split.picked.clear();
  document.querySelectorAll('#sThumbs .thumb').forEach((t) => t.classList.remove('picked'));
  updateSplitPreview();
};
$('#sDirBtn').onclick = async () => {
  const d = await api.pickDir(split.outDir || (split.path && dirName(split.path)));
  if (d) { split.outDir = d; $('#sDir').textContent = d; }
};
$('#sRun').onclick = async () => {
  const g = await splitGroups();
  if (!g.ok) return toast(g.error, { err: true });
  const dir = split.outDir || dirName(split.path);
  const r = await busy('나누는 중…', () => api.split(split.path, g.value, dir, g.names || null));
  if (!r.ok) return toast(r.error, { err: true });
  toast(`파일 ${r.value.length}개를 만들었습니다.`, { actions: [['폴더 보기', () => api.showInFolder(r.value[0])]] });
};

// ───── 서명 넣기 ─────
const sign = { path: null, doc: null, pages: [], stamps: [], sigs: [], active: null, token: 0 };
// stamps: { id, page, sig(name), png, fx, fy, fw, fh }  f* = 쪽 너비·높이에 대한 비율(화면 크기와 무관)

async function loadSigs() {
  sign.sigs = await api.sigList();
  for (const s of sign.sigs) s.url = URL.createObjectURL(new Blob([s.png], { type: 'image/png' }));
  if (sign.active && !sign.sigs.some((s) => s.name === sign.active)) sign.active = null;
  if (!sign.active && sign.sigs.length) sign.active = sign.sigs[sign.sigs.length - 1].name;
  renderSigs();
}
function renderSigs() {
  const box = $('#gSigs');
  box.replaceChildren();
  for (const s of sign.sigs) {
    const d = document.createElement('div');
    d.className = `sig${s.name === sign.active ? ' active' : ''}`;
    d.innerHTML = '<img alt="서명"><button class="del" title="서명 지우기">✕</button>';
    d.querySelector('img').src = s.url;
    d.onclick = () => { sign.active = s.name; renderSigs(); };
    d.querySelector('.del').onclick = async (e) => {
      e.stopPropagation();
      await api.sigDelete(s.name);
      loadSigs();
    };
    box.append(d);
  }
  if (!sign.sigs.length) box.innerHTML = '<p class="muted small">아직 저장한 서명이 없습니다.</p>';
  document.querySelectorAll('.page').forEach((p) => p.classList.toggle('placing', !!sign.active));
}

async function openSign(file) {
  const token = ++sign.token;
  let doc;
  try { doc = await openPdfJs(file); } catch (e) { return toast(pdfjsErrorText(e, file), { err: true }); }
  if (token !== sign.token) return;
  if (sign.doc) sign.doc.destroy();
  Object.assign(sign, { path: file, doc, stamps: [], pages: [] });
  $('#gName').textContent = `${baseName(file)} (${doc.numPages}쪽)`;
  $('#gEmpty').style.display = 'none';
  const wrap = $('#gPages');
  wrap.replaceChildren();
  const width = Math.min(900, $('#gDrop').clientWidth - 60);
  const observer = new IntersectionObserver((entries) => {
    for (const en of entries) {
      if (!en.isIntersecting) continue;
      observer.unobserve(en.target);
      renderPage(Number(en.target.dataset.p), en.target, token);
    }
  }, { root: $('#gDrop'), rootMargin: '600px' });
  for (let p = 0; p < doc.numPages; p++) {
    const page = await doc.getPage(p + 1);
    if (token !== sign.token) return;
    const vp1 = page.getViewport({ scale: 1 });
    sign.pages.push({ page, vp1 });
    const el = document.createElement('div');
    el.className = `page${sign.active ? ' placing' : ''}`;
    el.dataset.p = p;
    el.style.width = `${width}px`;
    el.style.height = `${(width * vp1.height) / vp1.width}px`;
    el.innerHTML = `<span class="pno">${p + 1} / ${doc.numPages}</span>`;
    el.addEventListener('mousedown', (e) => placeStamp(e, p, el));
    wrap.append(el);
    observer.observe(el);
  }
  updateSignCount();
}

async function renderPage(p, el, token) {
  const { page, vp1 } = sign.pages[p];
  const w = el.clientWidth;
  const vp = page.getViewport({ scale: (w * devicePixelRatio) / vp1.width });
  const c = document.createElement('canvas');
  c.width = vp.width; c.height = vp.height;
  await page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
  if (token !== sign.token) return;
  el.prepend(c);
}

function sigByName(n) { return sign.sigs.find((s) => s.name === n); }

function placeStamp(e, p, el) {
  if (e.target !== el && e.target.tagName !== 'CANVAS') return;
  const s = sigByName(sign.active);
  if (!s) return toast('왼쪽에서 서명을 먼저 만들거나 고르세요.', { err: true });
  const img = new Image();
  img.onload = () => {
    const r = el.getBoundingClientRect();
    // 기본 크기: 쪽 너비의 22%, 단 높이가 쪽 높이의 10%를 넘지 않게
    let fw = 0.22;
    let fh = (fw * r.width * img.height) / img.width / r.height;
    if (fh > 0.1) { fw *= 0.1 / fh; fh = 0.1; }
    const fx = Math.min(Math.max((e.clientX - r.left) / r.width - fw / 2, 0), 1 - fw);
    const fy = Math.min(Math.max((e.clientY - r.top) / r.height - fh / 2, 0), 1 - fh);
    const st = { id: crypto.randomUUID(), page: p, png: s.png, url: s.url, fx, fy, fw, fh };
    sign.stamps.push(st);
    drawStamp(st, el);
    updateSignCount();
  };
  img.src = s.url;
}

function drawStamp(st, el) {
  const d = document.createElement('div');
  d.className = 'stamp';
  d.innerHTML = '<img alt=""><span class="rs" title="크기 바꾸기"></span><button class="x" title="빼기">✕</button>';
  d.querySelector('img').src = st.url;
  const place = () => Object.assign(d.style, {
    left: `${st.fx * 100}%`, top: `${st.fy * 100}%`, width: `${st.fw * 100}%`, height: `${st.fh * 100}%`,
  });
  place();
  d.querySelector('.x').onmousedown = (e) => e.stopPropagation();
  d.querySelector('.x').onclick = () => {
    sign.stamps = sign.stamps.filter((x) => x !== st);
    d.remove();
    updateSignCount();
  };
  d.addEventListener('pointerdown', (e) => {
    if (e.target.classList.contains('x')) return;
    e.preventDefault();
    e.stopPropagation();
    const r = el.getBoundingClientRect();
    const resize = e.target.classList.contains('rs');
    const start = { x: e.clientX, y: e.clientY, fx: st.fx, fy: st.fy, fw: st.fw, fh: st.fh };
    const ratio = st.fh / st.fw;
    d.setPointerCapture(e.pointerId);
    const move = (m) => {
      const dx = (m.clientX - start.x) / r.width, dy = (m.clientY - start.y) / r.height;
      if (resize) {
        // 가로세로 비율을 지킨 채 크기만
        st.fw = Math.min(Math.max(start.fw + dx, 0.03), 1 - st.fx);
        st.fh = st.fw * ratio;
        if (st.fy + st.fh > 1) { st.fh = 1 - st.fy; st.fw = st.fh / ratio; }
      } else {
        st.fx = Math.min(Math.max(start.fx + dx, 0), 1 - st.fw);
        st.fy = Math.min(Math.max(start.fy + dy, 0), 1 - st.fh);
      }
      place();
    };
    const up = () => { d.removeEventListener('pointermove', move); d.removeEventListener('pointerup', up); };
    d.addEventListener('pointermove', move);
    d.addEventListener('pointerup', up);
  });
  el.append(d);
}

function updateSignCount() {
  $('#gCount').textContent = sign.path ? `서명 ${sign.stamps.length}개` : '';
  $('#gRun').disabled = !sign.stamps.length;
}

// 화면 비율 좌표 → PDF 좌표. 쪽 회전(/Rotate)·자르기 상자 위치를 pdf.js가 계산해 준다
function stampToPdf(st) {
  const { vp1 } = sign.pages[st.page];
  const x = st.fx * vp1.width, y = st.fy * vp1.height, w = st.fw * vp1.width, h = st.fh * vp1.height;
  const [ax, ay] = vp1.convertToPdfPoint(x, y + h); // 화면에서 서명의 왼쪽 아래
  const [bx, by] = vp1.convertToPdfPoint(x + w, y + h); // 오른쪽 아래
  const [cx, cy] = vp1.convertToPdfPoint(x, y); // 왼쪽 위
  return {
    page: st.page,
    png: st.png,
    x: ax,
    y: ay,
    width: Math.hypot(bx - ax, by - ay),
    height: Math.hypot(cx - ax, cy - ay),
    rotate: (Math.atan2(by - ay, bx - ax) * 180) / Math.PI,
  };
}

dropZone($('#gDrop'), (files) => openSign(files[0]));
$('#gOpen').onclick = async () => { const [f] = await api.pickPdfs(false); if (f) openSign(f); };
$('#gRun').onclick = async () => {
  const out = await api.savePdf(sign.path.replace(/\.pdf$/i, '') + '_서명.pdf');
  if (!out) return;
  if (out.toLowerCase() === sign.path.toLowerCase()) return toast('원본 위에 덮어쓸 수 없습니다. 다른 이름을 고르세요.', { err: true });
  const r = await busy('저장하는 중…', () => api.sign(sign.path, sign.stamps.map(stampToPdf), out));
  if (!r.ok) return toast(r.error, { err: true });
  savedToast(`서명한 파일을 저장했습니다: ${baseName(out)}`, out);
};

// 서명 이미지: 여백을 잘라 PNG로
function trimToPng(canvas, { whiteToClear = false } = {}) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const { width: W, height: H } = canvas;
  const data = ctx.getImageData(0, 0, W, H);
  const px = data.data;
  if (whiteToClear) {
    for (let i = 0; i < px.length; i += 4) {
      const lum = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
      if (lum > 235) px[i + 3] = 0;
      else if (lum > 200) px[i + 3] = Math.round(px[i + 3] * (235 - lum) / 35);
    }
    ctx.putImageData(data, 0, 0);
  }
  let x0 = W, y0 = H, x1 = -1, y1 = -1;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (px[(y * W + x) * 4 + 3] > 10) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  }
  if (x1 < 0) return null;
  const m = 6;
  x0 = Math.max(0, x0 - m); y0 = Math.max(0, y0 - m); x1 = Math.min(W - 1, x1 + m); y1 = Math.min(H - 1, y1 + m);
  const out = document.createElement('canvas');
  out.width = x1 - x0 + 1; out.height = y1 - y0 + 1;
  out.getContext('2d').drawImage(canvas, x0, y0, out.width, out.height, 0, 0, out.width, out.height);
  return new Promise((res) => out.toBlob(async (b) => res(new Uint8Array(await b.arrayBuffer())), 'image/png'));
}

// 서명 그리기 패드 (캔버스는 화면 해상도의 2배로 그려 선을 매끄럽게)
const pad = $('#pad');
const SCALE = 2;
pad.width = 760 * SCALE; pad.height = 300 * SCALE;
const pctx = pad.getContext('2d');
let drawing = false, last = null, inked = false;
function padPoint(e) {
  const r = pad.getBoundingClientRect();
  return { x: ((e.clientX - r.left) / r.width) * pad.width, y: ((e.clientY - r.top) / r.height) * pad.height };
}
pad.addEventListener('pointerdown', (e) => {
  drawing = true;
  last = padPoint(e);
  pad.setPointerCapture(e.pointerId);
  pctx.beginPath();
  pctx.arc(last.x, last.y, (Number($('#padWidth').value) * SCALE) / 2, 0, Math.PI * 2);
  pctx.fillStyle = $('#padColor').value;
  pctx.fill();
  inked = true;
});
pad.addEventListener('pointermove', (e) => {
  if (!drawing) return;
  const p = padPoint(e);
  const pressure = e.pointerType === 'pen' && e.pressure ? 0.5 + e.pressure : 1;
  pctx.strokeStyle = $('#padColor').value;
  pctx.lineWidth = Number($('#padWidth').value) * SCALE * pressure;
  pctx.lineCap = 'round';
  pctx.lineJoin = 'round';
  pctx.beginPath();
  pctx.moveTo(last.x, last.y);
  pctx.lineTo(p.x, p.y);
  pctx.stroke();
  last = p;
});
const endDraw = () => { drawing = false; };
pad.addEventListener('pointerup', endDraw);
pad.addEventListener('pointercancel', endDraw);
function clearPad() { pctx.clearRect(0, 0, pad.width, pad.height); inked = false; }

$('#gDraw').onclick = () => { clearPad(); $('#padModal').classList.remove('hidden'); };
$('#padClear').onclick = clearPad;
$('#padCancel').onclick = () => $('#padModal').classList.add('hidden');
$('#padOk').onclick = async () => {
  if (!inked) return toast('서명을 먼저 그려 주세요.', { err: true });
  const png = await trimToPng(pad);
  if (!png) return toast('서명을 먼저 그려 주세요.', { err: true });
  sign.active = await api.sigSave(png);
  $('#padModal').classList.add('hidden');
  await loadSigs();
  toast(sign.path ? '서명을 저장했습니다. 문서에서 넣을 곳을 누르세요.' : '서명을 저장했습니다.');
};
$('#gImage').onclick = async () => {
  const f = await api.pickImage();
  if (!f) return;
  const r = await api.readFile(f);
  if (!r.ok) return toast(r.error, { err: true });
  const url = URL.createObjectURL(new Blob([r.value]));
  const img = new Image();
  img.onload = async () => {
    const k = Math.min(1, 1600 / Math.max(img.width, img.height));
    const c = document.createElement('canvas');
    c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    URL.revokeObjectURL(url);
    const png = await trimToPng(c, { whiteToClear: $('#gWhite').checked });
    if (!png) return toast('그림에서 서명을 찾지 못했습니다(전부 흰색인가요?).', { err: true });
    sign.active = await api.sigSave(png);
    await loadSigs();
  };
  img.onerror = () => toast('그림 파일을 열 수 없습니다.', { err: true });
  img.src = url;
};

// ───── 한글 → PDF ─────
// items: { path, state: 'wait'(아직 안 함)|'queue'(차례 기다림)|'run'|'ok'|'err', out, error }
// running: 진행 중이거나 차례를 기다리는 묶음 수
const hw = { items: [], running: 0 };

// 한글 변환은 한 번에 하나뿐 — 우클릭으로 파일이 조금씩 늦게 들어와도 차례로 처리한다
let hwpChain = Promise.resolve();
let hwpCancelGen = 0;
let hwpListener = null;
api.onHwpProgress((p) => { if (hwpListener) hwpListener(p); });
function convertQueued(files, toTemp, onProgress, format = 'PDF') {
  const gen = hwpCancelGen;
  const run = hwpChain.then(async () => {
    if (gen !== hwpCancelGen) return { ok: true, value: files.map((src) => ({ src, error: '사용자가 중지함' })) };
    hwpListener = onProgress;
    try { return await api.hwpConvert(files, toTemp, format); } finally { hwpListener = null; }
  });
  hwpChain = run.catch(() => {});
  return run;
}

function addToHwp(paths) {
  // 다 끝난 목록에 새로 넣으면 지난 결과는 비운다
  if (!hw.running && hw.items.length && hw.items.every((i) => i.state === 'ok' || i.state === 'err')) hw.items = [];
  for (const p of paths.slice().sort((a, b) => collator.compare(baseName(a), baseName(b)))) {
    if (!hw.items.some((i) => i.path === p)) hw.items.push({ path: p, state: 'wait' });
  }
  renderHwp();
}

const HW_CHIP = { wait: '대기', queue: '대기', run: '변환 중…', ok: '완료', err: '실패' };
function renderHwp() {
  const list = $('#hList');
  list.replaceChildren();
  hw.items.forEach((it, i) => {
    const li = document.createElement('li');
    if (it.state === 'err') li.classList.add('err');
    li.innerHTML = `<span class="no">${i + 1}</span><span class="nm"><b></b><span></span></span><span class="chip ${it.state}"></span><span class="acts"></span>`;
    li.querySelector('.nm b').textContent = baseName(it.path);
    li.querySelector('.nm span').textContent = it.state === 'err' ? it.error : it.state === 'ok' ? `→ ${baseName(it.out)}` : dirName(it.path);
    li.querySelector('.chip').textContent = HW_CHIP[it.state];
    const acts = li.querySelector('.acts');
    if (it.state === 'ok') {
      acts.append(Object.assign(document.createElement('button'), { textContent: '열기', onclick: () => api.openPath(it.out) }));
    } else if (!hw.running) {
      const x = Object.assign(document.createElement('button'), { textContent: '✕', title: '빼기' });
      x.onclick = () => { hw.items.splice(i, 1); renderHwp(); };
      acts.append(x);
    }
    list.append(li);
  });
  $('#hEmpty').style.display = hw.items.length ? 'none' : '';
  const todo = hw.items.filter((i) => i.state === 'wait').length;
  const ok = hw.items.filter((i) => i.state === 'ok').length;
  const bad = hw.items.filter((i) => i.state === 'err').length;
  $('#hSummary').textContent = !hw.items.length ? ''
    : hw.running ? `변환 중 ${ok + bad}/${hw.items.filter((i) => i.state !== 'wait').length}`
      : todo ? `${hw.items.length}개 문서` : `완료 ${ok}개${bad ? ` · 실패 ${bad}개` : ''}`;
  $('#hRun').disabled = $('#hMerge').disabled = hw.running || !todo;
  $('#hHwpx').disabled = hw.running || !hw.items.some((i) => i.state === 'wait' && /\.hwp$/i.test(i.path));
  $('#hAdd').disabled = $('#hClear').disabled = hw.running;
  $('#hStop').classList.toggle('hidden', !hw.running);
}

async function runHwp(format = 'PDF') {
  const todo = hw.items.filter((i) => i.state === 'wait');
  if (!todo.length) return;
  todo.forEach((i) => { i.state = 'queue'; });
  hw.running++;
  renderHwp();
  const r = await convertQueued(todo.map((i) => i.path), false, (p) => {
    const it = todo[p.i];
    if (!it) return;
    it.state = p.state;
    if (p.out) it.out = p.out;
    if (p.error) it.error = p.error;
    renderHwp();
  }, format);
  hw.running--;
  if (!r.ok) {
    todo.forEach((i) => { if (i.state !== 'ok') Object.assign(i, { state: 'err', error: r.error }); });
    renderHwp();
    return toast(r.error, { err: true });
  }
  r.value.forEach((x, k) => Object.assign(todo[k], x.out ? { state: 'ok', out: x.out } : { state: 'err', error: x.error }));
  renderHwp();
  // 뒤에 기다리는 묶음이 있으면 다 끝난 뒤 한 번만 알린다
  if (hw.running) return;
  const finished = hw.items.filter((i) => i.state === 'ok' || i.state === 'err');
  const ok = finished.filter((i) => i.state === 'ok');
  const bad = finished.length - ok.length;
  if (!ok.length) return toast(`변환하지 못했습니다: ${finished[0].error}`, { err: true });
  toast(`파일 ${ok.length}개를 만들었습니다${bad ? ` (실패 ${bad}개)` : ''}.`, { err: bad > 0, actions: [['폴더 보기', () => api.showInFolder(ok[0].out)]] });
}

dropZone($('#hDrop'), addToHwp, { accept: HWP_RE, wrong: '한글 문서(hwp, hwpx)만 넣을 수 있습니다.' });
$('#hAdd').onclick = async () => addToHwp(await api.pickHwps());
$('#hClear').onclick = () => { hw.items = []; renderHwp(); };
$('#hRun').onclick = () => runHwp('PDF');
$('#hHwpx').onclick = () => runHwp('HWPX');
$('#hStop').onclick = () => { hwpCancelGen++; api.hwpCancel(); $('#hSummary').textContent = '지금 문서까지만 바꾸고 멈춥니다…'; };
$('#hMerge').onclick = async () => {
  const paths = hw.items.filter((i) => i.state === 'wait').map((i) => i.path);
  hw.items = hw.items.filter((i) => i.state !== 'wait');
  renderHwp();
  showTab('merge');
  await addHwpToMerge(paths, { fromShell: true });
};

// ───── 설정 ─────
$('#btnSettings').onclick = async () => {
  $('#setModal').classList.remove('hidden');
  $('#ctxToggle').checked = await api.ctxStatus();
  $('#ctxNote').textContent = info.packaged
    ? '윈도우 11에서는 오른쪽 클릭 → "추가 옵션 표시"(Shift+F10) 안에 나타납니다.'
    : '개발 실행 중에는 바꿀 수 없습니다. 설치한 프로그램에서 바꾸세요.';
  $('#ctxToggle').disabled = !info.packaged;
  refreshMenu11();
  if (!$('#noticeText').textContent) $('#noticeText').textContent = await (await fetch('NOTICE.txt')).text();
};

// 윈도우 11 첫 화면 메뉴
async function refreshMenu11(msg) {
  const s = await api.menu11Status();
  $('#m11Toggle').checked = !!s.registered;
  $('#m11Toggle').disabled = !s.supported || s.dev;
  $('#m11Admin').classList.add('hidden');
  $('#m11Note').textContent = msg || (!s.supported ? '윈도우 11에서만 쓸 수 있습니다(윈도우 10은 위 메뉴가 바로 보입니다).'
    : s.dev ? '개발 실행 중에는 바꿀 수 없습니다. 설치한 프로그램에서 바꾸세요.'
      : s.registered ? '켜짐 — 파일 탐색기에서 오른쪽 클릭하면 첫 화면에 보입니다.' : '꺼짐');
}
async function setMenu11(on, admin = false) {
  $('#m11Toggle').disabled = true;
  $('#m11Note').textContent = on ? '등록하는 중… (몇 초 걸립니다)' : '끄는 중…';
  const r = await api.menu11Set(on, admin);
  if (r.ok) return refreshMenu11();
  await refreshMenu11(r.needAdmin
    ? '이 컴퓨터에서는 처음 한 번 관리자 권한이 필요합니다(메뉴 서명 인증서 등록). 아래 단추를 누르고 "예"를 고르세요.'
    : `켜지 못했습니다: ${r.error}`);
  if (r.needAdmin) $('#m11Admin').classList.remove('hidden');
}
$('#m11Toggle').onchange = (e) => setMenu11(e.target.checked);
$('#m11AdminBtn').onclick = () => setMenu11(true, true);
$('#ctxToggle').onchange = async (e) => {
  const r = await api.ctxSet(e.target.checked);
  if (!r.ok) { toast(r.error || '바꾸지 못했습니다.', { err: true }); e.target.checked = !e.target.checked; }
};
$('#setClose').onclick = () => $('#setModal').classList.add('hidden');
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') document.querySelectorAll('.modal').forEach((m) => m.classList.add('hidden'));
});

// ───── 시작 ─────
api.onOpenFiles(({ mode, files }) => {
  if (mode === 'merge') {
    showTab('merge');
    addToMerge(files.slice().sort(byName), { fromShell: true });
  } else if (mode === 'hwp2pdf' || mode === 'hwp2hwpx') {
    showTab('hwp');
    addToHwp(files.filter((f) => (mode === 'hwp2hwpx' ? /\.hwp$/i : HWP_RE).test(f)));
    runHwp(mode === 'hwp2hwpx' ? 'HWPX' : 'PDF');
  } else if (mode === 'hwpmerge') {
    showTab('merge');
    addAnyToMerge(files, { fromShell: true });
  } else if (mode === 'split') {
    showTab('split');
    openSplit(files[0]);
  } else {
    showTab('sign');
    openSign(files[0]);
  }
});

initTools({ $, api, toast, savedToast, busy, openPdfJs, pdfjsErrorText, dropZone, baseName, dirName, collator });
initEdit({ $, api, toast, savedToast, busy, dropZone, baseName, dirName });

let info = { packaged: false };
renderMerge();
renderHwp();
loadSigs();
api.ready().then((v) => {
  info = v;
  $('#verInfo').textContent = `버전 ${v.version}`;
});
