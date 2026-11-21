// PDF 보기 — 연속 스크롤, 한 쪽·두 쪽 보기, 확대(폭·쪽 맞춤), 보기 회전, 축소판·책갈피,
// 글자 찾기·선택·복사, 문서 안 링크, 전체 화면, 인쇄, 암호 PDF, 마지막에 본 쪽 기억.
// (한PDF 2022의 '보기' 기능 목록을 참고해 pdf.js로 새로 만든 화면)
export function initViewer(ctx) {
  const { $, api, toast, busy, pdfjsLib, dropZone, baseName, openIn } = ctx;
  const { TextLayer } = pdfjsLib;
  const CSS_UNITS = 96 / 72; // 100% = 실제 크기(1pt = 1/72인치)
  const GAP = 14;
  const PAD = 16;
  const MAX_CANVAS_PX = 16e6;
  const STEPS = [0.1, 0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5, 6, 8];

  const drop = $('#vDrop');
  const wrap = $('#vPages');
  const st = {
    path: null, doc: null, pages: [], rows: [], token: 0, gen: 0,
    scale: CSS_UNITS, zoom: 'width', spread: '1', rot: 0, cur: 0, thumbGen: 0,
    visible: new Set(), observer: null, thumbObs: null, preFs: null,
    find: { q: '', hits: [], i: -1, token: 0 },
  };
  const clamp = (v, a, b) => Math.min(Math.max(v, a), b);
  const isActive = () => $('#tab-view').classList.contains('active');

  // ───── 최근 문서 · 마지막에 본 쪽 ─────
  const RKEY = 'pdftool.viewer.recent';
  const recentGet = () => { try { return JSON.parse(localStorage.getItem(RKEY)) || []; } catch { return []; } };
  function recentPut(path, page) {
    const list = recentGet().filter((x) => x.path.toLowerCase() !== path.toLowerCase());
    list.unshift({ path, page, t: Date.now() });
    try { localStorage.setItem(RKEY, JSON.stringify(list.slice(0, 12))); } catch {}
  }
  function recentDrop(path) {
    try { localStorage.setItem(RKEY, JSON.stringify(recentGet().filter((x) => x.path !== path))); } catch {}
    renderRecent();
  }
  function renderRecent() {
    const box = $('#vRecent');
    box.replaceChildren();
    const list = recentGet().slice(0, 8);
    if (!list.length) return;
    box.append(Object.assign(document.createElement('h4'), { textContent: '최근에 본 문서' }));
    for (const x of list) {
      const b = document.createElement('button');
      b.innerHTML = '<b></b><small></small>';
      b.querySelector('b').textContent = baseName(x.path);
      b.querySelector('small').textContent = `  ${x.page + 1}쪽까지 봄 · ${x.path}`;
      b.title = x.path;
      b.onclick = () => open(x.path);
      box.append(b);
    }
  }
  let saveTimer = null;
  const savePos = () => { clearTimeout(saveTimer); saveTimer = setTimeout(() => st.path && recentPut(st.path, st.cur), 400); };

  // ───── 암호 ─────
  function askPassword(name, wrong) {
    return new Promise((resolve) => {
      const m = $('#pwModal'), inp = $('#pwInput');
      $('#pwMsg').textContent = wrong ? '암호가 맞지 않습니다. 다시 넣어 주세요.' : `${name} 파일을 열려면 암호가 필요합니다.`;
      $('#pwMsg').classList.toggle('err-text', !!wrong);
      inp.value = '';
      m.classList.remove('hidden');
      inp.focus();
      const done = (v) => { m.classList.add('hidden'); $('#pwOk').onclick = $('#pwCancel').onclick = inp.onkeydown = null; resolve(v); };
      $('#pwOk').onclick = () => done(inp.value);
      $('#pwCancel').onclick = () => done(null);
      inp.onkeydown = (e) => {
        if (e.key === 'Enter') done(inp.value);
        if (e.key === 'Escape') { e.stopPropagation(); done(null); }
      };
    });
  }

  // ───── 열기 · 닫기 ─────
  async function open(file, opts = {}) {
    const token = ++st.token;
    const r = await api.readFile(file);
    if (!r.ok) {
      toast(`파일을 열 수 없습니다: ${baseName(file)}`, { err: true });
      if (recentGet().some((x) => x.path === file)) recentDrop(file);
      return;
    }
    let cancelled = false;
    const task = pdfjsLib.getDocument({ data: r.value, cMapUrl: './vendor/cmaps/', cMapPacked: true, standardFontDataUrl: './vendor/standard_fonts/' });
    task.onPassword = (update, reason) => {
      askPassword(baseName(file), reason === pdfjsLib.PasswordResponses.INCORRECT_PASSWORD).then((pw) => {
        if (pw == null) { cancelled = true; task.destroy(); } else update(pw);
      });
    };
    let doc;
    try { doc = await task.promise; } catch (e) {
      if (!cancelled && token === st.token) toast(`PDF를 열 수 없습니다: ${baseName(file)} (${e.message || e})`, { err: true });
      return;
    }
    if (token !== st.token) { doc.destroy(); return; }
    let pages;
    try {
      pages = await busy('여는 중…', () => Promise.all(Array.from({ length: doc.numPages }, (_, i) => doc.getPage(i + 1))));
    } catch (e) { doc.destroy(); return toast(`PDF를 읽는 중 오류: ${e.message || e}`, { err: true }); }
    if (token !== st.token) { doc.destroy(); return; }

    close();
    st.path = file;
    st.doc = doc;
    st.rot = 0;
    st.pages = pages.map((page, p) => {
      const el = document.createElement('div');
      el.className = 'vpage';
      el.dataset.p = p;
      return { page, el, done: -1, task: null, text: null, idx: null, layer: null, hlItems: [], annots: null };
    });
    $('#vName').textContent = `${baseName(file)} (${doc.numPages}쪽)`;
    $('#vName').title = file;
    $('#vTotal').textContent = `/ ${doc.numPages}`;
    $('#vEmpty').style.display = 'none';
    document.title = `${baseName(file)} - PDF 도구`;
    $('#tab-view').classList.add('has-doc');
    st.observer = new IntersectionObserver(onIntersect, { root: drop, rootMargin: '100% 0px' });
    st.pages.forEach((pg) => st.observer.observe(pg.el));
    layout();
    setZoom(st.zoom, { anchor: null });
    buildThumbs();
    buildOutline(token);
    const remembered = recentGet().find((x) => x.path.toLowerCase() === file.toLowerCase());
    const start = opts.page ?? (remembered ? remembered.page : 0);
    goto(clamp(start, 0, doc.numPages - 1));
    recentPut(file, st.cur);
    drop.focus({ preventScroll: true });
    if ($('#vFind').value.trim()) runFind(0);
  }

  function close() {
    if (st.observer) st.observer.disconnect();
    if (st.thumbObs) st.thumbObs.disconnect();
    for (const pg of st.pages) if (pg.task) pg.task.cancel();
    if (st.doc) st.doc.destroy();
    Object.assign(st, { path: null, doc: null, pages: [], rows: [], cur: 0, observer: null, thumbObs: null });
    st.visible.clear();
    st.find = { q: '', hits: [], i: -1, token: st.find.token + 1 };
    $('#vFindInfo').textContent = '';
    wrap.replaceChildren();
    $('#vThumbs').replaceChildren();
    $('#vOutline').replaceChildren();
  }

  // ───── 배치 ─────
  const rotOf = (pg) => (pg.page.rotate + st.rot) % 360;
  function dims(pg) {
    const vp = pg.page.getViewport({ scale: 1, rotation: rotOf(pg) });
    return { w: vp.width, h: vp.height };
  }
  function groupRows() {
    const n = st.pages.length, rows = [];
    if (st.spread === '1') for (let p = 0; p < n; p++) rows.push([p]);
    else {
      let p = 0;
      if (st.spread === '2c' && n) rows.push([p++]);
      for (; p < n; p += 2) rows.push(p + 1 < n ? [p, p + 1] : [p]);
    }
    return rows;
  }
  function layout() {
    st.rows = groupRows();
    wrap.replaceChildren();
    for (const row of st.rows) {
      const r = document.createElement('div');
      r.className = 'vrow';
      for (const p of row) r.append(st.pages[p].el);
      wrap.append(r);
    }
  }
  const rowIndex = (p) => st.rows.findIndex((r) => r.includes(p));

  function fitScale(mode) {
    const row = st.rows[Math.max(0, rowIndex(st.cur))] || [0];
    const ds = row.map((p) => dims(st.pages[p]));
    const pad = drop.classList.contains('fs') ? 4 : PAD;
    const availW = drop.clientWidth - pad * 2 - GAP * (row.length - 1);
    const availH = drop.clientHeight - pad * 2;
    const sw = availW / ds.reduce((s, d) => s + d.w, 0);
    const sh = availH / Math.max(...ds.map((d) => d.h));
    return Math.max(0.05, mode === 'width' ? sw : Math.min(sw, sh));
  }

  function captureAnchor() {
    if (!st.pages.length) return null;
    const pg = st.pages[st.cur];
    const top = wrap.offsetTop + pg.el.offsetTop;
    return {
      p: st.cur,
      frac: pg.el.offsetHeight ? (drop.scrollTop - top) / pg.el.offsetHeight : 0,
      x: drop.scrollWidth > drop.clientWidth ? (drop.scrollLeft + drop.clientWidth / 2) / drop.scrollWidth : 0.5,
    };
  }
  function restoreAnchor(a) {
    if (!a) return;
    const el = st.pages[a.p].el;
    drop.scrollTop = wrap.offsetTop + el.offsetTop + a.frac * el.offsetHeight;
    drop.scrollLeft = a.x * drop.scrollWidth - drop.clientWidth / 2;
  }

  function invalidate(pg) {
    if (pg.task) { pg.task.cancel(); pg.task = null; }
    pg.el.querySelector('.textLayer')?.remove();
    pg.el.querySelector('.vlinks')?.remove();
    pg.layer = null;
    pg.hlItems = [];
    pg.done = -1;
  }

  function setZoom(mode, { anchor = captureAnchor() } = {}) {
    if (!st.doc) { st.zoom = mode; updateZoomUi(); return; }
    st.zoom = mode;
    const s = mode === 'width' || mode === 'page' ? fitScale(mode) : clamp(Number(mode), 0.1, 8) * CSS_UNITS;
    st.scale = s;
    st.gen++;
    for (const pg of st.pages) {
      invalidate(pg);
      const d = dims(pg);
      pg.el.style.width = `${Math.floor(d.w * s)}px`;
      pg.el.style.height = `${Math.floor(d.h * s)}px`;
    }
    restoreAnchor(anchor);
    updateZoomUi();
    renderVisible();
  }
  function zoomStep(dir) {
    const f = st.scale / CSS_UNITS;
    const next = dir > 0 ? STEPS.find((x) => x > f + 0.001) : [...STEPS].reverse().find((x) => x < f - 0.001);
    if (next) setZoom(next);
  }
  function updateZoomUi() {
    const sel = $('#vZoom'), custom = $('#vZoomCustom');
    const pct = `${Math.round((st.scale / CSS_UNITS) * 100)}%`;
    if (st.zoom === 'width' || st.zoom === 'page') {
      sel.value = st.zoom;
      custom.hidden = true;
    } else {
      const opt = [...sel.options].find((o) => o.value !== 'custom' && Number(o.value) === Number(st.zoom));
      if (opt) { sel.value = opt.value; custom.hidden = true; } else { custom.hidden = false; custom.textContent = pct; sel.value = 'custom'; }
    }
    $('#vPct').textContent = st.doc ? pct : '';
  }

  // ───── 그리기 ─────
  function onIntersect(entries) {
    for (const en of entries) {
      const p = Number(en.target.dataset.p);
      if (en.isIntersecting) { st.visible.add(p); renderPage(p); } else { st.visible.delete(p); freePage(p); }
    }
  }
  function freePage(p) {
    const pg = st.pages[p];
    if (!pg) return;
    invalidate(pg);
    const c = pg.el.querySelector('canvas');
    if (c) { c.width = 0; c.height = 0; c.remove(); }
  }
  function renderVisible() {
    [...st.visible].sort((a, b) => Math.abs(a - st.cur) - Math.abs(b - st.cur)).forEach((p) => renderPage(p));
  }

  async function renderPage(p) {
    const pg = st.pages[p];
    const gen = st.gen, token = st.token;
    if (!pg || pg.done === gen || pg.task) return pg?.pending;
    const vp = pg.page.getViewport({ scale: st.scale, rotation: rotOf(pg) });
    let k = devicePixelRatio || 1;
    if (vp.width * vp.height * k * k > MAX_CANVAS_PX) k = Math.sqrt(MAX_CANVAS_PX / (vp.width * vp.height));
    const c = document.createElement('canvas');
    c.width = Math.floor(vp.width * k);
    c.height = Math.floor(vp.height * k);
    const task = pg.page.render({ canvasContext: c.getContext('2d'), viewport: vp, transform: k !== 1 ? [k, 0, 0, k, 0, 0] : null });
    pg.task = task;
    pg.pending = (async () => {
      try { await task.promise; } catch (e) {
        if (e && e.name === 'RenderingCancelledException') return;
        console.error(e);
        return;
      } finally { if (pg.task === task) pg.task = null; }
      if (gen !== st.gen || token !== st.token) return;
      const old = pg.el.querySelector('canvas');
      if (old) { old.width = 0; old.remove(); }
      pg.el.prepend(c);
      pg.done = gen;
      // 글자 층 (선택·복사·찾기)
      try {
        pg.text ??= await pg.page.getTextContent();
        if (gen !== st.gen || token !== st.token) return;
        pg.el.querySelector('.textLayer')?.remove();
        const tl = document.createElement('div');
        tl.className = 'textLayer';
        pg.el.style.setProperty('--scale-factor', vp.scale);
        pg.el.append(tl);
        const layer = new TextLayer({ textContentSource: pg.text, container: tl, viewport: vp });
        await layer.render();
        if (gen !== st.gen || token !== st.token) { tl.remove(); return; }
        pg.layer = layer;
        pg.hlItems = [];
        applyHighlights(p);
      } catch (e) { console.error(e); }
      try { await drawLinks(pg, vp, gen); } catch (e) { console.error(e); }
    })();
    return pg.pending;
  }

  async function drawLinks(pg, vp, gen) {
    pg.annots ??= await pg.page.getAnnotations({ intent: 'display' });
    if (gen !== st.gen) return;
    const links = pg.annots.filter((a) => a.subtype === 'Link' && (a.url || a.dest || a.action));
    pg.el.querySelector('.vlinks')?.remove();
    if (!links.length) return;
    const box = document.createElement('div');
    box.className = 'vlinks';
    for (const a of links) {
      const [x1, y1, x2, y2] = vp.convertToViewportRectangle(a.rect);
      const el = document.createElement('a');
      el.className = 'vlink';
      Object.assign(el.style, { left: `${Math.min(x1, x2)}px`, top: `${Math.min(y1, y2)}px`, width: `${Math.abs(x2 - x1)}px`, height: `${Math.abs(y2 - y1)}px` });
      el.title = a.url ? a.url : '문서 안의 다른 곳으로 이동';
      el.onclick = (e) => {
        e.preventDefault();
        if (a.url) api.openExternal(a.url);
        else if (a.dest) goDest(a.dest);
        else if (a.action) namedAction(a.action);
      };
      box.append(el);
    }
    pg.el.append(box);
  }
  function namedAction(a) {
    const act = { NextPage: () => goto(st.cur + 1), PrevPage: () => goto(st.cur - 1), FirstPage: () => goto(0), LastPage: () => goto(st.pages.length - 1) }[a];
    if (act) act();
  }

  // ───── 이동 ─────
  function goto(p, y = null) {
    if (!st.pages.length) return;
    p = clamp(p, 0, st.pages.length - 1);
    const el = st.pages[p].el;
    const top = wrap.offsetTop + el.offsetTop;
    if (y != null) drop.scrollTop = top + y - 40;
    else if (st.zoom === 'page' || drop.classList.contains('fs')) drop.scrollTop = top - Math.max(0, (drop.clientHeight - el.offsetHeight) / 2);
    else drop.scrollTop = top - 8;
    setCur(p);
  }
  function gotoRow(dir) {
    const ri = rowIndex(st.cur) + dir;
    if (ri >= 0 && ri < st.rows.length) goto(st.rows[ri][0]);
  }
  async function destTarget(dest) {
    if (typeof dest === 'string') dest = await st.doc.getDestination(dest);
    if (!Array.isArray(dest)) return null;
    const ref = dest[0];
    let p = null;
    if (ref && typeof ref === 'object') p = await st.doc.getPageIndex(ref);
    else if (Number.isInteger(ref)) p = ref;
    if (p == null) return null;
    const kind = dest[1] && dest[1].name;
    const top = kind === 'XYZ' ? dest[3] : kind === 'FitH' || kind === 'FitBH' ? dest[2] : null;
    let y = null;
    if (typeof top === 'number') {
      const pg = st.pages[p];
      const vp = pg.page.getViewport({ scale: st.scale, rotation: rotOf(pg) });
      y = Math.max(0, vp.convertToViewportPoint(typeof dest[2] === 'number' ? dest[2] : 0, top)[1]);
    }
    return { p, y };
  }
  async function goDest(dest) {
    try {
      const t = await destTarget(dest);
      if (t) goto(t.p, t.y);
    } catch (e) { console.error(e); }
  }

  function setCur(p) {
    if (!st.pages.length) return;
    const changed = st.cur !== p;
    st.cur = p;
    $('#vPage').value = String(p + 1);
    const prev = $('#vThumbs .vthumb.cur');
    const t = st.pages[p].thumb;
    if (prev !== t) {
      prev?.classList.remove('cur');
      t?.classList.add('cur');
      if (t && !$('#vSide').classList.contains('hidden')) t.scrollIntoView({ block: 'nearest' });
    }
    if (changed) savePos();
  }
  function pageAtScroll() {
    const n = st.pages.length;
    if (!n) return 0;
    if (drop.scrollTop + drop.clientHeight >= drop.scrollHeight - 2 && drop.scrollTop > 0) return st.rows[st.rows.length - 1][0];
    const y = drop.scrollTop - wrap.offsetTop + Math.min(drop.clientHeight * 0.3, 240);
    let lo = 0, hi = n - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (st.pages[mid].el.offsetTop <= y) lo = mid; else hi = mid - 1;
    }
    while (lo > 0 && st.pages[lo - 1].el.offsetTop === st.pages[lo].el.offsetTop) lo--;
    return lo;
  }
  let scrollRaf = 0;
  drop.addEventListener('scroll', () => {
    if (scrollRaf || !st.doc) return;
    scrollRaf = requestAnimationFrame(() => { scrollRaf = 0; const p = pageAtScroll(); if (p !== st.cur) setCur(p); });
  });

  // ───── 축소판 · 책갈피 ─────
  function buildThumbs() {
    const box = $('#vThumbs');
    box.replaceChildren();
    if (st.thumbObs) st.thumbObs.disconnect();
    const token = st.token, gen = ++st.thumbGen;
    st.thumbObs = new IntersectionObserver((entries) => {
      for (const en of entries) {
        if (!en.isIntersecting) continue;
        st.thumbObs.unobserve(en.target);
        renderThumb(Number(en.target.dataset.p), token, gen);
      }
    }, { root: box, rootMargin: '300px' });
    st.pages.forEach((pg, p) => {
      const d = dims(pg);
      const t = document.createElement('div');
      t.className = `vthumb${p === st.cur ? ' cur' : ''}`;
      t.dataset.p = p;
      t.innerHTML = `<div class="ph" style="aspect-ratio:${d.w}/${d.h}"></div><div class="pn">${p + 1}</div>`;
      t.onclick = () => goto(p);
      pg.thumb = t;
      box.append(t);
      st.thumbObs.observe(t);
    });
  }
  async function renderThumb(p, token, gen) {
    const pg = st.pages[p];
    if (!pg) return;
    const d = dims(pg);
    const vp = pg.page.getViewport({ scale: (110 * (devicePixelRatio || 1)) / d.w, rotation: rotOf(pg) });
    const c = document.createElement('canvas');
    c.width = Math.floor(vp.width);
    c.height = Math.floor(vp.height);
    try { await pg.page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise; } catch { return; }
    if (token !== st.token || gen !== st.thumbGen || !pg.thumb) return;
    pg.thumb.querySelector('.ph, canvas')?.replaceWith(c);
  }

  async function buildOutline(token) {
    const box = $('#vOutline');
    box.replaceChildren();
    let ol = null;
    try { ol = await st.doc.getOutline(); } catch {}
    if (token !== st.token) return;
    $('#vSideTabs [data-v=outline]').textContent = ol && ol.length ? '책갈피' : '책갈피(없음)';
    if (!ol || !ol.length) {
      box.innerHTML = '<p class="muted small">이 PDF에는 책갈피(목차)가 없습니다.</p>';
      return;
    }
    const mk = (items, depth) => {
      const ul = document.createElement('ul');
      for (const it of items) {
        const li = document.createElement('li');
        const row = document.createElement('div');
        row.className = 'ol-row';
        const car = document.createElement('button');
        car.className = `car${it.items && it.items.length ? '' : ' none'}`;
        const ttl = document.createElement('button');
        ttl.className = 'ttl';
        ttl.textContent = it.title;
        ttl.title = it.title;
        if (it.bold) ttl.style.fontWeight = '700';
        if (it.italic) ttl.style.fontStyle = 'italic';
        ttl.onclick = () => (it.url ? api.openExternal(it.url) : it.dest ? goDest(it.dest) : it.action && namedAction(it.action));
        row.append(car, ttl);
        li.append(row);
        if (it.items && it.items.length) {
          const sub = mk(it.items, depth + 1);
          let openNow = depth < 1;
          sub.hidden = !openNow;
          car.textContent = openNow ? '▾' : '▸';
          car.onclick = () => { openNow = !openNow; sub.hidden = !openNow; car.textContent = openNow ? '▾' : '▸'; };
          li.append(sub);
        }
        ul.append(li);
      }
      return ul;
    };
    box.append(mk(ol, 0));
  }

  // ───── 찾기 ─────
  const norm = (s) => s.replace(/\s+/g, '').toLowerCase();
  function pageIndex(pg) {
    if (pg.idx) return pg.idx;
    let s = '';
    const map = [];
    pg.text.items.filter((it) => it.str !== undefined).forEach((it, i) => {
      for (let o = 0; o < it.str.length; o++) {
        const ch = it.str[o];
        if (/\s/.test(ch)) continue;
        s += ch.toLowerCase();
        map.push([i, o]);
      }
    });
    return (pg.idx = { s, map });
  }
  async function buildHits(q) {
    const ftoken = ++st.find.token, token = st.token;
    const hits = [];
    const n = st.pages.length;
    for (let p = 0; p < n; p++) {
      const pg = st.pages[p];
      if (!pg.text) {
        try { pg.text = await pg.page.getTextContent(); } catch { pg.text = { items: [] }; }
        if (ftoken !== st.find.token || token !== st.token) return null;
        if (p % 20 === 0) $('#vFindInfo').textContent = `찾는 중… ${p + 1}/${n}쪽`;
      }
      const { s, map } = pageIndex(pg);
      for (let at = s.indexOf(q); at !== -1; at = s.indexOf(q, at + q.length)) {
        const ranges = [];
        for (let k = at; k < at + q.length; k++) {
          const [i, o] = map[k];
          const last = ranges[ranges.length - 1];
          if (last && last.i === i) last.to = o + 1; else ranges.push({ i, from: o, to: o + 1 });
        }
        hits.push({ p, ranges });
      }
    }
    return hits;
  }
  async function runFind(dir) {
    if (!st.doc) return;
    const q = norm($('#vFind').value);
    if (!q) return clearFind();
    if (q !== st.find.q) {
      const hits = await buildHits(q);
      if (!hits) return;
      const oldPages = new Set(st.find.hits.map((h) => h.p));
      st.find.q = q;
      st.find.hits = hits;
      let i = hits.findIndex((h) => h.p >= st.cur);
      if (dir < 0) { i = -1; for (let k = hits.length - 1; k >= 0; k--) if (hits[k].p <= st.cur) { i = k; break; } }
      st.find.i = hits.length ? (i === -1 ? (dir < 0 ? hits.length - 1 : 0) : i) : -1;
      for (const p of oldPages) applyHighlights(p);
    } else if (st.find.hits.length) {
      st.find.i = (st.find.i + (dir || 1) + st.find.hits.length) % st.find.hits.length;
    }
    const { hits, i } = st.find;
    $('#vFindInfo').textContent = hits.length ? `${i + 1} / ${hits.length}` : '찾는 글자가 없습니다';
    $('#vFind').classList.toggle('miss', !hits.length);
    for (const p of new Set(hits.map((h) => h.p))) applyHighlights(p);
    if (i >= 0) showHit(hits[i]);
  }
  async function showHit(h) {
    const pg = st.pages[h.p];
    if (h.p !== st.cur || !pg.layer) goto(h.p);
    await renderPage(h.p);
    applyHighlights(h.p);
    const sel = pg.el.querySelector('.hl.sel');
    if (sel) sel.scrollIntoView({ block: 'center', inline: 'nearest' });
  }
  function clearFind() {
    const pages = new Set(st.find.hits.map((h) => h.p));
    st.find.q = '';
    st.find.hits = [];
    st.find.i = -1;
    st.find.token++;
    for (const p of pages) applyHighlights(p);
    $('#vFindInfo').textContent = '';
    $('#vFind').classList.remove('miss');
  }
  function applyHighlights(p) {
    const pg = st.pages[p];
    if (!pg || !pg.layer) return;
    const divs = pg.layer.textDivs, strs = pg.layer.textContentItemsStr;
    for (const i of pg.hlItems) if (divs[i]) divs[i].textContent = strs[i];
    pg.hlItems = [];
    const cur = st.find.hits[st.find.i];
    const per = new Map();
    for (const h of st.find.hits) {
      if (h.p !== p) continue;
      for (const r of h.ranges) {
        if (!per.has(r.i)) per.set(r.i, []);
        per.get(r.i).push({ from: r.from, to: r.to, sel: h === cur });
      }
    }
    for (const [i, rs] of per) {
      const div = divs[i];
      if (!div) continue;
      const s = strs[i];
      rs.sort((a, b) => a.from - b.from);
      div.textContent = '';
      let at = 0;
      for (const r of rs) {
        if (r.from < at) continue;
        if (r.from > at) div.append(s.slice(at, r.from));
        const span = document.createElement('span');
        span.className = r.sel ? 'hl sel' : 'hl';
        span.textContent = s.slice(r.from, r.to);
        div.append(span);
        at = r.to;
      }
      if (at < s.length) div.append(s.slice(at));
      pg.hlItems.push(i);
    }
  }

  // ───── 인쇄 ─────
  async function print() {
    if (!st.doc) return;
    const n = st.pages.length, token = st.token;
    const r = await busy('인쇄 준비 중…', async () => {
      const pages = [];
      for (let p = 0; p < n; p++) {
        $('#busyText').textContent = `인쇄 준비 중… (${p + 1}/${n}쪽)`;
        const pg = st.pages[p];
        const vp = pg.page.getViewport({ scale: 150 / 72 });
        const c = document.createElement('canvas');
        c.width = Math.floor(vp.width);
        c.height = Math.floor(vp.height);
        await pg.page.render({ canvasContext: c.getContext('2d'), viewport: vp, intent: 'print' }).promise;
        const blob = await new Promise((res) => c.toBlob(res, 'image/jpeg', 0.92));
        pages.push({ bytes: new Uint8Array(await blob.arrayBuffer()), w: vp.width, h: vp.height });
        c.width = 0;
        if (token !== st.token) return { ok: true };
      }
      $('#busyText').textContent = '인쇄 창을 여는 중…';
      return api.printImages(pages, baseName(st.path));
    });
    if (!r.ok) toast(r.error, { err: true });
  }

  // ───── 단추 · 단축키 ─────
  async function pick() { const [f] = await api.pickPdfs(false); if (f) open(f); }
  $('#vOpen').onclick = pick;
  dropZone(drop, (files) => open(files[0]));
  $('#vPrev').onclick = () => gotoRow(-1);
  $('#vNext').onclick = () => gotoRow(1);
  $('#vPage').onchange = () => { const n = parseInt($('#vPage').value, 10); if (n) goto(n - 1); else setCur(st.cur); };
  $('#vPage').onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); $('#vPage').onchange(); drop.focus({ preventScroll: true }); } };
  $('#vZoom').onchange = () => { const v = $('#vZoom').value; if (v !== 'custom') setZoom(v === 'width' || v === 'page' ? v : Number(v)); };
  $('#vZoomIn').onclick = () => zoomStep(1);
  $('#vZoomOut').onclick = () => zoomStep(-1);
  $('#vSpread').onclick = (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    st.spread = b.dataset.s;
    $('#vSpread').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
    if (!st.doc) return;
    const a = captureAnchor();
    layout();
    setZoom(st.zoom, { anchor: a });
  };
  function rotate(d) {
    if (!st.doc) return;
    const p = st.cur;
    st.rot = (st.rot + d + 360) % 360;
    setZoom(st.zoom, { anchor: null });
    buildThumbs();
    goto(p);
  }
  $('#vRotL').onclick = () => rotate(-90);
  $('#vRotR').onclick = () => rotate(90);
  $('#vFull').onclick = () => { if (st.doc) drop.requestFullscreen().catch(() => {}); };
  $('#vPrint').onclick = print;
  $('#vSendTo').onchange = () => {
    const tab = $('#vSendTo').value;
    $('#vSendTo').value = '';
    if (!tab || !st.path) return;
    if (tab === 'external') api.openPath(st.path); // 윈도우에 정해진 기본 PDF 프로그램
    else openIn(tab, st.path);
  };
  function toggleSide(show = $('#vSide').classList.contains('hidden')) {
    $('#vSide').classList.toggle('hidden', !show);
    $('#vSideBtn').classList.toggle('on', show);
    try { localStorage.setItem('pdftool.viewer.side', show ? '1' : '0'); } catch {}
  }
  $('#vSideBtn').onclick = () => toggleSide();
  $('#vSideTabs').onclick = (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    $('#vSideTabs').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
    $('#vThumbs').classList.toggle('hidden', b.dataset.v !== 'thumbs');
    $('#vOutline').classList.toggle('hidden', b.dataset.v !== 'outline');
  };
  let findTimer = null;
  $('#vFind').oninput = () => { clearTimeout(findTimer); findTimer = setTimeout(() => runFind(0), 350); };
  $('#vFind').onkeydown = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); clearTimeout(findTimer); runFind(e.shiftKey ? -1 : 1); }
    if (e.key === 'Escape') { $('#vFind').value = ''; clearFind(); drop.focus({ preventScroll: true }); }
  };
  $('#vFindNext').onclick = () => runFind(1);
  $('#vFindPrev').onclick = () => runFind(-1);

  drop.addEventListener('wheel', (e) => {
    if (!e.ctrlKey || !st.doc) return;
    e.preventDefault();
    const f = (st.scale / CSS_UNITS) * (e.deltaY < 0 ? 1.1 : 1 / 1.1);
    setZoom(Math.round(clamp(f, 0.1, 8) * 100) / 100);
  }, { passive: false });

  let resizeTimer = null;
  new ResizeObserver(() => {
    if (!st.doc || (st.zoom !== 'width' && st.zoom !== 'page')) return;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => setZoom(st.zoom), 120);
  }).observe(drop);

  document.addEventListener('fullscreenchange', () => {
    if (document.fullscreenElement === drop) {
      st.preFs = st.zoom;
      drop.classList.add('fs');
      setZoom('page');
      setTimeout(() => goto(st.cur), 150);
    } else if (st.preFs != null) {
      drop.classList.remove('fs');
      const z = st.preFs;
      st.preFs = null;
      setZoom(z);
    }
  });

  document.addEventListener('keydown', (e) => {
    if (!isActive() || document.querySelector('.modal:not(.hidden)')) return;
    const ctrl = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();
    const typing = /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName);
    if (ctrl && k === 'f') { e.preventDefault(); $('#vFind').focus(); $('#vFind').select(); return; }
    if (ctrl && k === 'o') { e.preventDefault(); pick(); return; }
    if (!st.doc) return;
    if (ctrl && k === 'p') { e.preventDefault(); print(); return; }
    if (ctrl && (k === '=' || k === '+')) { e.preventDefault(); zoomStep(1); return; }
    if (ctrl && k === '-') { e.preventDefault(); zoomStep(-1); return; }
    if (ctrl && k === '0') { e.preventDefault(); setZoom(1); return; }
    if (e.key === 'F5') { e.preventDefault(); $('#vFull').onclick(); return; }
    if (e.key === 'F4') { e.preventDefault(); toggleSide(); return; }
    if (e.key === 'F3') { e.preventDefault(); runFind(e.shiftKey ? -1 : 1); return; }
    if (typing) return;
    const fs = drop.classList.contains('fs');
    const pageMode = fs || st.zoom === 'page';
    const noHScroll = drop.scrollWidth <= drop.clientWidth + 1;
    if (e.key === 'Home' && ctrl) { e.preventDefault(); goto(0); }
    else if (e.key === 'End' && ctrl) { e.preventDefault(); goto(st.pages.length - 1); }
    else if ((e.key === 'ArrowRight' && noHScroll) || (pageMode && (e.key === 'PageDown' || e.key === ' '))) { e.preventDefault(); gotoRow(1); }
    else if ((e.key === 'ArrowLeft' && noHScroll) || (pageMode && e.key === 'PageUp')) { e.preventDefault(); gotoRow(-1); }
  });

  try { if (localStorage.getItem('pdftool.viewer.side') === '0') toggleSide(false); } catch {}
  renderRecent();
  updateZoomUi();
  return { open, isOpen: () => !!st.doc, path: () => st.path };
}
