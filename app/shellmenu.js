// 윈도우 11 우클릭 첫 화면 메뉴 — 외부 위치(sparse) 패키지를 등록한다 (resources/shellmenu, 원본은 build/shellmenu)
//   1) 서명한 msix로 설치 — 이 PC가 서명 인증서를 믿을 때(처음 한 번 관리자 권한으로 인증서 등록)
//   2) 안 되면 개발자 모드일 때 매니페스트를 바로 등록(서명 불필요)
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
  };
}
const wantVersion = (app) => `${app.getVersion()}.0`;

async function status(app) {
  if (!supported()) return { supported: false, registered: false };
  const r = await ps(`$p = Get-AppxPackage -Name ${q(NAME)}; if ($p) { $p.Version + '|' + $p.SignatureKind }`);
  const [version, kind] = r.out.split('|');
  return { supported: true, registered: !!version, current: version === wantVersion(app), version, kind };
}

async function devMode() {
  const r = await ps(`(Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\AppModelUnlock' -ErrorAction SilentlyContinue).AllowDevelopmentWithoutDevLicense`);
  return r.out === '1';
}

// 결과: { ok } 또는 { ok:false, needAdmin:true } / { ok:false, error }
async function enable(app) {
  if (!supported()) return { ok: false, error: '윈도우 11에서만 쓸 수 있습니다.' };
  const p = paths(app);
  const signed = await ps(`Add-AppxPackage -Path ${q(p.msix)} -ExternalLocation ${q(p.installDir)} -ForceUpdateFromAnyVersion`);
  if (signed.ok) return { ok: true };
  if (await devMode()) {
    const loose = await ps(`Add-AppxPackage -Register ${q(p.manifest)} -ExternalLocation ${q(p.installDir)} -ForceUpdateFromAnyVersion`);
    if (loose.ok) return { ok: true };
    return { ok: false, error: loose.err.split(/\r?\n/)[0] };
  }
  // 0x800B0109 등: 인증서를 믿지 않음 → 관리자 권한으로 인증서를 한 번 등록해야 한다
  return { ok: false, needAdmin: true, error: signed.err.split(/\r?\n/)[0] };
}

// 관리자 권한 창(UAC)을 띄워 서명 인증서를 '신뢰할 수 있는 사람'에 넣고 다시 설치
async function enableWithAdmin(app) {
  const p = paths(app);
  const inner = `Import-Certificate -FilePath ${q(p.cer)} -CertStoreLocation Cert:\\LocalMachine\\TrustedPeople | Out-Null`;
  const r = await ps(`Start-Process powershell.exe -Verb RunAs -Wait -WindowStyle Hidden -ArgumentList '-NoProfile','-Command',${q(inner)}`);
  if (!r.ok) return { ok: false, error: '관리자 권한을 받지 못했습니다.' };
  return enable(app);
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

module.exports = { supported, status, enable, enableWithAdmin, disable, sync };
