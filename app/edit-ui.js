// 글자 · 그림 편집 화면 — 쪽 그림 위에 줄·그림 상자를 겹쳐 놓고, 누르면 고친다.
// 실제 처리(MuPDF·pdf-lib)는 main의 pdfedit.js. 좌표는 MuPDF 쪽 좌표(pt, 왼쪽 위 원점).
export function initEdit(ctx) {
  const { $, api, toast, savedToast, busy, dropZone, baseName, dirName } = ctx;
  const E = { path: null, pages: 0, page: 0, info: null, k: 1, mode: 'select', dirty: false, canUndo: false, token: 0 };
  const HELP = {
    select: '글자 줄을 누르면 고칠 수 있습니다(Enter 적용, Shift+Enter 줄바꿈, Esc 취소). 그림을 누르면 끌어서 옮기거나 오른쪽 아래 점으로 크기를 바꾸고, 바꾸기·지우기를 할 수 있습니다.',
    text: '새 글자를 넣을 자리를 누르고 쓰세요. 글꼴·크기·색은 왼쪽에서 고릅니다. Enter로 넣고, 줄을 바꾸려면 Shift+Enter.',
    image: '그림을 넣을 자리를 누르면 그림 파일(PNG·JPG)을 고릅니다. 넣은 뒤 \'고치기\'에서 옮기거나 크기를 바꿀 수 있습니다.',
    erase: '지울 부분을 끌어서 상자로 고르세요. 상자 안의 글자·그림·선을 실제로 지웁니다(개인정보 가리기에도 씁니다).',
  };
  const layer = $('#dLayer');
  const hex = (c) => `#${c.map((v) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, '0')).join('')}`;
  const unhex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
  // 화면 px ↔ 쪽 좌표
  const toPx = (x, y) => [(x - E.info.x0) * E.k, (y - E.info.y0) * E.k];
  const toPt = (px, py) => [px / E.k + E.info.x0, py / E.k + E.info.y0];

  function setMode(m) {
    closeFloat();
    E.mode = m;
    document.querySelectorAll('#dModes button').forEach((b) => b.classList.toggle('on', b.dataset.m === m));
    layer.className = `edit-layer m-${m}`;
    $('#dHelp').textContent = HELP[m];
  }
  function setState(s) {
    E.dirty = s.dirty; E.canUndo = s.canUndo;
    $('#dUndo').disabled = !E.canUndo;
    $('#dRun').disabled = !E.path;
    $('#dNote').textContent = E.dirty ? '저장하지 않은 편집이 있습니다.' : '';
  }

  async function open(file) {
    if (E.dirty && !confirm('편집한 내용을 저장하지 않았습니다. 다른 PDF를 열까요?')) return;
    const r = await busy('PDF 여는 중…', () => api.editOpen(file));
    if (!r.ok) return toast(r.error, { err: true });
    Object.assign(E, { path: file, pages: r.value.pages, page: 0 });
    $('#dFont').replaceChildren(new Option('원래와 비슷하게', 'auto'), ...r.value.fonts.map((f) => new Option(f.name, f.key)));
    $('#dName').textContent = `${baseName(file)} (${E.pages}쪽)`;
    $('#dEmpty').style.display = 'none';
    $('#dDrop').classList.add('loaded');
    setState(r.value);
    await draw();
  }

  async function draw() {
    if (!E.path) return;
    closeFloat();
    const token = ++E.token;
    // 쪽 맞춤은 스크롤 영역(쪽 넘김 막대 아래)의 크기에 맞춘다
    const drop = $('#dDrop');
    const availW = drop.clientWidth - 48, availH = drop.clientHeight - $('#dDrop .pv-nav').offsetHeight - 36;
    const zoom = $('#dZoom').value;
    let info = await api.editPage(E.page, 0.05);
    if (!info.ok) return toast(info.error, { err: true });
    const { w, h } = info.value;
    const k = zoom === 'fit' ? Math.max(0.2, Math.min(availW / w, availH / h)) : Number(zoom) * (96 / 72);
    info = await api.editPage(E.page, k * devicePixelRatio);
    if (token !== E.token) return;
    if (!info.ok) return toast(info.error, { err: true });
    E.info = info.value; E.k = k;
    const img = $('#dImg');
    if (img.src) URL.revokeObjectURL(img.src);
    img.src = URL.createObjectURL(new Blob([E.info.png], { type: 'image/png' }));
    img.style.width = `${w * k}px`; img.style.height = `${h * k}px`;
    $('#dPno').textContent = `${E.page + 1} / ${E.pages}쪽`;
    buildLayer();
  }

  function box(el, [x0, y0, x1, y1]) {
    const [a, b] = toPx(x0, y0), [c, d] = toPx(x1, y1);
    Object.assign(el.style, { left: `${a}px`, top: `${b}px`, width: `${c - a}px`, height: `${d - b}px` });
    return el;
  }
  function buildLayer() {
    layer.replaceChildren();
    // 그림을 먼저(아래), 줄을 나중(위)에 — 스캔 배경 그림 위의 글자도 누를 수 있게
    E.info.images.forEach((im) => {
      const d = box(document.createElement('div'), im.bbox);
      d.className = 'im';
      d.title = '그림 — 눌러서 옮기기·크기·바꾸기·지우기';
      d.onclick = (e) => { e.stopPropagation(); selectImage(im); };
      layer.append(d);
    });
    E.info.lines.forEach((ln) => {
      const d = box(document.createElement('div'), ln.bbox);
      d.className = 'ln';
      d.title = ln.text;
      d.onclick = (e) => { e.stopPropagation(); editLine(ln); };
      layer.append(d);
    });
  }

  // 떠 있는 편집 상자·막대
  let floats = [];
  function closeFloat() { floats.forEach((f) => f.remove()); floats = []; }
  function float(el) { floats.push(el); $('#dInner').append(el); return el; }
  function bar(x, y, buttons) {
    const b = float(document.createElement('div'));
    b.className = 'float-bar';
    Object.assign(b.style, { left: `${x}px`, top: `${y}px` });
    for (const [label, fn, primary] of buttons) {
      const btn = Object.assign(document.createElement('button'), { textContent: label });
      if (primary) btn.className = 'primary';
      btn.onclick = (e) => { e.stopPropagation(); fn(); };
      b.append(btn);
    }
    return b;
  }
  function textBox(x, y, { text = '', size, width, height }) {
    const wrap = float(document.createElement('div'));
    wrap.className = 'edit-box';
    Object.assign(wrap.style, { left: `${x}px`, top: `${y}px` });
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.spellcheck = false;
    const px = size * E.k;
    Object.assign(ta.style, { fontSize: `${px}px`, width: `${Math.max(width, 120)}px`, height: `${Math.max(height, px * 1.4 * Math.max(1, text.split('\n').length)) + 6}px`, color: $('#dColor').value, fontWeight: $('#dBold').checked ? '700' : '400' });
    ta.addEventListener('mousedown', (e) => e.stopPropagation());
    wrap.append(ta);
    setTimeout(() => { ta.focus(); ta.select(); }, 0);
    return ta;
  }
  const style = () => ({ size: Number($('#dSize').value) || 12, color: unhex($('#dColor').value), bold: $('#dBold').checked, font: $('#dFont').value });

  async function apply(op, msg = '고치는 중…') {
    closeFloat();
    const r = await busy(msg, () => api.editApply({ page: E.page, ...op }));
    if (!r.ok) return toast(r.error, { err: true });
    setState(r.value);
    await draw();
  }

  // 줄 고치기
  function editLine(ln) {
    closeFloat();
    $('#dSize').value = Math.round(ln.size * 10) / 10;
    $('#dColor').value = hex(ln.color);
    $('#dBold').checked = ln.bold;
    $('#dFont').value = 'auto';
    const [x, y] = toPx(ln.bbox[0], ln.bbox[1]), [x1, y1] = toPx(ln.bbox[2], ln.bbox[3]);
    const ta = textBox(x - 4, y - 3, { text: ln.text, size: ln.size, width: x1 - x + 24, height: y1 - y });
    const done = () => {
      const st = style();
      const same = ta.value === ln.text && st.size === Math.round(ln.size * 10) / 10 && $('#dColor').value === hex(ln.color) && st.bold === ln.bold && st.font === 'auto';
      if (same) return closeFloat();
      apply({ type: 'text', bbox: ln.bbox, origin: ln.origin, text: ta.value, size: st.size, color: st.color, bold: st.bold, fontKey: st.font === 'auto' ? ln.fontKey : st.font });
    };
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); done(); }
      if (e.key === 'Escape') { e.stopPropagation(); closeFloat(); }
    });
    bar(x - 4, y1 + Math.max(ta.offsetHeight, 20) + 4, [['적용', done, true], ['이 줄 지우기', () => apply({ type: 'text', bbox: ln.bbox, origin: ln.origin, text: '', size: ln.size, color: ln.color, fontKey: ln.fontKey })], ['취소', closeFloat]]);
  }

  // 새 글상자
  function newText(px, py) {
    const st = style();
    const ta = textBox(px, py, { size: st.size, width: 220, height: st.size * E.k * 1.4 });
    const [x, y] = toPt(px + 5, py + 3);
    const done = () => {
      if (!ta.value.trim()) return closeFloat();
      const s = style();
      apply({ type: 'addText', x, y, text: ta.value, size: s.size, color: s.color, bold: s.bold, fontKey: s.font === 'auto' ? 'gothic' : s.font }, '넣는 중…');
    };
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); done(); }
      if (e.key === 'Escape') { e.stopPropagation(); closeFloat(); }
    });
    bar(px, py - 38, [['넣기', done, true], ['취소', closeFloat]]);
  }

  // 그림 고르기: 끌어서 옮기기, 오른쪽 아래 점으로 크기(비율 유지)
  function selectImage(im) {
    closeFloat();
    const sel = float(document.createElement('div'));
    sel.className = 'sel-img';
    box(sel, im.bbox);
    sel.append(document.createElement('i'));
    let r = { ...Object.fromEntries(['left', 'top', 'width', 'height'].map((k) => [k, parseFloat(sel.style[k])])) };
    const start0 = { ...r };
    const ratio = r.width / r.height;
    let mode = null, sx = 0, sy = 0, s0 = null;
    sel.addEventListener('pointerdown', (e) => {
      mode = e.target.tagName === 'I' ? 'size' : 'move';
      sx = e.clientX; sy = e.clientY; s0 = { ...r };
      sel.setPointerCapture(e.pointerId);
      e.preventDefault(); e.stopPropagation();
    });
    sel.addEventListener('pointermove', (e) => {
      if (!mode) return;
      const dx = e.clientX - sx, dy = e.clientY - sy;
      if (mode === 'move') { r.left = s0.left + dx; r.top = s0.top + dy; } else {
        r.width = Math.max(16, s0.width + Math.max(dx, dy * ratio));
        r.height = r.width / ratio;
      }
      Object.assign(sel.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
    });
    sel.addEventListener('pointerup', () => { mode = null; });
    sel.addEventListener('click', (e) => e.stopPropagation());
    const moved = () => ['left', 'top', 'width', 'height'].some((k) => Math.abs(r[k] - start0[k]) > 0.5);
    const place = () => {
      if (!moved()) return closeFloat();
      const [x0, y0] = toPt(r.left, r.top), [x1, y1] = toPt(r.left + r.width, r.top + r.height);
      apply({ type: 'moveImage', index: im.index, rect: [x0, y0, x1, y1] }, '옮기는 중…');
    };
    const replace = async () => {
      const f = await api.pickImage();
      if (f) apply({ type: 'replaceImage', index: im.index, file: f }, '바꾸는 중…');
    };
    bar(r.left, Math.max(0, r.top - 38), [['여기에 두기', place, true], ['다른 그림으로', replace], ['지우기', () => apply({ type: 'deleteImage', index: im.index }, '지우는 중…')], ['취소', closeFloat]]);
  }

  // 그림 넣기
  async function newImage(px, py) {
    const f = await api.pickImage();
    if (!f) return;
    const s = await api.editImageSize(f);
    if (!s.ok) return toast(s.error, { err: true });
    const w = Math.min(160, E.info.w * 0.5), h = (w * s.value.h) / s.value.w;
    const [x, y] = toPt(px, py);
    apply({ type: 'addImage', rect: [x - w / 2, y - h / 2, x + w / 2, y + h / 2], file: f }, '넣는 중…');
  }

  // 영역 지우기: 끌어서 상자
  let drag = null;
  layer.addEventListener('pointerdown', (e) => {
    if (!E.info || e.target !== layer) return;
    const rc = layer.getBoundingClientRect();
    const px = e.clientX - rc.left, py = e.clientY - rc.top;
    if (E.mode === 'text') { closeFloat(); newText(px, py); return; }
    if (E.mode === 'image') { closeFloat(); newImage(px, py); return; }
    if (E.mode === 'select') { closeFloat(); return; }
    closeFloat();
    const d = float(document.createElement('div'));
    d.className = 'erase-box';
    drag = { px, py, d, rc };
    layer.setPointerCapture(e.pointerId);
  });
  layer.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const x = e.clientX - drag.rc.left, y = e.clientY - drag.rc.top;
    Object.assign(drag.d.style, { left: `${Math.min(x, drag.px)}px`, top: `${Math.min(y, drag.py)}px`, width: `${Math.abs(x - drag.px)}px`, height: `${Math.abs(y - drag.py)}px` });
  });
  layer.addEventListener('pointerup', () => {
    if (!drag) return;
    const { d } = drag;
    drag = null;
    const l = parseFloat(d.style.left), t = parseFloat(d.style.top), w = parseFloat(d.style.width), h = parseFloat(d.style.height);
    if (!(w > 4 && h > 4)) return closeFloat();
    const [x0, y0] = toPt(l, t), [x1, y1] = toPt(l + w, t + h);
    bar(l, t + h + 6, [['이 부분 지우기', () => apply({ type: 'deleteArea', rect: [x0, y0, x1, y1] }, '지우는 중…'), true], ['취소', closeFloat]]);
  });

  async function undo() {
    if (!E.canUndo) return;
    const r = await api.editUndo();
    if (!r.ok) return toast(r.error, { err: true });
    setState(r.value);
    await draw();
  }

  document.querySelectorAll('#dModes button').forEach((b) => { b.onclick = () => setMode(b.dataset.m); });
  $('#dOpen').onclick = async () => { const [f] = await api.pickPdfs(false); if (f) open(f); };
  dropZone($('#dDrop'), (files) => open(files[0]));
  $('#dPrev').onclick = () => { if (E.page > 0) { E.page--; draw(); } };
  $('#dNext').onclick = () => { if (E.page < E.pages - 1) { E.page++; draw(); } };
  $('#dZoom').onchange = draw;
  $('#dUndo').onclick = undo;
  document.addEventListener('keydown', (e) => {
    if (!$('#tab-edit').classList.contains('active') || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'INPUT') return;
    if (e.ctrlKey && e.key.toLowerCase() === 'z') { e.preventDefault(); undo(); }
    if (e.key === 'PageDown') $('#dNext').click();
    if (e.key === 'PageUp') $('#dPrev').click();
  });
  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { if ($('#dZoom').value === 'fit' && $('#tab-edit').classList.contains('active')) draw(); }, 250);
  });
  $('#dRun').onclick = async () => {
    const out = await api.savePdf(`${dirName(E.path)}\\${baseName(E.path).replace(/\.pdf$/i, '')}_편집.pdf`);
    if (!out) return;
    const r = await busy('저장하는 중…', () => api.editSave(out));
    if (!r.ok) return toast(r.error, { err: true });
    setState(r.value);
    savedToast(`저장했습니다: ${baseName(out)}`, out);
  };
  setMode('select');

  // 처음 탭을 열 때 아직 그리지 못했으면(창 크기 0) 다시 그린다
  document.querySelector('.tab[data-tab=edit]').addEventListener('click', () => { if (E.path) setTimeout(draw, 0); });
}
