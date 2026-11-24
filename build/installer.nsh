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

; 설치 직후 첫 화면 메뉴 등록 (build/shellmenu/register.ps1 — 끝 코드 0 등록 / 2 설정에서 끔 / 3 관리자 권한 필요 / 4 실패)
;   개발자 모드가 아닌 PC는 서명 인증서를 처음 한 번 관리자 권한으로 등록해야 한다(1.7.1까지는 여기서 조용히 실패했음).
;   등록되면 탐색기를 다시 시작해야 메뉴가 보인다(켜져 있던 탐색기는 지웠다 다시 넣은 패키지를 모름).
!define PDFTOOL_REG `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\resources\shellmenu\register.ps1" -InstallDir "$INSTDIR"`
!macro PdfToolRegisterShellMenu
  nsExec::Exec `${PDFTOOL_REG}`
  Pop $0
  ${If} $0 == 3
  ${AndIfNot} ${Silent}
    MessageBox MB_YESNO|MB_ICONINFORMATION "파일 탐색기 오른쪽 클릭 '첫 화면'에 PDF 도구 메뉴를 보이려면$\r$\n처음 한 번 관리자 권한이 필요합니다(메뉴 서명 인증서 등록).$\r$\n$\r$\n지금 등록할까요? 다음에 뜨는 확인 창에서 '예'를 누르세요.$\r$\n$\r$\n(건너뛰어도 Shift+오른쪽 클릭, 또는 오른쪽 클릭 → '추가 옵션 표시'에서$\r$\n메뉴를 쓸 수 있고, 나중에 PDF 도구 → 설정에서 켤 수도 있습니다.)" IDNO pdftool_admin_skip
    nsExec::Exec `${PDFTOOL_REG} -Elevate`
    Pop $0
    pdftool_admin_skip:
  ${EndIf}
  ${IfNot} ${Silent}
    ${If} $0 == 0
      MessageBox MB_YESNO|MB_ICONQUESTION "오른쪽 클릭 첫 화면 메뉴를 등록했습니다.$\r$\n파일 탐색기를 다시 시작해야 메뉴가 보입니다. 지금 다시 시작할까요?$\r$\n(열려 있는 폴더 창은 닫힙니다. '아니요'를 고르면 다음에 로그인할 때부터 보입니다.)" IDNO pdftool_restart_skip
      nsExec::Exec `powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "Stop-Process -Name explorer -Force -ErrorAction SilentlyContinue; Start-Sleep -Seconds 3; if (-not (Get-Process explorer -ErrorAction SilentlyContinue)) { Start-Process explorer.exe }"`
      Pop $1
      pdftool_restart_skip:
    ${ElseIf} $0 != 2
      MessageBox MB_OK|MB_ICONINFORMATION "오른쪽 클릭 첫 화면 메뉴는 켜지 못했습니다.$\r$\n$\r$\nPDF 도구 메뉴는 Shift+오른쪽 클릭, 또는 오른쪽 클릭 → '추가 옵션 표시'에 있습니다.$\r$\n(관리자 계정이 있으면 PDF 도구 → 설정 → '관리자 권한으로 켜기'로 첫 화면에도 보이게 할 수 있습니다.)"
    ${EndIf}
  ${EndIf}
!macroend

!macro customInit
  !insertmacro PdfToolReleaseShellMenu
!macroend

!macro customInstall
  !insertmacro PdfToolVerb ".pdf" "PdfToolView" "PDF 도구로 보기" "--view"
  !insertmacro PdfToolVerb ".pdf" "PdfToolMerge" "PDF 합치기" "--merge"
  !insertmacro PdfToolVerb ".pdf" "PdfToolCompress" "PDF 용량 줄이기" "--compress"
  !insertmacro PdfToolVerb ".hwp" "PdfToolHwp2Pdf" "PDF로 변환" "--hwp2pdf"
  !insertmacro PdfToolVerb ".hwp" "PdfToolHwpMerge" "PDF로 변환해서 합치기" "--hwpmerge"
  !insertmacro PdfToolVerb ".hwp" "PdfToolHwp2Hwpx" "HWPX로 변환" "--hwp2hwpx"
  !insertmacro PdfToolVerb ".hwp" "PdfToolHwp2HwpxDel" "HWPX로 변환 (원본 삭제)" "--hwp2hwpx-del"
  !insertmacro PdfToolVerb ".hwpx" "PdfToolHwp2Pdf" "PDF로 변환" "--hwp2pdf"
  !insertmacro PdfToolVerb ".hwpx" "PdfToolHwpMerge" "PDF로 변환해서 합치기" "--hwpmerge"
  ; '연결 프로그램'·기본 앱 목록에 PDF 도구 (app/registry.js PROGID와 같음)
  WriteRegStr HKCU "Software\Classes\PdfTool.PDF" "" "PDF 문서 (PDF 도구)"
  WriteRegStr HKCU "Software\Classes\PdfTool.PDF\DefaultIcon" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}",0'
  WriteRegStr HKCU "Software\Classes\PdfTool.PDF\shell\open" "FriendlyAppName" "PDF 도구"
  WriteRegStr HKCU "Software\Classes\PdfTool.PDF\shell\open\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --view "%1"'
  WriteRegNone HKCU "Software\Classes\.pdf\OpenWithProgids" "PdfTool.PDF"
  !insertmacro PdfToolRegisterShellMenu
!macroend

!macro customUnInstall
  !insertmacro PdfToolReleaseShellMenu
  ${ifNot} ${isUpdated}
    DeleteRegKey HKCU "${PDFTOOL_SFA}\.pdf\shell\PdfToolView"
    DeleteRegKey HKCU "${PDFTOOL_SFA}\.pdf\shell\PdfToolMerge"
    DeleteRegKey HKCU "${PDFTOOL_SFA}\.pdf\shell\PdfToolCompress"
    DeleteRegKey HKCU "${PDFTOOL_SFA}\.hwp\shell\PdfToolHwp2Pdf"
    DeleteRegKey HKCU "${PDFTOOL_SFA}\.hwp\shell\PdfToolHwpMerge"
    DeleteRegKey HKCU "${PDFTOOL_SFA}\.hwp\shell\PdfToolHwp2Hwpx"
    DeleteRegKey HKCU "${PDFTOOL_SFA}\.hwp\shell\PdfToolHwp2HwpxDel"
    DeleteRegKey HKCU "${PDFTOOL_SFA}\.hwpx\shell\PdfToolHwp2Pdf"
    DeleteRegKey HKCU "${PDFTOOL_SFA}\.hwpx\shell\PdfToolHwpMerge"
    DeleteRegValue HKCU "Software\Classes\.pdf\OpenWithProgids" "PdfTool.PDF"
    DeleteRegKey HKCU "Software\Classes\PdfTool.PDF"
    DeleteRegValue HKCU "Software\HNC\HwpAutomation\Modules" "PdfToolModule"
  ${endIf}
!macroend
