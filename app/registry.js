// 파일 탐색기 우클릭 메뉴 — HKCU라서 관리자 권한이 필요 없다
const { execFile } = require('child_process');

const BASE = 'HKCU\Software\Classes\SystemFileAssociations';
// [확장자, 키 이름, 메뉴 글자, 실행 스위치]  (build/installer.nsh도 같이 고칠 것)
const ENTRIES = [
  ['.pdf', 'PdfToolMerge', 'PDF 합치기', '--merge'],
  ['.hwp', 'PdfToolHwp2Pdf', 'PDF로 변환', '--hwp2pdf'],
  ['.hwp', 'PdfToolHwpMerge', 'PDF로 변환해서 합치기', '--hwpmerge'],
  ['.hwp', 'PdfToolHwp2Hwpx', 'HWPX로 변환', '--hwp2hwpx'],
  ['.hwpx', 'PdfToolHwp2Pdf', 'PDF로 변환', '--hwp2pdf'],
  ['.hwpx', 'PdfToolHwpMerge', 'PDF로 변환해서 합치기', '--hwpmerge'],
];
const keyOf = ([ext, name]) => `${BASE}\${ext}\shell\${name}`;

function reg(args) {
  return new Promise((resolve) => {
    execFile('reg.exe', args, { windowsHide: true }, (err, stdout) => resolve({ ok: !err, stdout: stdout || '' }));
  });
}

async function isRegistered(exePath) {
  for (const e of ENTRIES) {
    const r = await reg(['query', `${keyOf(e)}\command`, '/ve']);
    if (!r.ok || (exePath && !r.stdout.toLowerCase().includes(exePath.toLowerCase()))) return false;
  }
  return true;
}

async function register(exePath) {
  for (const e of ENTRIES) {
    const key = keyOf(e);
    const steps = [
      ['add', key, '/v', 'MUIVerb', '/d', e[2], '/f'],
      ['add', key, '/v', 'Icon', '/d', `"${exePath}",0`, '/f'],
      // Player: 15개 넘게 골라도 메뉴가 사라지지 않게
      ['add', key, '/v', 'MultiSelectModel', '/d', 'Player', '/f'],
      ['add', `${key}\command`, '/ve', '/d', `"${exePath}" ${e[3]} "%1"`, '/f'],
    ];
    for (const s of steps) {
      const r = await reg(s);
      if (!r.ok) return false;
    }
  }
  return true;
}

async function unregister() {
  let ok = true;
  for (const e of ENTRIES) {
    const r = await reg(['delete', keyOf(e), '/f']);
    ok = ok && (r.ok || !(await reg(['query', keyOf(e)])).ok);
  }
  return ok;
}

module.exports = { register, unregister, isRegistered };
