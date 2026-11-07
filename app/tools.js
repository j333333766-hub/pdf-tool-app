// PDF 종합툴에서 가져온 화면들 — 평가지 학생별 분할, 쪽 정리·회전, 두 쪽 나누기, 영역 자르기,
// 쪽번호·워터마크, 용량 줄이기, PDF → 그림. 공통 도구(ctx)는 renderer.js가 넘겨준다.
export function initTools(ctx) {
  const { $, api, toast, savedToast, busy, openPdfJs, pdfjsErrorText, dropZone, baseName, dirName, collator } = ctx;
  const PDF_RE = /\.pdf$/i;
  const stripPdf = (p) => baseName(p).replace(PDF_RE, '');
  const radio = (name) => document.querySelector(`input[name=${name}]:checked`).value;
  const folderToast = (msg, dir) => toast(msg, { actions: [['폴더 열기', () => api.openPath(dir)]] });

  // 결과 PDF 저장 위치 — 원본 옆 "이름_꼬리표.pdf"를 기본으로, 원본 덮어쓰기는 막는다
  async function savePdfNear(src, tag) {
    const out = await api.savePdf(`${dirName(src)}\\${stripPdf(src)}_${tag}.pdf`);
    if (out && out.toLowerCase() === src.toLowerCase()) {
      toast('원본 파일 위에 덮어쓸 수 없습니다. 다른 이름을 고르세요.', { err: true });
      return null;
    }
    return out;
  }

  // 범위 + 홀짝 → 0-based 쪽 목록
  async function pickPages(rangeText, parity, total) {
    const r = await api.parsePages(rangeText, total);
    if (!r.ok) return r;
    const odd = parity === 'odd', even = parity === 'even';
    const v = r.value.filter((i) => (odd ? i % 2 === 0 : even ? i % 2 === 1 : true));
    if (!v.length) return { ok: false, error: '조건에 맞는 쪽이 없습니다.' };
    return { ok: true, value: v };
  }

  // PDF 하나를 여는 화면의 공통 뼈대: 'PDF 열기' 단추, 끌어다 놓기, 파일 이름 표시
  function single(p, onOpen) {
    const st = { path: null, doc: null, total: 0, token: 0 };
    async function open(file) {
      const token = ++st.token;
      let doc;
      try { doc = await openPdfJs(file); } catch (e) { return toast(pdfjsErrorText(e, file), { err: true }); }
      if (token !== st.token) return;
      if (st.doc) st.doc.destroy();
      Object.assign(st, { path: file, doc, total: doc.numPages });
      $(`#${p}Name`).textContent = `${baseName(file)} (${doc.numPages}쪽)`;
      $(`#${p}Empty`).style.display = 'none';
      $(`#${p}Run`).disabled = false;
      await onOpen(st, token);
    }
    st.open = open;
    dropZone($(`#${p}Drop`), (files) => open(files[0]));
    $(`#${p}Open`).onclick = async () => { const [f] = await api.pickPdfs(false); if (f) open(f); };
    return st;
  }

  // 미리보기 그림 한 장 (CSS 폭 width px)
  async function renderPage(doc, p, width) {
    const page = await doc.getPage(p + 1);
    const vp1 = page.getViewport({ scale: 1 });
    const vp = page.getViewport({ scale: (width * devicePixelRatio) / vp1.width });
    const c = document.createElement('canvas');
    c.width = vp.width; c.height = vp.height;
    c.style.width = `${width}px`;
    await page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
    return c;
  }

  // 썸네일 격자 — 보이는 것부터 그린다. 반환: 쪽별 요소 배열
  function thumbGrid(wrap, st, token, { label = (p) => `${p + 1}` } = {}) {
    wrap.replaceChildren();
    const els = [];
    const io = new IntersectionObserver((entries) => {
      for (const en of entries) {
        if (!en.isIntersecting) continue;
        io.unobserve(en.target);
        const p = Number(en.target.dataset.p);
        renderPage(st.doc, p, 140).then((c) => {
          if (token !== st.token) return;
          en.target.querySelector('.ph').replaceWith(c);
          en.target.dispatchEvent(new Event('rendered'));
        }).catch(() => {});
      }
    }, { root: wrap.parentElement, rootMargin: '400px' });
    for (let p = 0; p < st.total; p++) {
      const t = document.createElement('div');
      t.className = 'thumb';
      t.dataset.p = p;
      t.innerHTML = `<div class="cv-box"><div class="ph"></div></div><div class="pn"></div>`;
      t.querySelector('.pn').textContent = label(p);
      wrap.append(t);
      io.observe(t);
      els.push(t);
    }
    return els;
  }

  // ───── 쪽 회전 ─────
  {
    let els = [];
    const rt = single('r', (st, token) => { els = thumbGrid($('#rThumbs'), st, token); els.forEach((e) => e.addEventListener('rendered', update)); update(); });
    async function update() {
      if (!rt.path) return;
      const r = await pickPages($('#rRange').value, radio('rParity'), rt.total);
      const note = $('#rNote');
      note.classList.toggle('err', !r.ok);
      $('#rRun').disabled = !r.ok;
      const set = new Set(r.ok ? r.value : []);
      const angle = Number(radio('rAngle'));
      els.forEach((e, i) => {
        e.classList.toggle('picked', set.has(i));
        const c = e.querySelector('canvas');
        if (c) c.style.transform = set.has(i) ? `rotate(${angle}deg) scale(${angle % 180 ? 0.72 : 1})` : '';
      });
      note.textContent = r.ok ? `${set.size}쪽을 돌립니다.` : r.error;
    }
    $('#rRange').oninput = update;
    document.querySelectorAll('input[name=rParity], input[name=rAngle]').forEach((x) => { x.onchange = update; });
    $('#rRun').onclick = async () => {
      const r = await pickPages($('#rRange').value, radio('rParity'), rt.total);
      if (!r.ok) return toast(r.error, { err: true });
      const out = await savePdfNear(rt.path, '회전');
      if (!out) return;
      const res = await busy('돌리는 중…', () => api.rotate(rt.path, r.value, Number(radio('rAngle')), out));
      if (!res.ok) return toast(res.error, { err: true });
      savedToast(`${res.value.count}쪽을 돌려 저장했습니다: ${baseName(out)}`, out);
    };
  }

  // ───── 쪽 정리 ─────
  {
    const og = { items: [], canvases: new Map(), dragFrom: null };
    const st = single('o', (s) => { reset(); });
    function reset() {
      og.items = Array.from({ length: st.total }, (_, p) => ({ p, rot: 0 }));
      og.canvases = new Map();
      render();
    }
    const io = new IntersectionObserver((entries) => {
      for (const en of entries) {
        if (!en.isIntersecting) continue;
        io.unobserve(en.target);
        const p = Number(en.target.dataset.p), token = st.token;
        if (og.canvases.has(p)) continue;
        og.canvases.set(p, null);
        renderPage(st.doc, p, 140).then((c) => {
          if (token !== st.token) return;
          og.canvases.set(p, c);
          render();
        });
      }
    }, { root: $('#oDrop'), rootMargin: '400px' });
    function render() {
      const grid = $('#oGrid');
      grid.replaceChildren();
      og.items.forEach((it, i) => {
        const t = document.createElement('div');
        t.className = 'thumb';
        t.draggable = true;
        t.dataset.i = i;
        t.dataset.p = it.p;
        t.innerHTML = `<div class="cv-box"></div><div class="pn"></div><div class="acts"><button data-a="rot" title="90° 돌리기">↻</button><button data-a="del" title="지우기">✕</button></div>`;
        t.querySelector('.pn').textContent = `${i + 1}  (원래 ${it.p + 1}쪽)`;
        const c = og.canvases.get(it.p);
        if (c) { c.style.transform = it.rot ? `rotate(${it.rot}deg) scale(${it.rot % 180 ? 0.72 : 1})` : ''; t.querySelector('.cv-box').append(c); } else {
          t.querySelector('.cv-box').innerHTML = '<div class="ph"></div>';
          if (!og.canvases.has(it.p)) io.observe(t);
        }
        t.querySelector('.acts').onclick = (e) => {
          const a = e.target.dataset.a;
          if (a === 'rot') it.rot = (it.rot + 90) % 360;
          if (a === 'del') og.items.splice(i, 1);
          if (a) render();
        };
        grid.append(t);
      });
      $('#oCount').textContent = st.path ? `${og.items.length}쪽` : '';
      $('#oRun').disabled = !st.path || !og.items.length;
    }
    const grid = $('#oGrid');
    grid.addEventListener('dragstart', (e) => {
      const t = e.target.closest('.thumb');
      if (!t) return;
      og.dragFrom = Number(t.dataset.i);
      e.dataTransfer.setData('application/x-pdftool-page', String(og.dragFrom));
      t.classList.add('dragging');
    });
    grid.addEventListener('dragover', (e) => {
      if (og.dragFrom == null) return;
      e.preventDefault();
      grid.querySelectorAll('.drop-before').forEach((x) => x.classList.remove('drop-before'));
      const t = e.target.closest('.thumb');
      if (t) t.classList.add('drop-before');
    });
    grid.addEventListener('drop', (e) => {
      if (og.dragFrom == null) return;
      e.preventDefault();
      e.stopPropagation();
      const t = e.target.closest('.thumb');
      let to = t ? Number(t.dataset.i) : og.items.length;
      const [moved] = og.items.splice(og.dragFrom, 1);
      if (to > og.dragFrom) to -= 1;
      og.items.splice(to, 0, moved);
      og.dragFrom = null;
      render();
    });
    grid.addEventListener('dragend', () => { og.dragFrom = null; render(); });
    $('#oRotAll').onclick = () => { og.items.forEach((it) => { it.rot = (it.rot + 90) % 360; }); render(); };
    $('#oReverse').onclick = () => { og.items.reverse(); render(); };
    $('#oReset').onclick = () => { if (st.path) reset(); };
    $('#oRun').onclick = async () => {
      const out = await savePdfNear(st.path, '정리');
      if (!out) return;
      const res = await busy('저장하는 중…', () => api.organize(st.path, og.items.map(({ p, rot }) => ({ p, rot })), out));
      if (!res.ok) return toast(res.error, { err: true });
      savedToast(`${res.value.pages}쪽짜리로 정리해 저장했습니다: ${baseName(out)}`, out);
    };
    render();
  }

  // 한 쪽 미리보기 (두 쪽 나누기·영역 자르기 공용) — 화면 크기에 맞춰 그린다
  async function stagePreview(st, p, canvas, inner) {
    const page = await st.doc.getPage(p + 1);
    const vp1 = page.getViewport({ scale: 1 });
    const wrap = inner.closest('.stage');
    const maxW = Math.max(200, wrap.clientWidth - 40), maxH = Math.max(200, wrap.clientHeight - 30);
    const scale = Math.min(maxW / vp1.width, maxH / vp1.height);
    const vp = page.getViewport({ scale });
    const hi = page.getViewport({ scale: scale * devicePixelRatio });
    canvas.width = hi.width; canvas.height = hi.height;
    canvas.style.width = `${vp.width}px`; canvas.style.height = `${vp.height}px`;
    await page.render({ canvasContext: canvas.getContext('2d'), viewport: hi }).promise;
    return vp; // CSS 픽셀 기준 viewport
  }

  // ───── 두 쪽 → 한 쪽씩 ─────
  {
    let pv = 0, scope = new Set();
    const st = single('u', async () => { pv = 0; $('#uDrop').classList.add('loaded'); await draw(); });
    async function draw() {
      await stagePreview(st, pv, $('#uCanvas'), $('#uInner'));
      $('#uPno').textContent = `${pv + 1} / ${st.total}쪽`;
      await overlay();
    }
    async function overlay() {
      if (!st.path) return;
      const r = await api.parsePages($('#uRange').value, st.total);
      scope = new Set(r.ok ? r.value : []);
      const note = $('#uNote');
      note.classList.toggle('err', !r.ok);
      $('#uRun').disabled = !r.ok;
      const on = scope.has(pv), lr = radio('uDir') === 'lr';
      const [a, b] = radio('uOrder') === 'first' ? ['1', '2'] : ['2', '1'];
      $('#uLine').className = `split-line ${lr ? 'v' : 'h'}`;
      $('#uLine').style.display = on ? '' : 'none';
      const t1 = $('#uTag1'), t2 = $('#uTag2');
      t1.textContent = a; t2.textContent = b;
      t1.style.cssText = `display:${on ? 'block' : 'none'};left:8px;top:8px`;
      t2.style.cssText = `display:${on ? 'block' : 'none'};${lr ? 'right:8px;top:8px' : 'left:8px;bottom:8px'}`;
      note.textContent = !r.ok ? r.error
        : `${st.total}쪽 → ${st.total + scope.size}쪽이 됩니다.\n${on ? '이 쪽은 점선에서 나뉩니다. 숫자는 저장되는 순서입니다.' : '이 쪽은 범위 밖이라 그대로 둡니다.'}`;
    }
    $('#uPrev').onclick = () => { if (pv > 0) { pv--; draw(); } };
    $('#uNext').onclick = () => { if (pv < st.total - 1) { pv++; draw(); } };
    $('#uRange').oninput = overlay;
    document.querySelectorAll('input[name=uDir], input[name=uOrder]').forEach((x) => { x.onchange = overlay; });
    $('#uRun').onclick = async () => {
      const r = await api.parsePages($('#uRange').value, st.total);
      if (!r.ok) return toast(r.error, { err: true });
      const out = await savePdfNear(st.path, '한쪽씩');
      if (!out) return;
      const res = await busy('나누는 중…', () => api.unspread(st.path, r.value, radio('uDir'), radio('uOrder') === 'second', out));
      if (!res.ok) return toast(res.error, { err: true });
      savedToast(`${res.value.from}쪽 → ${res.value.pages}쪽으로 나눠 저장했습니다: ${baseName(out)}`, out);
    };
  }

  // ───── 영역 자르기 ─────
  {
    let pv = 0, vp = null, rect = null;
    const st = single('c', async () => { pv = 0; rect = null; $('#cDrop').classList.add('loaded'); await draw(); });
    const cv = () => $('#cCanvas');
    async function draw() {
      vp = await stagePreview(st, pv, cv(), $('#cInner'));
      $('#cPno').textContent = `${pv + 1} / ${st.total}쪽`;
      if (!rect) resetRect(); else { clamp(); apply(); }
      note();
    }
    const size = () => ({ w: parseFloat(cv().style.width), h: parseFloat(cv().style.height) });
    function resetRect() {
      const { w, h } = size();
      rect = { x: w * 0.05, y: h * 0.05, w: w * 0.9, h: h * 0.9 };
      apply();
    }
    function clamp() {
      const { w, h } = size();
      rect.w = Math.min(rect.w, w); rect.h = Math.min(rect.h, h);
      rect.x = Math.min(Math.max(0, rect.x), w - rect.w);
      rect.y = Math.min(Math.max(0, rect.y), h - rect.h);
    }
    function pdfBox() {
      const p1 = vp.convertToPdfPoint(rect.x, rect.y), p2 = vp.convertToPdfPoint(rect.x + rect.w, rect.y + rect.h);
      return { x: Math.min(p1[0], p2[0]), y: Math.min(p1[1], p2[1]), w: Math.abs(p2[0] - p1[0]), h: Math.abs(p2[1] - p1[1]) };
    }
    function apply() {
      const el = $('#cRect');
      Object.assign(el.style, { left: `${rect.x}px`, top: `${rect.y}px`, width: `${rect.w}px`, height: `${rect.h}px` });
      const b = pdfBox();
      $('#cDim').textContent = `${Math.round(b.w * 0.3528)} × ${Math.round(b.h * 0.3528)} mm`;
    }
    async function note() {
      if (!st.path) return;
      const r = await pickPages($('#cRange').value, radio('cParity'), st.total);
      $('#cNote').classList.toggle('err', !r.ok);
      $('#cNote').textContent = r.ok ? `${r.value.length}쪽에 적용합니다. 나머지 쪽은 그대로 둡니다.` : r.error;
      $('#cRun').disabled = !r.ok;
    }
    // 끌어서 옮기기 / 모서리로 크기 바꾸기
    let mode = null, sx = 0, sy = 0, start = null;
    $('#cRect').addEventListener('pointerdown', (e) => {
      mode = e.target.dataset.hd || 'move';
      sx = e.clientX; sy = e.clientY; start = { ...rect };
      $('#cRect').setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    $('#cRect').addEventListener('pointermove', (e) => {
      if (!mode) return;
      const dx = e.clientX - sx, dy = e.clientY - sy, MIN = 30, { w, h } = size();
      const hd = mode === 'move' ? '' : mode; // 모서리 이름(nw/ne/sw/se)
      const r = { ...start };
      if (mode === 'move') { r.x += dx; r.y += dy; }
      if (hd.includes('e')) r.w = start.w + dx;
      if (hd.includes('w')) { r.x = start.x + dx; r.w = start.w - dx; }
      if (hd.includes('s')) r.h = start.h + dy;
      if (hd.includes('n')) { r.y = start.y + dy; r.h = start.h - dy; }
      if (r.w < MIN) { if (hd.includes('w')) r.x = start.x + start.w - MIN; r.w = MIN; }
      if (r.h < MIN) { if (hd.includes('n')) r.y = start.y + start.h - MIN; r.h = MIN; }
      r.x = Math.max(0, Math.min(r.x, w - r.w)); r.y = Math.max(0, Math.min(r.y, h - r.h));
      r.w = Math.min(r.w, w - r.x); r.h = Math.min(r.h, h - r.y);
      rect = r;
      apply();
    });
    $('#cRect').addEventListener('pointerup', () => { mode = null; });
    $('#cResetRect').onclick = () => { if (st.path) resetRect(); };
    $('#cPrev').onclick = () => { if (pv > 0) { pv--; draw(); } };
    $('#cNext').onclick = () => { if (pv < st.total - 1) { pv++; draw(); } };
    $('#cRange').oninput = note;
    document.querySelectorAll('input[name=cParity]').forEach((x) => { x.onchange = note; });
    $('#cRun').onclick = async () => {
      const r = await pickPages($('#cRange').value, radio('cParity'), st.total);
      if (!r.ok) return toast(r.error, { err: true });
      const tag = { odd: '홀수자름', even: '짝수자름' }[radio('cParity')] || '자름';
      const out = await savePdfNear(st.path, tag);
      if (!out) return;
      const res = await busy('자르는 중…', () => api.crop(st.path, r.value, pdfBox(), out));
      if (!res.ok) return toast(res.error, { err: true });
      savedToast(`${res.value.count}쪽을 잘라 저장했습니다: ${baseName(out)}`, out);
    };
  }

  // ───── 쪽번호 · 워터마크 ─────
  {
    const st = single('t', (s, token) => { thumbGrid($('#tThumbs'), s, token); });
    // 한글 워터마크는 글꼴을 넣지 않고 화면에서 돌린 글자를 PNG로 그려 넣는다
    async function watermarkPng(text, rotDeg, opacity) {
      const px = 90, font = `700 ${px}px "Malgun Gothic", sans-serif`;
      const m = document.createElement('canvas').getContext('2d');
      m.font = font;
      const tw = Math.ceil(m.measureText(text).width), th = Math.ceil(px * 1.3), rad = (rotDeg * Math.PI) / 180;
      const c = document.createElement('canvas');
      c.width = Math.ceil(Math.abs(tw * Math.cos(rad)) + Math.abs(th * Math.sin(rad)));
      c.height = Math.ceil(Math.abs(tw * Math.sin(rad)) + Math.abs(th * Math.cos(rad)));
      const g = c.getContext('2d');
      g.translate(c.width / 2, c.height / 2);
      g.rotate(-rad);
      g.font = font; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillStyle = `rgba(100,116,139,${opacity})`;
      g.fillText(text, 0, 0);
      return new Uint8Array(await (await new Promise((res) => c.toBlob(res, 'image/png'))).arrayBuffer());
    }
    $('#tRun').onclick = async () => {
      const numOn = $('#tNumOn').checked, wmText = $('#tWm').value.trim();
      if (!numOn && !wmText) return toast('쪽번호나 워터마크 중 하나는 고르세요.', { err: true });
      const start = Math.floor(Number($('#tStart').value));
      if (numOn && !(start >= 1)) return toast('시작 번호는 1 이상으로 쓰세요.', { err: true });
      const out = await savePdfNear(st.path, wmText && !numOn ? '워터마크' : '쪽번호');
      if (!out) return;
      const opts = {
        num: numOn ? { fmt: $('#tFmt').value, pos: $('#tPos').value, start, size: Number($('#tSize').value) } : null,
        wm: wmText ? { png: await watermarkPng(wmText, Number($('#tRot').value), Number($('#tOp').value)) } : null,
      };
      const res = await busy('넣는 중…', () => api.stamp(st.path, opts, out));
      if (!res.ok) return toast(res.error, { err: true });
      savedToast(`저장했습니다: ${baseName(out)}`, out);
    };
  }

  // 쪽을 그림으로 그리기 (흰 바탕) — 용량 줄이기·PDF → 그림 공용
  async function pageImage(doc, p, scale, type, quality) {
    const page = await doc.getPage(p + 1);
    const vp = page.getViewport({ scale });
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(vp.width)); c.height = Math.max(1, Math.round(vp.height));
    const g = c.getContext('2d');
    if (type === 'image/jpeg') { g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); }
    await page.render({ canvasContext: g, viewport: vp }).promise;
    const blob = await new Promise((res) => c.toBlob(res, type, quality));
    const one = page.getViewport({ scale: 1 });
    c.width = c.height = 0;
    return { bytes: new Uint8Array(await blob.arrayBuffer()), w: one.width, h: one.height };
  }

  // ───── 용량 줄이기 ─────
  {
    const LEVELS = [
      [2.0, 1.0, '거의 원본 (초고화질)'], [1.8, 0.95, '매우 선명'], [1.6, 0.92, '선명함 유지'], [1.5, 0.88, '균형'],
      [1.4, 0.82, '표준 추천'], [1.3, 0.75, '용량 감소 체감'], [1.2, 0.65, '10MB 제한용'], [1.0, 0.55, '5MB 제한용'],
      [0.8, 0.4, '강력 압축'], [0.6, 0.25, '비상용 최소 용량'],
    ];
    const st = single('z', async (s, token) => {
      thumbGrid($('#zThumbs'), s, token);
      const size = await api.fileSize(s.path);
      $('#zNote').classList.remove('err');
      $('#zNote').textContent = `원본 용량: ${fmt(size)}`;
    });
    const fmt = (b) => (b >= 1048576 ? `${(b / 1048576).toFixed(1)}MB` : `${Math.max(1, Math.round(b / 1024))}KB`);
    const showLvl = () => { const v = Number($('#zRange').value); $('#zLvl').textContent = v; $('#zDesc').textContent = LEVELS[v - 1][2]; };
    $('#zRange').oninput = showLvl;
    showLvl();
    $('#zRun').onclick = async () => {
      const lvl = Number($('#zRange').value), [scale, quality] = LEVELS[lvl - 1];
      const out = await savePdfNear(st.path, `용량줄임${lvl}단계`);
      if (!out) return;
      const res = await busy('줄이는 중…', async () => {
        const pages = [];
        for (let p = 0; p < st.total; p++) {
          $('#busyText').textContent = `줄이는 중… (${p + 1}/${st.total}쪽)`;
          const im = await pageImage(st.doc, p, scale, 'image/jpeg', quality);
          pages.push({ jpg: im.bytes, w: im.w, h: im.h });
        }
        $('#busyText').textContent = '저장하는 중…';
        return api.fromJpegs(pages, out);
      });
      if (!res.ok) return toast(res.error, { err: true });
      const before = await api.fileSize(st.path), after = res.value.size;
      const pct = Math.round((1 - after / before) * 100);
      $('#zNote').textContent = `원본 ${fmt(before)} → ${fmt(after)}\n${pct > 0 ? `약 ${pct}% 줄었습니다.` : '원본보다 커졌습니다. 글자 위주로 만든 PDF는 이 방법으로 잘 줄지 않습니다(스캔본·사진이 많은 PDF에 알맞음). 단계를 높이거나 원본을 쓰세요.'}`;
      savedToast(`${fmt(before)} → ${fmt(after)} 로 저장했습니다: ${baseName(out)}`, out);
    };
  }

  // ───── PDF → 그림 ─────
  {
    const st = single('i', (s, token) => { thumbGrid($('#iThumbs'), s, token); note(); });
    async function note() {
      if (!st.path) return;
      const r = await api.parsePages($('#iRange').value, st.total);
      $('#iNote').classList.toggle('err', !r.ok);
      $('#iNote').textContent = r.ok ? `그림 ${r.value.length}장을 만듭니다.` : r.error;
      $('#iRun').disabled = !r.ok;
    }
    $('#iRange').oninput = note;
    $('#iRun').onclick = async () => {
      const r = await api.parsePages($('#iRange').value, st.total);
      if (!r.ok) return toast(r.error, { err: true });
      const jpg = radio('iFmt') === 'jpeg', scale = Number($('#iScale').value), base = stripPdf(st.path);
      const res = await busy('그림으로 바꾸는 중…', async () => {
        const files = [];
        for (const [k, p] of r.value.entries()) {
          $('#busyText').textContent = `그림으로 바꾸는 중… (${k + 1}/${r.value.length})`;
          const im = await pageImage(st.doc, p, scale, jpg ? 'image/jpeg' : 'image/png', 0.92);
          files.push({ name: `${base}_${String(p + 1).padStart(3, '0')}.${jpg ? 'jpg' : 'png'}`, bytes: im.bytes });
        }
        return api.writeFiles(dirName(st.path), `${base}_그림`, files);
      });
      if (!res.ok) return toast(res.error, { err: true });
      folderToast(`그림 ${res.value.count}장을 저장했습니다: ${baseName(res.value.dir)}`, res.value.dir);
    };
  }

  // ───── 평가지 학생별 분할 ─────
  {
    const es = { roster: [], sourceName: '', drafts: new Map(), key: '', path: null, total: 0 };
    const manual = () => $('#eMode').value === 'manual';
    const text = (v) => String(v == null ? '' : v).trim();
    function integer(v, label, max) {
      const raw = text(v).replace(/(?:학년|반|번)$/, '').trim();
      if (!/^\d+$/.test(raw) || Number(raw) < 1 || Number(raw) > max) throw new Error(`${label}은(는) 1~${max} 사이의 정수로 쓰세요.`);
      return Number(raw);
    }
    const code = (s) => String(s.grade) + String(s.classNo).padStart(2, '0') + String(s.number).padStart(2, '0');
    function normalize(s) {
      const n = { grade: integer(s.grade, '학년', 9), classNo: integer(s.classNo, '반', 99), number: integer(s.number, '번호', 99), name: text(s.name) };
      if (!n.name) throw new Error('이름이 비어 있습니다.');
      if (/[\\/:*?"<>|\u0000-\u001f]/.test(n.name) || /[. ]$/.test(n.name)) throw new Error('이름에 파일 이름으로 쓸 수 없는 글자가 있습니다.');
      return n;
    }
    function validate(list) {
      const seen = new Set();
      return list.map((s) => {
        const n = normalize(s), c = code(n);
        if (seen.has(c)) throw new Error(`학번 ${c}이(가) 겹칩니다.`);
        seen.add(c);
        return n;
      });
    }

    // .xlsx 읽기 — 첫 행에 학년/반/번호/이름 머리글이 있는 시트를 모두 읽는다
    async function readWorkbook(buffer) {
      const zip = await window.JSZip.loadAsync(buffer);
      async function xml(p) {
        const f = zip.file(p);
        if (!f) throw new Error(`엑셀 구성 파일이 없습니다: ${p}`);
        const doc = new DOMParser().parseFromString(await f.async('string'), 'application/xml');
        if (doc.getElementsByTagName('parsererror').length) throw new Error('엑셀 형식이 올바르지 않습니다.');
        return doc;
      }
      const nodes = (root, name) => [...root.getElementsByTagNameNS('*', name)];
      const strings = zip.file('xl/sharedStrings.xml') ? nodes(await xml('xl/sharedStrings.xml'), 'si').map((si) => nodes(si, 't').map((t) => t.textContent).join('')) : [];
      const rels = nodes(await xml('xl/_rels/workbook.xml.rels'), 'Relationship');
      const book = await xml('xl/workbook.xml');
      const HEAD = ['학년', '반', '번호', '이름'];
      const students = [];
      let matched = 0;
      for (const sheet of nodes(book, 'sheet')) {
        const id = sheet.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id');
        const rel = rels.find((x) => x.getAttribute('Id') === id);
        if (!rel || !rel.getAttribute('Type').endsWith('/worksheet')) continue;
        const target = rel.getAttribute('Target');
        const p = target.startsWith('/') ? target.slice(1) : new URL(target, 'https://xlsx.local/xl/').pathname.slice(1);
        let cols = null;
        for (const row of nodes(await xml(p), 'row')) {
          const values = new Map();
          for (const cell of nodes(row, 'c')) {
            const col = (cell.getAttribute('r') || '').replace(/[0-9]/g, '');
            const v = nodes(cell, 'v')[0]?.textContent || '';
            const t = cell.getAttribute('t');
            values.set(col, t === 's' ? strings[Number(v)] || '' : t === 'inlineStr' ? nodes(cell, 't').map((x) => x.textContent).join('') : v);
          }
          if (!cols) {
            const found = HEAD.map((h) => [...values].find(([, v]) => text(v).replace(/\s/g, '') === h)?.[0]);
            if (found.every(Boolean)) { cols = found; matched++; }
            continue;
          }
          const d = cols.map((c) => text(values.get(c)));
          if (d.every((v) => !v) || d.every((v, i) => v === HEAD[i])) continue;
          try { students.push(normalize({ grade: d[0], classNo: d[1], number: d[2], name: d[3] })); } catch (err) {
            throw new Error(`${sheet.getAttribute('name')} ${row.getAttribute('r')}행: ${err.message}`);
          }
        }
      }
      if (!matched) throw new Error('첫 행에 학년 / 반 / 번호 / 이름 칸이 있는 .xlsx 양식을 쓰세요(샘플 받기).');
      if (!students.length) throw new Error('학생이 없습니다. 2행부터 명렬표를 채우세요.');
      return validate(students);
    }

    function readRows() {
      return [...$('#eRows').children].map((tr) => (manual()
        ? { filename: tr.querySelector('.fname').value, absent: tr.querySelector('.absent').checked }
        : { grade: tr.querySelector('.g').value, classNo: tr.querySelector('.c').value, number: tr.querySelector('.n').value, name: tr.querySelector('.nm').value, absent: tr.querySelector('.absent').checked }));
    }
    const classKey = () => (manual() ? 'manual' : `class:${$('#eGrade').value}:${$('#eClass').value}`);
    function saveDraft() { if (es.key) es.drafts.set(es.key, readRows()); }
    function renderRows(rows) {
      $('#eHead').innerHTML = manual()
        ? '<tr><th>순서</th><th>결시</th><th>파일 이름 (.pdf 자동)</th><th>배정 쪽</th><th></th></tr>'
        : '<tr><th>순서</th><th>결시</th><th>학년</th><th>반</th><th>번호</th><th>이름</th><th>파일 이름 / 배정 쪽</th><th></th></tr>';
      $('#eRows').replaceChildren();
      rows.forEach(appendRow);
      update();
    }
    function appendRow(s = {}) {
      const tr = document.createElement('tr');
      tr.innerHTML = '<td class="no"></td><td><input type="checkbox" class="absent" title="결시"></td>' + (manual()
        ? '<td><input type="text" class="fname" placeholder="예: 10101홍길동"></td><td class="asg"></td>'
        : '<td><input type="number" class="g" min="1" max="9"></td><td><input type="number" class="c" min="1" max="99"></td><td><input type="number" class="n" min="1" max="99"></td><td><input type="text" class="nm" placeholder="이름"></td><td><div class="fn"></div><div class="asg"></div></td>')
        + '<td><button class="del" title="이 줄 지우기">✕</button></td>';
      tr.querySelector('.absent').checked = !!s.absent;
      if (manual()) tr.querySelector('.fname').value = s.filename || '';
      else [['grade', 'g'], ['classNo', 'c'], ['number', 'n'], ['name', 'nm']].forEach(([k, c]) => { tr.querySelector(`.${c}`).value = s[k] == null ? '' : s[k]; });
      tr.querySelector('.del').onclick = () => { tr.remove(); update(); };
      tr.addEventListener('input', update);
      $('#eRows').append(tr);
    }
    function loadClass() {
      es.key = classKey();
      const saved = es.drafts.get(es.key);
      const g = Number($('#eGrade').value), c = Number($('#eClass').value);
      renderRows(saved || (manual() ? [] : es.roster.filter((s) => s.grade === g && s.classNo === c).sort((a, b) => a.number - b.number)));
    }
    function fillClasses() {
      const g = Number($('#eGrade').value);
      const classes = [...new Set(es.roster.filter((s) => s.grade === g).map((s) => s.classNo))].sort((a, b) => a - b);
      $('#eClass').replaceChildren(...(classes.length ? classes.map((c) => new Option(`${c}반`, String(c))) : [new Option('-', '')]));
      $('#eClass').disabled = manual() || !classes.length;
    }
    function refreshRoster() {
      const grades = [...new Set(es.roster.map((s) => s.grade))].sort((a, b) => a - b);
      $('#eGrade').replaceChildren(...(grades.length ? grades.map((g) => new Option(`${g}학년`, String(g))) : [new Option('-', '')]));
      $('#eGrade').disabled = manual() || !grades.length;
      fillClasses();
      loadClass();
      const classes = new Set(es.roster.map((s) => `${s.grade}:${s.classNo}`)).size;
      $('#eRosterInfo').textContent = es.roster.length
        ? `${es.roster.length}명 · ${classes}학급${es.sourceName ? ` (${es.sourceName})` : ''}`
        : '등록된 명렬표가 없습니다. 샘플 양식으로 올리거나 아래 표에 직접 쓰세요.';
    }
    function update() {
      const rows = readRows(), pps = Number($('#ePps').value), okPps = Number.isInteger(pps) && pps > 0;
      let att = 0, abs = 0;
      [...$('#eRows').children].forEach((tr, i) => {
        const s = rows[i];
        tr.querySelector('.no').textContent = i + 1;
        tr.classList.toggle('absent', s.absent);
        if (!manual()) {
          let fn = '학년·반·번호·이름을 쓰세요';
          try { const n = normalize(s); fn = `${code(n)}${n.name}.pdf`; } catch { /* 아직 덜 씀 */ }
          tr.querySelector('.fn').textContent = fn;
        }
        if (s.absent) { abs++; tr.querySelector('.asg').textContent = '결시 · 배정 안 함'; } else {
          tr.querySelector('.asg').textContent = okPps ? `${att * pps + 1}~${(att + 1) * pps}쪽` : '쪽 수 확인';
          att++;
        }
      });
      const need = okPps ? att * pps : null;
      let msg = `명단 ${rows.length}명 · 결시 ${abs}명 · 응시 ${att}명`;
      if (need != null) msg += ` · 필요한 쪽 ${need}쪽`;
      const match = es.path && need === es.total;
      msg += !es.path ? '\n스캔한 PDF를 여세요.' : match ? `\nPDF ${es.total}쪽과 맞습니다.` : `\nPDF는 ${es.total}쪽입니다. 명단·결시·1명당 쪽 수를 맞추세요.`;
      $('#eSummary').textContent = msg;
      $('#eSummary').classList.toggle('err', !!es.path && !match);
      $('#eRun').disabled = !match || !att;
    }

    async function loadRosterFile(file) {
      const r = await api.readFile(file);
      if (!r.ok) return toast(r.error, { err: true });
      let students;
      try { students = await readWorkbook(r.value); } catch (e) { return toast(`명렬표를 읽지 못했습니다. ${e.message}`, { err: true }); }
      if (es.roster.length && !confirm(`등록된 명렬표를 새 명렬표 ${students.length}명으로 바꿀까요? 지금의 결시 체크와 추가 응시자는 지워집니다.`)) return;
      Object.assign(es, { roster: students, sourceName: baseName(file), key: '' });
      es.drafts.clear();
      $('#eMode').value = 'roster';
      await api.rosterSet({ version: 1, sourceName: es.sourceName, students });
      refreshRoster();
      toast(`명렬표 ${students.length}명을 등록했습니다.`);
    }
    async function openPdf(file) {
      const r = await api.pageCount(file);
      if (!r.ok) return toast(r.error, { err: true });
      Object.assign(es, { path: file, total: r.value });
      $('#eName').textContent = `${baseName(file)} (${r.value}쪽)`;
      update();
    }

    $('#eRosterLoad').onclick = async () => { const f = await api.pickXlsx(); if (f) loadRosterFile(f); };
    $('#eSample').onclick = async () => { const p = await api.rosterSample(); if (p) savedToast(`샘플을 저장했습니다: ${baseName(p)}`, p); };
    $('#eRosterClear').onclick = async () => {
      if (!es.roster.length || !confirm('등록된 명렬표와 지금 명단을 지울까요?')) return;
      Object.assign(es, { roster: [], sourceName: '', key: '' });
      es.drafts.clear();
      await api.rosterSet(null);
      refreshRoster();
    };
    $('#eGrade').onchange = () => { saveDraft(); fillClasses(); loadClass(); };
    $('#eClass').onchange = () => { saveDraft(); loadClass(); };
    $('#eMode').onchange = () => {
      // 바뀌기 전 표 모양으로 저장해 둔다
      const next = $('#eMode').value;
      $('#eMode').value = es.key === 'manual' ? 'manual' : 'roster';
      saveDraft();
      $('#eMode').value = next;
      $('#eGrade').disabled = $('#eClass').disabled = manual() || !es.roster.length;
      loadClass();
    };
    $('#ePps').oninput = update;
    $('#eReset').onclick = () => {
      if (!confirm('이 학급의 결시 체크와 추가 응시자를 지우고 명렬표에서 다시 불러올까요?')) return;
      es.drafts.delete(classKey());
      loadClass();
    };
    $('#eAddRow').onclick = () => {
      appendRow(manual() ? {} : { grade: $('#eGrade').value, classNo: $('#eClass').value });
      update();
      $('#eRows').lastElementChild.querySelector(manual() ? '.fname' : '.n').focus();
    };
    $('#eClearRows').onclick = () => { if (confirm('작업 명단을 비울까요? 등록된 명렬표는 그대로입니다.')) { renderRows([]); saveDraft(); } };
    $('#eOpen').onclick = async () => { const [f] = await api.pickPdfs(false); if (f) openPdf(f); };
    dropZone($('#eDrop'), (files) => {
      const x = files.find((f) => /\.xlsx$/i.test(f)), p = files.find((f) => PDF_RE.test(f));
      if (x) loadRosterFile(x);
      if (p) openPdf(p);
    }, { accept: /\.(pdf|xlsx)$/i, wrong: '스캔한 PDF나 명렬표(.xlsx)를 넣으세요.' });
    // 파일 이름 직접 입력: 엑셀에서 한 열을 복사해 붙여 넣기
    $('#eRows').addEventListener('paste', (e) => {
      if (!manual()) return;
      const lines = e.clipboardData.getData('text').split(/\r?\n/).filter((l) => l.trim());
      if (lines.length < 2) return;
      e.preventDefault();
      if (readRows().every((s) => !s.filename.trim())) $('#eRows').replaceChildren();
      lines.forEach((l) => appendRow({ filename: l.split('\t')[0].trim() }));
      update();
    });
    $('#eRun').onclick = async () => {
      const pps = Number($('#ePps').value);
      const att = readRows().filter((s) => !s.absent);
      const tasks = [], seen = new Set();
      try {
        const list = manual() ? att : validate(att);
        list.forEach((s, i) => {
          let name;
          if (manual()) {
            name = text(s.filename).replace(PDF_RE, '');
            if (!name) throw new Error(`${i + 1}번째 응시자의 파일 이름을 쓰세요.`);
          } else name = code(s) + s.name;
          if (seen.has(name.toLowerCase())) throw new Error(`파일 이름 ${name}.pdf 가 겹칩니다.`);
          seen.add(name.toLowerCase());
          tasks.push({ name, pages: Array.from({ length: pps }, (_, k) => i * pps + k) });
        });
      } catch (e) { return toast(e.message, { err: true }); }
      const res = await busy(`학생 ${tasks.length}명 파일을 만드는 중…`, () => api.splitNamed(es.path, tasks, dirName(es.path), `${stripPdf(es.path)}_학생별`));
      if (!res.ok) return toast(res.error, { err: true });
      folderToast(`응시자 ${res.value.count}명의 PDF를 저장했습니다: ${baseName(res.value.dir)}`, res.value.dir);
    };

    api.rosterGet().then((d) => {
      try { es.roster = validate(Array.isArray(d.students) ? d.students : []); es.sourceName = text(d.sourceName); } catch { es.roster = []; }
      refreshRoster();
    });
  }
}
