// 파일 탐색기 우클릭 메뉴 — HKCU라서 관리자 권한이 필요 없다
// (1.5.0까지는 경로의 역슬래시가 하나뿐이라 JS 문자열에서 사라져 이 코드의 등록·해제가 실제로는 실패했다 → 1.6.0에서 고침)
const { execFile } = require('child_process');

const BASE = 'HKCU\\Software\\Classes\\SystemFileAssociations';
// [확장자, 키 이름, 메뉴 글자, 실행 스위치]  (build/installer.nsh도 같이 고칠 것)
const ENTRIES = [
  ['.pdf', 'PdfToolView', 'PDF 도구로 보기', '--view'],
  ['.pdf', 'PdfToolMerge', 'PDF 합치기', '--merge'],
  ['.pdf', 'PdfToolCompress', 'PDF 용량 줄이기', '--compress'],
  ['.hwp', 'PdfToolHwp2Pdf', 'PDF로 변환', '--hwp2pdf'],
  ['.hwp', 'PdfToolHwpMerge', 'PDF로 변환해서 합치기', '--hwpmerge'],
  ['.hwp', 'PdfToolHwp2Hwpx', 'HWPX로 변환', '--hwp2hwpx'],
  ['.hwp', 'PdfToolHwp2HwpxDel', 'HWPX로 변환 (원본 삭제)', '--hwp2hwpx-del'],
  ['.hwpx', 'PdfToolHwp2Pdf', 'PDF로 변환', '--hwp2pdf'],
  ['.hwpx', 'PdfToolHwpMerge', 'PDF로 변환해서 합치기', '--hwpmerge'],
];
const keyOf = ([ext, name]) => `${BASE}\\${ext}\\shell\\${name}`;

// '연결 프로그램' · '기본 앱' 목록에 PDF 도구가 나오게 한다.
// 기본 앱으로 정하는 것은 윈도우가 막아 두었으므로 사용자가 직접 고른다(설정 → 앱 → 기본 앱).
const PROGID = 'HKCU\\Software\\Classes\\PdfTool.PDF';
const OPENWITH = 'HKCU\\Software\\Classes\\.pdf\\OpenWithProgids';

function reg(args) {
  return new Promise((resolve) => {
    execFile('reg.exe', args, { windowsHide: true }, (err, stdout) => resolve({ ok: !err, stdout: stdout || '' }));
  });
}

async function isRegistered(exePath) {
  const keys = [...ENTRIES.map((e) => `${keyOf(e)}\\command`), `${PROGID}\\shell\\open\\command`];
  for (const k of keys) {
    const r = await reg(['query', k, '/ve']);
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
      ['add', `${key}\\command`, '/ve', '/d', `"${exePath}" ${e[3]} "%1"`, '/f'],
    ];
    for (const s of steps) {
      const r = await reg(s);
      if (!r.ok) return false;
    }
  }
  const steps = [
    ['add', PROGID, '/ve', '/d', 'PDF 문서 (PDF 도구)', '/f'],
    ['add', `${PROGID}\\DefaultIcon`, '/ve', '/d', `"${exePath}",0`, '/f'],
    ['add', `${PROGID}\\shell\\open`, '/v', 'FriendlyAppName', '/d', 'PDF 도구', '/f'],
    ['add', `${PROGID}\\shell\\open\\command`, '/ve', '/d', `"${exePath}" --view "%1"`, '/f'],
    ['add', OPENWITH, '/v', 'PdfTool.PDF', '/t', 'REG_NONE', '/f'],
  ];
  for (const s of steps) {
    const r = await reg(s);
    if (!r.ok) return false;
  }
  return true;
}

async function unregister() {
  let ok = true;
  for (const e of ENTRIES) {
    const r = await reg(['delete', keyOf(e), '/f']);
    ok = ok && (r.ok || !(await reg(['query', keyOf(e)])).ok);
  }
  await reg(['delete', OPENWITH, '/v', 'PdfTool.PDF', '/f']);
  await reg(['delete', PROGID, '/f']);
  return ok;
}

module.exports = { register, unregister, isRegistered };
