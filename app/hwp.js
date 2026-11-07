// 한글(HWP/HWPX) → PDF·HWPX — 한글 프로그램을 COM으로 몰래 띄워 저장한다 (작업자: build/hwp/hwp2pdf.ps1)
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFile } = require('child_process');

const HWP_RE = /\.hwpx?$/i;

// 설치본은 resources/hwp, 개발 중에는 build/hwp
function resDir(app) {
  return app && app.isPackaged ? path.join(process.resourcesPath, 'hwp') : path.join(__dirname, '..', 'build', 'hwp');
}

// HWP5 암호 문서 미리 걸러내기 — 한글이 암호 입력창을 띄우면 작업이 멈춘다.
// FileHeader 스트림은 "HWP Document File" 서명(32바이트)·버전(4)·속성(4) 순이고 속성 비트 1이 암호 여부.
function isEncryptedHwp(file) {
  if (!/\.hwp$/i.test(file)) return false;
  const buf = fs.readFileSync(file);
  const at = buf.indexOf('HWP Document File', 0, 'latin1');
  if (at < 0 || at + 40 > buf.length) return false;
  return (buf.readUInt32LE(at + 36) & 0x02) !== 0;
}

// 확장자만 바꾼 파일은 한글이 글자 그대로 열어 PDF로 만들어 버리므로 미리 막는다
// .hwp = OLE 또는 옛 "HWP Document File" 헤더, .hwpx = ZIP
function looksLikeHwp(file) {
  const fd = fs.openSync(file, 'r');
  const b = Buffer.alloc(32);
  try { fs.readSync(fd, b, 0, 32, 0); } finally { fs.closeSync(fd); }
  if (/\.hwpx$/i.test(file)) return b.readUInt32BE(0) === 0x504b0304;
  return b.readUInt32BE(0) === 0xd0cf11e0 || b.toString('latin1', 0, 17) === 'HWP Document File';
}

// 같은 이름이 있으면 "이름 (1).pdf" — taken: 이번에 이미 쓰기로 한 경로
function outTarget(dir, src, ext, taken) {
  const base = path.basename(src).replace(HWP_RE, '');
  let p = path.join(dir, `${base}${ext}`);
  for (let n = 1; fs.existsSync(p) || taken.has(p.toLowerCase()); n++) p = path.join(dir, `${base} (${n})${ext}`);
  taken.add(p.toLowerCase());
  return p;
}

let current = null; // 동시에 하나만

// files: 원본 경로들, format: 'PDF'|'HWPX', outDir: null이면 원본 옆
// onProgress({ i, state: 'run'|'ok'|'err', out?, error? })
// 결과: [{ src, out?, error? }]
function convert(app, files, { format = 'PDF', outDir = null, onProgress = () => {} } = {}) {
  if (current) return Promise.reject(new Error('이미 변환 중입니다.'));
  const results = files.map((src) => ({ src }));
  const taken = new Set();
  const jobs = [];
  results.forEach((r, i) => {
    try {
      if (!fs.existsSync(r.src)) throw new Error('원본 파일을 찾을 수 없습니다');
      if (format === 'HWPX' && !/\.hwp$/i.test(r.src)) throw new Error('이미 HWPX 문서입니다');
      if (!looksLikeHwp(r.src)) throw new Error('한글 문서 형식이 아닙니다 (확장자만 바뀐 파일이거나 손상된 문서)');
      if (isEncryptedHwp(r.src)) throw new Error('암호가 걸린 문서는 변환할 수 없습니다 (암호를 해제한 뒤 다시 시도하세요)');
      r.out = outTarget(outDir || path.dirname(r.src), r.src, format === 'HWPX' ? '.hwpx' : '.pdf', taken);
      jobs.push(i);
    } catch (e) {
      r.error = e.message;
      onProgress({ i, state: 'err', error: r.error });
    }
  });
  if (!jobs.length) return Promise.resolve(results);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdftool-hwp-'));
  const job = path.join(dir, 'job.txt');
  const body = [path.join(resDir(app), 'FilePathCheckerModule.dll'), format, ...jobs.map((i) => `${results[i].src}\t${results[i].out}`)].join('\r\n');
  fs.writeFileSync(job, '﻿' + body, 'utf16le');

  return new Promise((resolve) => {
    const ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(resDir(app), 'hwp2pdf.ps1'), '-JobPath', job], { windowsHide: true });
    const hwpPids = [];
    let buf = '';
    let watchdog = null;
    let timedOut = false;
    // 한 파일이 3분 넘게 끝나지 않으면 한글이 대화상자에 걸린 것으로 보고 정리한다
    const arm = () => {
      clearTimeout(watchdog);
      watchdog = setTimeout(() => { timedOut = true; kill(); }, 180000);
    };
    const kill = () => {
      for (const p of hwpPids) execFile('taskkill.exe', ['/PID', String(p), '/T', '/F'], { windowsHide: true }, () => {});
      execFile('taskkill.exe', ['/PID', String(ps.pid), '/T', '/F'], { windowsHide: true }, () => {});
    };
    current = { cancel: () => { fs.writeFileSync(`${job}.cancel`, ''); }, kill };
    arm();

    const onLine = (line) => {
      const [a, state, rest = ''] = line.trim().split('|');
      if (a === 'hwppid') return hwpPids.push(Number(state));
      if (a === 'done' || !/^\d+$/.test(a)) return;
      const i = jobs[Number(a)];
      if (i == null) return;
      arm();
      if (state === 'ok') { results[i].done = true; onProgress({ i, state, out: results[i].out }); }
      else if (state === 'err') { results[i].error = rest || '변환에 실패했습니다'; onProgress({ i, state, error: results[i].error }); }
      else onProgress({ i, state: 'run' });
    };
    ps.stdout.setEncoding('utf8');
    ps.stdout.on('data', (d) => {
      buf += d;
      const parts = buf.split(/\r?\n/);
      buf = parts.pop();
      parts.forEach(onLine);
    });
    let errText = '';
    ps.stderr.setEncoding('utf8');
    ps.stderr.on('data', (d) => { errText += d; });
    ps.on('close', () => {
      if (buf) onLine(buf);
      clearTimeout(watchdog);
      current = null;
      const cancelled = fs.existsSync(`${job}.cancel`);
      // 끝까지 결과를 못 받은 파일 정리 (도중에 끊겨 반쯤 쓴 파일은 지운다)
      for (const i of jobs) {
        const r = results[i];
        if (r.error) { delete r.out; continue; }
        if (!r.done) {
          fs.rmSync(r.out, { force: true });
          r.error = timedOut ? '한글이 응답하지 않아 중지했습니다 (대화상자가 떴거나 문서가 너무 큽니다)'
            : cancelled ? '사용자가 중지함'
              : (errText.trim().split(/\r?\n/)[0] || '변환에 실패했습니다');
          delete r.out;
          onProgress({ i, state: 'err', error: r.error });
        }
      }
      fs.rm(dir, { recursive: true, force: true }, () => {});
      resolve(results);
    });
  });
}

function cancel() { if (current) current.cancel(); }

module.exports = { HWP_RE, convert, cancel, isEncryptedHwp };
