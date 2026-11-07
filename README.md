# PDF 도구

학교 업무에 자주 쓰는 PDF 작업을 한곳에 모은 윈도우 앱입니다.

## 내려받기

[Releases](https://github.com/j333333766-hub/pdf-tool/releases/latest)에서 `PdfTool-Setup-x.y.z.exe`를 받아 실행합니다.

- 윈도우 10·11 (64비트)
- 서명되지 않은 설치 파일이라 **"Windows의 PC 보호"** 창이 뜰 수 있습니다 → **추가 정보** → **실행**
- 설치 후 시작 메뉴의 **PDF 도구**로 실행하거나, 탐색기에서 PDF·한글 파일을 오른쪽 클릭해 바로 씁니다

## 기능

- **합치기·나누기**: 여러 PDF·그림(JPG/PNG)을 하나로, 쪽 범위·파일 이름 표로 나누기
- **쪽 정리**: 회전, 순서 바꾸기, 지우기, 자르기, 펼친 면 나누기
- **도장**: 쪽번호, 워터마크, 서명 넣기
- **용량 줄이기** (스캔본에 효과가 큼)
- **글자·그림 고치기**: 줄 단위 글자 바꾸기, 글상자·그림 넣기, 영역 지우기
- **한글 변환**: hwp/hwpx → PDF, hwp → HWPX (한글 2018 이상이 설치되어 있어야 함)

## 개발

```
npm install
npm start        # 실행
npm test         # 핵심 시험
npm run dist     # 설치 파일 만들기 (dist/)
```

## 라이선스

AGPL-3.0-or-later. PDF 편집에 [MuPDF](https://mupdf.com)(AGPL)를 씁니다. 자세한 고지는 `app/NOTICE.txt`.
`build/hwp/FilePathCheckerModule.dll`은 한컴 오토메이션 보안 승인 모듈 예제입니다.
