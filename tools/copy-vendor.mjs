// pdf.js 화면용 파일을 app/vendor로 복사 (한글 PDF용 cmaps 포함)
import fs from 'fs';
const src = 'node_modules/pdfjs-dist';
const dst = 'app/vendor';
fs.rmSync(dst, { recursive: true, force: true });
fs.mkdirSync(dst, { recursive: true });
for (const f of ['pdf.min.mjs', 'pdf.worker.min.mjs']) fs.copyFileSync(`${src}/build/${f}`, `${dst}/${f}`);
fs.cpSync(`${src}/cmaps`, `${dst}/cmaps`, { recursive: true });
fs.cpSync(`${src}/standard_fonts`, `${dst}/standard_fonts`, { recursive: true });
// 학생 명렬표(.xlsx) 읽기용
fs.copyFileSync('node_modules/jszip/dist/jszip.min.js', `${dst}/jszip.min.js`);
console.log('vendor 복사 완료');
