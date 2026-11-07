const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require('electron');
const fs = require('fs');
const path = require('path');
const core = require('./core');
const registry = require('./registry');
const hwp = require('./hwp');
const shellmenu = require('./shellmenu');
const pdfedit = require('./pdfedit');

// --merge a.pdf b.pdf  /  --split a.pdf  /  --sign a.pdf  /  a.pdf(그냥 열기 = 서명 화면)
// --hwp2pdf a.hwp b.hwpx (PDF로 변환)  /  --hwpmerge a.hwp b.hwpx (PDF로 변환해서 합치기)  /  --hwp2hwpx a.hwp (HWPX로 변환)
function parseArgs(argv) {
  // 두 번째 실행에서 넘어온 argv는 Chromium이 스위치를 앞으로 옮겨 순서가 바뀌므로 자르지 말고 전부 훑는다
  const args = argv.slice(1);
  let mode = null;
  const files = [];
  for (const a of args) {
    if (['--merge', '--split', '--sign', '--hwp2pdf', '--hwpmerge', '--hwp2hwpx'].includes(a)) mode = a.slice(2);
    else if (/\.(pdf|hwpx?)$/i.test(a) && fs.existsSync(a)) files.push(path.resolve(a));
  }
  if (files.length && !mode) mode = files.every((f) => hwp.HWP_RE.test(f)) ? 'hwp2pdf' : 'sign';
  return { mode, files };
}

// 탐색기에서 여러 개를 골라 우클릭하면 파일마다 프로세스가 하나씩 뜬다 → 첫 창이 모아서 받는다
const pending = { mode: null, files: [] };
let flushTimer = null;
let win = null;
let rendererReady = false;

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
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: false },
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
  // 설치본이면 우클릭 메뉴가 지금 실행 파일을 가리키도록 맞춰 둔다
  if (app.isPackaged) {
    registry.isRegistered(process.execPath).then((ok) => { if (!ok) registry.register(process.execPath); });
    // 윈도우 11 첫 화면 메뉴도 (끄지 않았으면) 지금 버전으로 맞춘다
    shellmenu.sync(app, settings().shellMenu !== false).catch(() => {});
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
ipcMain.handle('hwp-convert', wrap(async (e, files, toTemp, format = 'PDF') => {
  let outDir = null;
  if (toTemp) {
    outDir = path.join(hwpTmpRoot(), String(Date.now()));
    await fs.promises.mkdir(outDir, { recursive: true });
  }
  return hwp.convert(app, files, { format, outDir, onProgress: (p) => e.sender.send('hwp-progress', p) });
}));
ipcMain.handle('hwp-cancel', () => hwp.cancel());
ipcMain.handle('pick-hwps', async () => {
  const r = await dialog.showOpenDialog(win, { filters: [{ name: '한글 문서', extensions: ['hwp', 'hwpx'] }], properties: ['openFile', 'multiSelections'] });
  return r.canceled ? [] : r.filePaths;
});
ipcMain.handle('show-in-folder', (_e, p) => shell.showItemInFolder(p));
ipcMain.handle('open-path', (_e, p) => shell.openPath(p));

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

ipcMain.handle('ctx-status', () => registry.isRegistered(app.isPackaged ? process.execPath : null));
ipcMain.handle('ctx-set', async (_e, on) => {
  if (!app.isPackaged) return { ok: false, error: '설치한 프로그램에서만 바꿀 수 있습니다.' };
  return { ok: on ? await registry.register(process.execPath) : await registry.unregister() };
});
