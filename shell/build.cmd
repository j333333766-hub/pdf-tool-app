@echo off
chcp 65001 >nul
rem 윈11 첫 화면 메뉴 DLL 빌드 → build\shellmenu\PdfToolShell.dll (VS 2022 빌드 도구 필요)
setlocal
call "%ProgramFiles(x86)%\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat" >nul || exit /b 1
cd /d "%~dp0"
if not exist obj mkdir obj
rem /MT: VC 런타임을 따로 설치하지 않아도 되게
cl /nologo /utf-8 /O2 /MT /EHsc /W4 /DUNICODE /D_UNICODE /LD PdfToolShell.cpp /Foobj\ /Feobj\PdfToolShell.dll /link /DEF:PdfToolShell.def || exit /b 1
copy /y obj\PdfToolShell.dll ..\build\shellmenu\PdfToolShell.dll >nul
echo 빌드 완료
