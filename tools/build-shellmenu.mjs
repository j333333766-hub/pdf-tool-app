// 윈11 첫 화면 메뉴 패키지: 앱 버전을 매니페스트에 넣고, 외부 위치(sparse) 패키지를 만들어 서명한다.
//   DLL은 shell\build.cmd로 따로 빌드(소스 바뀔 때만). 결과: build/shellmenu/PdfToolShellMenu.msix
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';

const dir = 'build/shellmenu';
const sdk = 'C:/Program Files (x86)/Windows Kits/10/bin/10.0.26100.0/x64';
const version = JSON.parse(fs.readFileSync('package.json', 'utf8')).version + '.0';

const manifest = path.join(dir, 'AppxManifest.xml');
const xml = fs.readFileSync(manifest, 'utf8').replace(/(<Identity [^>]*Version=")[^"]+"/, `$1${version}"`);
fs.writeFileSync(manifest, xml);
if (!fs.existsSync(path.join(dir, 'PdfToolShell.dll'))) throw new Error('PdfToolShell.dll 없음 — shell\\build.cmd 먼저');

// 패키지에는 매니페스트와 그림만 — DLL·exe는 설치 폴더(외부 위치)에 있다
const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'shellmenu-'));
fs.copyFileSync(manifest, path.join(stage, 'AppxManifest.xml'));
fs.cpSync(path.join(dir, 'Assets'), path.join(stage, 'Assets'), { recursive: true });
const msix = path.join(dir, 'PdfToolShellMenu.msix');
execFileSync(`${sdk}/makeappx.exe`, ['pack', '/d', stage, '/p', msix, '/nv', '/o'], { stdio: 'ignore' });
execFileSync(`${sdk}/signtool.exe`, ['sign', '/fd', 'SHA256', '/f', 'build/cert/pdftool-shellmenu.pfx', '/p', 'pdftool-shellmenu', msix], { stdio: 'ignore' });
fs.rmSync(stage, { recursive: true, force: true });
console.log(`첫 화면 메뉴 패키지 ${version} 서명 완료`);
