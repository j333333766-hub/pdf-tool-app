const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require('electron');
const fs = require('fs');
const path = require('path');
const core = require('./core');
const registry = require('./registry');
const hwp = require('./hwp');
const shellmenu = require('./shellmenu');
const pdfedit = require('./pdfedit');

// --view a.pdf  /  --merge a.pdf b.pdf  /  --split a.pdf  /  --sign a.pdf  /  a.pdf(그냥 열기 = 보기 화면)
// --hwp2pdf a.hwp b.hwpx (PDF로 변환)  /  --hwpmerge a.hwp b.hwpx (PDF로 변환해서 합치기)  /  --hwp2hwpx a.hwp (HWPX로 변환)
// --hwp2hwpx-del a.hwp (HWPX로 변환하고 원본 hwp는 휴지통으로)  /  --compress a.pdf (용량 줄이기: 10단계 실제 크기 보기)
function parseArgs(argv) {
  // 두 번째 실행에서 넘어온 argv는 Chromium이 스위치를 앞으로 옮겨 순서가 바뀌므로 자르지 말고 전부 훑는다
  const args = argv.slice(1);
  let mode = null;
  const files = [];
  for (const a of args) {
    if (['--view', '--merge', '--split', '--sign', '--hwp2pdf', '--hwpmerge', '--hwp2hwpx', '--hwp2hwpx-del', '--compress'].includes(a)) mode = a.slice(2);
    else if (/\.(pdf|hwpx?)$/i.test(a) && fs.existsSync(a)) files.push(path.resolve(a));
  }
  if (files.length && !mode) mode = files.every((f) => hwp.HWP_RE.test(f)) ? 'hwp2pdf' : 'view';
  return { mode, files };
}

// 탐색기에서 여러 개를 골라 우클릭하면 파일마다 프로세스가 하나씩 뜬다 → 첫 창이 모아서 받는다
const pending = { mode: null, files: [] };
let flushTimer = null;
let win = null;
let rendererReady = false;
let menu11HintPending = false;
function flushMenu11Hint() {
  if (!menu11HintPending || !rendererReady || !win) return;
  menu11HintPending = false;
  win.webContents.send('menu11-hint');
}

function queue({ mode, files }) {
  if (!files.length) return;
  pending.mode = pending.mode || mode;
  for (const f of files) if (!pending.files.includes(f)) pending.files.push(f);
  clearTimeout(flushTimer);
  flushTimer = setTimeout(flush, 700);
}

function flush() {
  if (!rendererReady || !win || !pending.files.length) return;
  win.webContents.send('open-files', { mode: pending.mode, files: pending.files.slice() });
  pending.mode = null;
  pending.files = [];
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    queue(parseArgs(argv));
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
  app.whenReady().then(start);
  app.on('window-all-closed', () => app.quit());
  // 끝낼 때 용량 줄이기 단계별 임시 PDF를 지운다(고른 것은 이미 복사됨)
  app.on('will-quit', () => { try { fs.rmSync(zipTmpRoot(), { recursive: true, force: true }); } catch {} });
}

function start() {
  Menu.setApplicationMenu(null);
  queue(parseArgs(process.argv));
  win = new BrowserWindow({
    width: 1200,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    title: 'PDF 도구',
    icon: path.join(__dirname, 'icon.png'),
    backgroundColor: '#f4f5f7',
    // backgroundThrottling: 다른 창을 보는 동안에도 용량 줄이기·그림 변환·보기 화면 그리기가 멈추지 않게
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: false, backgroundThrottling: false },
  });
  win.loadFile(path.join(__dirname, 'index.html'));
  // 편집하던 PDF를 저장하지 않고 닫으려 하면 묻는다
  win.on('close', (e) => {
    if (!pdfedit.isDirty()) return;
    const r = dialog.showMessageBoxSync(win, {
      type: 'question', buttons: ['저장하지 않고 닫기', '취소'], defaultId: 1, cancelId: 1,
      title: 'PDF 도구', message: '편집한 내용을 저장하지 않았습니다. 그래도 닫을까요?',
    });
    if (r === 1) e.preventDefault();
  });
  win.webContents.on('did-start-loading', () => { rendererReady = false; });
  // 개발 중 확인용: F12 개발자 도구
  win.webContents.on('before-input-event', (_e, input) => {
    if (input.type === 'keyDown' && input.key === 'F12') win.webContents.toggleDevTools();
  });
  // 지난번 '변환해서 합치기'에서 남은 임시 PDF 정리
  fs.rm(hwpTmpRoot(), { recursive: true, force: true }, () => {});
  // 지난번 용량 줄이기에서 남은 단계별 임시 PDF 정리
  fs.rm(zipTmpRoot(), { recursive: true, force: true }, () => {});
  // 설치본이면 우클릭 메뉴가 지금 실행 파일을 가리키도록 맞춰 둔다
  if (app.isPackaged) {
    registry.isRegistered(process.execPath).then((ok) => { if (!ok) registry.register(process.execPath); });
    // 윈도우 11 첫 화면 메뉴도 (끄지 않았으면) 지금 버전으로 맞춘다
    // 끝내 못 켰으면(관리자 권한 필요 등) 버전마다 한 번 'Shift+오른쪽 클릭' 안내
    shellmenu.sync(app, settings().shellMenu !== false).then((s) => {
      const st = settings();
      if (s && s.supported && !s.registered && st.shellMenu !== false && st.menu11Hint !== app.getVersion()) {
        saveSettings({ menu11Hint: app.getVersion() });
        menu11HintPending = true;
        flushMenu11Hint();
      }
    }).catch(() => {});
  }
}

function wrap(fn) {
  return async (...args) => {
    try {
      return { ok: true, value: await fn(...args) };
    } catch (e) {
      return { ok: false, error: e instanceof core.PdfError || e instanceof pdfedit.EditError ? e.message : `오류가 났습니다: ${e.message}` };
    }
  };
}

const PDF_FILTER = [{ name: 'PDF', extensions: ['pdf'] }];
const IMAGE_EXT = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'];
const sigDir = () => path.join(app.getPath('userData'), 'signatures');
const hwpTmpRoot = () => path.join(app.getPath('userData'), 'hwp-merge');
const zipTmpRoot = () => path.join(app.getPath('userData'), 'compress-tmp');
// 용량 줄이기 임시 파일: compress-tmp/<묶음>/<단계>.pdf — 묶음·단계는 숫자만 받는다
function zipTmpFile(key, lvl) {
  if (!/^\d{1,20}$/.test(String(key)) || !(lvl >= 1 && lvl <= 10)) throw new Error('잘못된 단계입니다.');
  return path.join(zipTmpRoot(), String(key), `${Math.trunc(lvl)}.pdf`);
}

// 앱 설정 (settings.json)
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
function settings() {
  try { return JSON.parse(fs.readFileSync(settingsFile(), 'utf8')); } catch { return {}; }
}
function saveSettings(patch) {
  fs.writeFileSync(settingsFile(), JSON.stringify({ ...settings(), ...patch }, null, 2));
}

ipcMain.handle('ready', () => {
  rendererReady = true;
  setTimeout(flush, 0);
  setTimeout(flushMenu11Hint, 0);
  return { version: app.getVersion(), packaged: app.isPackaged };
});

ipcMain.handle('pick-pdfs', async (_e, multi) => {
  const r = await dialog.showOpenDialog(win, { filters: PDF_FILTER, properties: multi ? ['openFile', 'multiSelections'] : ['openFile'] });
  return r.canceled ? [] : r.filePaths;
});
ipcMain.handle('pick-pdfs-images', async () => {
  const r = await dialog.showOpenDialog(win, { filters: [{ name: 'PDF·그림', extensions: ['pdf', ...IMAGE_EXT] }], properties: ['openFile', 'multiSelections'] });
  return r.canceled ? [] : r.filePaths;
});
ipcMain.handle('pick-xlsx', async () => {
  const r = await dialog.showOpenDialog(win, { filters: [{ name: '엑셀', extensions: ['xlsx'] }], properties: ['openFile'] });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle('pick-image', async () => {
  const r = await dialog.showOpenDialog(win, { filters: [{ name: '그림', extensions: ['png', 'jpg', 'jpeg'] }], properties: ['openFile'] });
  return r.canceled ? null : r.filePaths[0];
});
// 글자·그림 편집 (MuPDF)
ipcMain.handle('edit-open', wrap((_e, p) => pdfedit.open(p)));
ipcMain.handle('edit-page', wrap((_e, i, scale) => pdfedit.pageInfo(i, scale)));
ipcMain.handle('edit-apply', wrap((_e, op) => pdfedit.apply(op)));
ipcMain.handle('edit-undo', wrap(() => pdfedit.undo()));
ipcMain.handle('edit-save', wrap((_e, out) => pdfedit.save(out)));
ipcMain.handle('edit-image-size', wrap((_e, p) => pdfedit.imageSize(p)));
ipcMain.handle('pick-dir', async (_e, defaultPath) => {
  const r = await dialog.showOpenDialog(win, { defaultPath, properties: ['openDirectory', 'createDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle('save-pdf', async (_e, defaultPath) => {
  const r = await dialog.showSaveDialog(win, { defaultPath, filters: PDF_FILTER });
  if (r.canceled) return null;
  return /\.pdf$/i.test(r.filePath) ? r.filePath : `${r.filePath}.pdf`;
});

ipcMain.handle('read-file', wrap(async (_e, p) => new Uint8Array(await fs.promises.readFile(p))));
ipcMain.handle('page-count', wrap((_e, p) => core.pageCount(p)));
ipcMain.handle('merge', wrap((_e, files, out, opts) => core.merge(files, out, opts)));
ipcMain.handle('parse-ranges', wrap((_e, text, total) => core.parseRanges(text, total)));
ipcMain.handle('split', wrap((_e, file, groups, dir, names) => core.split(file, groups, dir, names)));
ipcMain.handle('parse-pages', wrap((_e, text, total) => core.parsePages(text, total)));
ipcMain.handle('rotate', wrap((_e, file, pages, angle, out) => core.rotate(file, pages, angle, out)));
ipcMain.handle('organize', wrap((_e, file, order, out) => core.organize(file, order, out)));
ipcMain.handle('stamp', wrap((_e, file, opts, out) => core.stamp(file, opts, out)));
ipcMain.handle('unspread', wrap((_e, file, scope, dir, swap, out) => core.unspread(file, scope, dir, swap, out)));
ipcMain.handle('crop', wrap((_e, file, pages, box, out) => core.crop(file, pages, box, out)));
ipcMain.handle('from-jpegs', wrap((_e, pages, out) => core.fromJpegs(pages, out)));
ipcMain.handle('split-named', wrap((_e, file, tasks, dir, folder) => core.splitNamed(file, tasks, dir, folder)));
ipcMain.handle('write-files', wrap((_e, dir, folder, files) => core.writeFiles(dir, folder, files)));
ipcMain.handle('file-size', async (_e, p) => (await fs.promises.stat(p)).size);
// 용량 줄이기: 단계별 파일을 임시 폴더에 실제로 만들어 크기를 재고, 고른 것만 저장 위치로 복사한다
ipcMain.handle('compress-temp', wrap(async (_e, key, lvl, pages) => {
  const out = zipTmpFile(key, lvl);
  await fs.promises.mkdir(path.dirname(out), { recursive: true });
  return core.fromJpegs(pages, out);
}));
ipcMain.handle('compress-save', wrap(async (_e, key, lvl, out) => {
  await fs.promises.copyFile(zipTmpFile(key, lvl), out);
  return { outPath: out, size: (await fs.promises.stat(out)).size };
}));
ipcMain.handle('compress-clear', wrap(async (_e, key) => {
  await fs.promises.rm(path.dirname(zipTmpFile(key, 1)), { recursive: true, force: true });
  return true;
}));

// 학교 명렬표 — 앱 설정 폴더에 보관(학생 이름이 들어 있으므로 이 컴퓨터 사용자 폴더에만)
const rosterFile = () => path.join(app.getPath('userData'), 'roster.json');
ipcMain.handle('roster-get', async () => {
  try { return JSON.parse(await fs.promises.readFile(rosterFile(), 'utf8')); } catch { return { students: [], sourceName: '' }; }
});
ipcMain.handle('roster-set', async (_e, data) => {
  if (!data || !data.students || !data.students.length) await fs.promises.rm(rosterFile(), { force: true });
  else await fs.promises.writeFile(rosterFile(), JSON.stringify(data));
  return true;
});
ipcMain.handle('roster-sample', async () => {
  const r = await dialog.showSaveDialog(win, { defaultPath: path.join(app.getPath('downloads'), '학생 명렬표_샘플.xlsx'), filters: [{ name: '엑셀', extensions: ['xlsx'] }] });
  if (r.canceled) return null;
  await fs.promises.copyFile(path.join(__dirname, 'assets', 'roster-sample.xlsx'), r.filePath);
  return r.filePath;
});
ipcMain.handle('sign', wrap((_e, file, stamps, out) => core.sign(file, stamps.map((s) => ({ ...s, png: Buffer.from(s.png) })), out)));
// 한글 → PDF·HWPX. toTemp면 합치기용 임시 폴더에, 아니면 원본 옆에 만든다
// delSrc: HWPX로 바꾼 뒤 원본 hwp를 휴지통으로 보낸다 (새 파일이 제대로 생긴 것만)
ipcMain.handle('hwp-convert', wrap(async (e, files, toTemp, format = 'PDF', delSrc = false) => {
  let outDir = null;
  if (toTemp) {
    outDir = path.join(hwpTmpRoot(), String(Date.now()));
    await fs.promises.mkdir(outDir, { recursive: true });
  }
  const results = await hwp.convert(app, files, { format, outDir, onProgress: (p) => e.sender.send('hwp-progress', p) });
  if (delSrc && format === 'HWPX' && !toTemp) {
    for (const r of results) {
      if (!r.out || r.error) continue;
      try {
        const st = fs.statSync(r.out);
        // HWPX는 ZIP — 첫 4바이트가 PK가 아니면 원본을 남긴다
        const fd = fs.openSync(r.out, 'r');
        const b = Buffer.alloc(4);
        try { fs.readSync(fd, b, 0, 4, 0); } finally { fs.closeSync(fd); }
        if (!st.size || b.readUInt32BE(0) !== 0x504b0304) throw new Error('새 HWPX 파일을 확인하지 못해 원본을 남겼습니다');
        await shell.trashItem(r.src);
        r.trashed = true;
      } catch (err) {
        r.trashError = err.message || '원본을 지우지 못했습니다';
      }
    }
  }
  return results;
}));
ipcMain.handle('hwp-cancel', () => hwp.cancel());
ipcMain.handle('pick-hwps', async () => {
  const r = await dialog.showOpenDialog(win, { filters: [{ name: '한글 문서', extensions: ['hwp', 'hwpx'] }], properties: ['openFile', 'multiSelections'] });
  return r.canceled ? [] : r.filePaths;
});
ipcMain.handle('show-in-folder', (_e, p) => shell.showItemInFolder(p));
ipcMain.handle('open-path', (_e, p) => shell.openPath(p));
// PDF 안의 인터넷 링크 — 웹 주소와 메일 주소만 연다
ipcMain.handle('open-external', async (_e, url) => {
  if (!/^(https?:|mailto:)/i.test(String(url))) return false;
  await shell.openExternal(String(url));
  return true;
});

// 보기 화면 인쇄 — 쪽 그림(150dpi)을 숨은 창에 한 장씩 놓고 윈도우 인쇄 창을 띄운다
ipcMain.handle('print-images', wrap(async (_e, pages, title) => {
  const dir = path.join(app.getPath('temp'), `pdftool-print-${Date.now()}`);
  await fs.promises.mkdir(dir, { recursive: true });
  try {
    const body = [];
    for (const [i, pg] of pages.entries()) {
      await fs.promises.writeFile(path.join(dir, `${i}.jpg`), Buffer.from(pg.bytes));
      body.push(`<div class="pg${pg.w > pg.h ? ' land' : ''}"><img src="${i}.jpg"></div>`);
    }
    const esc = String(title || 'PDF').replace(/[<>&"]/g, '');
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>${esc}</title><style>
@page { size: A4 portrait; margin: 0 } @page land { size: A4 landscape; margin: 0 }
html, body { margin: 0; padding: 0; }
.pg { width: 100vw; height: 100vh; display: flex; align-items: center; justify-content: center; overflow: hidden; break-after: page; }
.pg.land { page: land; }
.pg:last-child { break-after: auto; }
.pg img { max-width: 100%; max-height: 100%; }
</style></head><body>${body.join('')}</body></html>`;
    await fs.promises.writeFile(path.join(dir, 'print.html'), html);
    const pw = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
    try {
      await pw.loadFile(path.join(dir, 'print.html'));
      if (process.env.PDFTOOL_PRINT_TEST) {
        await fs.promises.writeFile(process.env.PDFTOOL_PRINT_TEST, await pw.webContents.printToPDF({ preferCSSPageSize: true, printBackground: true }));
        return true;
      }
      await new Promise((resolve, reject) => pw.webContents.print({ silent: false, printBackground: true }, (ok, reason) => {
        if (ok || /cancel/i.test(String(reason))) resolve(); else reject(new Error(reason));
      }));
    } finally { pw.destroy(); }
    return true;
  } finally {
    fs.rm(dir, { recursive: true, force: true }, () => {});
  }
}));

// 저장해 둔 서명 (PNG)
ipcMain.handle('sig-list', async () => {
  await fs.promises.mkdir(sigDir(), { recursive: true });
  const names = (await fs.promises.readdir(sigDir())).filter((n) => n.endsWith('.png')).sort();
  return Promise.all(names.map(async (name) => ({ name, png: new Uint8Array(await fs.promises.readFile(path.join(sigDir(), name))) })));
});
ipcMain.handle('sig-save', async (_e, png) => {
  await fs.promises.mkdir(sigDir(), { recursive: true });
  const name = `sig-${Date.now()}.png`;
  await fs.promises.writeFile(path.join(sigDir(), name), Buffer.from(png));
  return name;
});
ipcMain.handle('sig-delete', async (_e, name) => {
  await fs.promises.rm(path.join(sigDir(), path.basename(name)), { force: true });
});

// 윈도우 11 첫 화면 메뉴
ipcMain.handle('menu11-status', () => (app.isPackaged ? shellmenu.status(app) : { supported: shellmenu.supported(), dev: true }));
ipcMain.handle('menu11-set', async (_e, on, admin) => {
  if (!app.isPackaged) return { ok: false, error: '설치한 프로그램에서만 바꿀 수 있습니다.' };
  saveSettings({ shellMenu: !!on });
  if (!on) return shellmenu.disable();
  return admin ? shellmenu.enableWithAdmin(app) : shellmenu.enable(app);
});

ipcMain.handle('menu11-restart-explorer', () => shellmenu.restartExplorer());

ipcMain.handle('ctx-status', () => registry.isRegistered(app.isPackaged ? process.execPath : null));
ipcMain.handle('ctx-set', async (_e, on) => {
  if (!app.isPackaged) return { ok: false, error: '설치한 프로그램에서만 바꿀 수 있습니다.' };
  return { ok: on ? await registry.register(process.execPath) : await registry.unregister() };
});
