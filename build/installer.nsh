; 파일 탐색기 우클릭 메뉴 — 현재 사용자(HKCU)에 등록 (app/registry.js와 같은 목록)
!define PDFTOOL_SFA "Software\Classes\SystemFileAssociations"

!macro PdfToolVerb EXT NAME TEXT SWITCH
  WriteRegStr HKCU "${PDFTOOL_SFA}\${EXT}\shell\${NAME}" "MUIVerb" "${TEXT}"
  WriteRegStr HKCU "${PDFTOOL_SFA}\${EXT}\shell\${NAME}" "Icon" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}",0'
  WriteRegStr HKCU "${PDFTOOL_SFA}\${EXT}\shell\${NAME}" "MultiSelectModel" "Player"
  WriteRegStr HKCU "${PDFTOOL_SFA}\${EXT}\shell\${NAME}\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" ${SWITCH} "%1"'
!macroend

; 첫 화면 메뉴 DLL은 dllhost가 붙잡고 있어 덮어쓰기 전에 패키지를 내리고 그 dllhost를 닫는다.
; 새 버전 패키지는 설치 끝에(PdfToolRegisterShellMenu), 그래도 없으면 앱이 시작할 때 다시 등록한다(app/shellmenu.js).
!macro PdfToolReleaseShellMenu
  nsExec::Exec `powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "Get-AppxPackage -Name j333333766.PdfToolShellMenu | Remove-AppxPackage; Get-Process dllhost -ErrorAction SilentlyContinue | Where-Object { $$_.Modules.FileName -like '*PdfToolShell.dll' } | Stop-Process -Force"`
  Pop $0
!macroend

; 설치 직후 첫 화면 메뉴 등록 — 사용자가 설정에서 끈 경우는 건너뜀. 서명 패키지가 안 되면 개발자 모드 등록, 그것도 안 되면 앱 설정에서 켜기.
!macro PdfToolRegisterShellMenu
  nsExec::Exec `powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$$s = Join-Path $$env:APPDATA 'PDF 도구\settings.json'; if ((Test-Path $$s) -and ((Get-Content $$s -Raw -Encoding UTF8 | ConvertFrom-Json).shellMenu -eq $$false)) { exit }; $$d = '$INSTDIR'; try { Add-AppxPackage -Path (Join-Path $$d 'resources\shellmenu\PdfToolShellMenu.msix') -ExternalLocation $$d -ForceUpdateFromAnyVersion -ErrorAction Stop } catch { Add-AppxPackage -Register (Join-Path $$d 'resources\shellmenu\AppxManifest.xml') -ExternalLocation $$d -ForceUpdateFromAnyVersion -ErrorAction SilentlyContinue }"`
  Pop $0
!macroend

!macro customInit
  !insertmacro PdfToolReleaseShellMenu
!macroend

!macro customInstall
  !insertmacro PdfToolVerb ".pdf" "PdfToolMerge" "PDF 합치기" "--merge"
  !insertmacro PdfToolVerb ".hwp" "PdfToolHwp2Pdf" "PDF로 변환" "--hwp2pdf"
  !insertmacro PdfToolVerb ".hwp" "PdfToolHwpMerge" "PDF로 변환해서 합치기" "--hwpmerge"
  !insertmacro PdfToolVerb ".hwp" "PdfToolHwp2Hwpx" "HWPX로 변환" "--hwp2hwpx"
  !insertmacro PdfToolVerb ".hwpx" "PdfToolHwp2Pdf" "PDF로 변환" "--hwp2pdf"
  !insertmacro PdfToolVerb ".hwpx" "PdfToolHwpMerge" "PDF로 변환해서 합치기" "--hwpmerge"
  !insertmacro PdfToolRegisterShellMenu
!macroend

!macro customUnInstall
  !insertmacro PdfToolReleaseShellMenu
  ${ifNot} ${isUpdated}
    DeleteRegKey HKCU "${PDFTOOL_SFA}\.pdf\shell\PdfToolMerge"
    DeleteRegKey HKCU "${PDFTOOL_SFA}\.hwp\shell\PdfToolHwp2Pdf"
    DeleteRegKey HKCU "${PDFTOOL_SFA}\.hwp\shell\PdfToolHwpMerge"
    DeleteRegKey HKCU "${PDFTOOL_SFA}\.hwp\shell\PdfToolHwp2Hwpx"
    DeleteRegKey HKCU "${PDFTOOL_SFA}\.hwpx\shell\PdfToolHwp2Pdf"
    DeleteRegKey HKCU "${PDFTOOL_SFA}\.hwpx\shell\PdfToolHwpMerge"
    DeleteRegValue HKCU "Software\HNC\HwpAutomation\Modules" "PdfToolModule"
  ${endIf}
!macroend
