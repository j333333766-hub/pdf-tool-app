// 윈도우 11 우클릭 첫 화면 메뉴 — 외부 위치(sparse) 패키지를 등록한다 (resources/shellmenu, 원본은 build/shellmenu)
//   순서는 register.ps1 참고 (서명 msix → 개발자 모드 등록 → 관리자 권한으로 인증서 등록 후 서명 msix)
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const NAME = 'j333333766.PdfToolShellMenu';

const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
function ps(script) {
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
      `[Console]::OutputEncoding=[Text.Encoding]::UTF8; $ErrorActionPreference='Stop'; ${script}`],
    { windowsHide: true, timeout: 120000 }, (err, stdout, stderr) => {
      resolve({ ok: !err, out: (stdout || '').trim(), err: (stderr || (err && err.message) || '').trim() });
    });
  });
}

// 윈도우 11(빌드 22000 이상)에서만 의미가 있다
const supported = () => process.platform === 'win32' && Number(os.release().split('.')[2]) >= 22000;

function paths(app) {
  const res = path.join(process.resourcesPath, 'shellmenu');
  return {
    installDir: path.dirname(app.getPath('exe')),
    manifest: path.join(res, 'AppxManifest.xml'),
    msix: path.join(res, 'PdfToolShellMenu.msix'),
    cer: path.join(res, 'pdftool-shellmenu.cer'),
    script: path.join(res, 'register.ps1'),
  };
}
const wantVersion = (app) => `${app.getVersion()}.0`;

async function status(app) {
  if (!supported()) return { supported: false, registered: false };
  const r = await ps(`$p = Get-AppxPackage -Name ${q(NAME)}; if ($p) { $p.Version + '|' + $p.SignatureKind }`);
  const [version, kind] = r.out.split('|');
  return { supported: true, registered: !!version, current: version === wantVersion(app), version, kind };
}

// 등록은 resources/shellmenu/register.ps1이 한다(설치 프로그램과 같은 순서: 서명 msix → 개발자 모드 → 관리자 권한으로 인증서 등록)
//   끝 코드 0 등록 / 3 관리자 권한 필요(또는 거절) / 4 그 밖의 실패
function runRegister(app, elevate) {
  const p = paths(app);
  const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', p.script, '-InstallDir', p.installDir, '-Force'];
  if (elevate) args.push('-Elevate');
  return new Promise((resolve) => {
    execFile('powershell.exe', args, { windowsHide: true, timeout: 180000 }, (err, _stdout, stderr) => {
      const code = err ? (typeof err.code === 'number' ? err.code : 4) : 0;
      resolve({ code, err: (stderr || (err && err.message) || '').trim() });
    });
  });
}

// 결과: { ok } 또는 { ok:false, needAdmin:true } / { ok:false, error }
async function enable(app, elevate = false) {
  if (!supported()) return { ok: false, error: '윈도우 11에서만 쓸 수 있습니다.' };
  const r = await runRegister(app, elevate);
  if (r.code === 0) return { ok: true, restartExplorer: true };
  if (r.code === 3) return { ok: false, needAdmin: true, error: elevate ? '관리자 권한을 받지 못했습니다.' : '' };
  return { ok: false, error: r.err.split(/\r?\n/)[0] || `등록 실패(${r.code})` };
}

// 관리자 권한 창(UAC)을 띄워 서명 인증서를 '신뢰할 수 있는 사람'에 넣고 다시 설치
const enableWithAdmin = (app) => enable(app, true);

// 탐색기를 다시 시작해야 첫 화면 메뉴가 바뀐다 (열린 폴더 창은 닫힘)
function restartExplorer() {
  return ps('Stop-Process -Name explorer -Force -ErrorAction SilentlyContinue; Start-Sleep -Seconds 3; if (-not (Get-Process explorer -ErrorAction SilentlyContinue)) { Start-Process explorer.exe }');
}

async function disable() {
  const r = await ps(`$p = Get-AppxPackage -Name ${q(NAME)}; if ($p) { Remove-AppxPackage -Package $p.PackageFullName }`);
  return r.ok ? { ok: true } : { ok: false, error: r.err.split(/\r?\n/)[0] };
}

// 앱 시작 때: 켜 두기로 했는데 없거나 옛 버전이면 조용히 다시 등록(관리자 창은 띄우지 않음)
async function sync(app, wanted) {
  const s = await status(app);
  if (!s.supported) return s;
  if (wanted && (!s.registered || !s.current)) await enable(app);
  if (!wanted && s.registered) await disable();
  return status(app);
}

module.exports = { supported, status, enable, enableWithAdmin, disable, sync, restartExplorer };
