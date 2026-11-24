# 윈도우 11 우클릭 첫 화면 메뉴(외부 위치 패키지) 등록 — 설치 프로그램(installer.nsh)과 앱(app/shellmenu.js)이 같이 쓴다.
#   1) 서명한 msix로 설치 (이 PC가 서명 인증서를 믿을 때)
#   2) 개발자 모드면 매니페스트를 바로 등록 (서명 불필요)
#   3) -Elevate: 관리자 권한 창(UAC)으로 인증서를 LocalMachine\TrustedPeople에 넣고 1)을 다시
# 끝 코드: 0 등록됨 / 2 설정에서 끔(건너뜀) / 3 관리자 권한 필요(또는 거절) / 4 그 밖의 실패
param(
  [Parameter(Mandatory = $true)][string]$InstallDir,
  [switch]$Elevate,      # 필요하면 관리자 권한 창을 띄운다
  [switch]$Force,        # 설정의 shellMenu:false 무시 (앱에서 사용자가 켤 때)
  [switch]$NoDevMode     # 시험용: 개발자 모드 등록을 건너뛴다
)
$ErrorActionPreference = 'Stop'
$res = Join-Path $InstallDir 'resources\shellmenu'
$msix = Join-Path $res 'PdfToolShellMenu.msix'
$manifest = Join-Path $res 'AppxManifest.xml'
$cer = Join-Path $res 'pdftool-shellmenu.cer'

if (-not $Force) {
  $s = Join-Path $env:APPDATA 'PDF 도구\settings.json'
  try { if ((Test-Path $s) -and ((Get-Content $s -Raw -Encoding UTF8 | ConvertFrom-Json).shellMenu -eq $false)) { exit 2 } } catch {}
}

$script:lastErr = ''
function Install-Signed {
  try { Add-AppxPackage -Path $msix -ExternalLocation $InstallDir -ForceUpdateFromAnyVersion -ErrorAction Stop; return $true }
  catch { $script:lastErr = $_.Exception.Message }
  # 개발자 모드로 등록한 것(서명 없음)이 있으면 서명 패키지로 못 바꾼다(0x80073CFB) → 지우고 한 번 더
  $old = Get-AppxPackage -Name 'j333333766.PdfToolShellMenu'
  if ($old -and $old.IsDevelopmentMode -and $script:lastErr -match '0x80073CFB') {
    try {
      Remove-AppxPackage -Package $old.PackageFullName -ErrorAction Stop
      Add-AppxPackage -Path $msix -ExternalLocation $InstallDir -ForceUpdateFromAnyVersion -ErrorAction Stop; return $true
    } catch { $script:lastErr = $_.Exception.Message }
  }
  return $false
}
function Test-CertTrusted {
  $t = (New-Object Security.Cryptography.X509Certificates.X509Certificate2 $cer).Thumbprint
  $st = New-Object Security.Cryptography.X509Certificates.X509Store 'TrustedPeople', 'LocalMachine'
  $st.Open('ReadOnly'); try { return [bool]($st.Certificates | Where-Object Thumbprint -eq $t) } finally { $st.Close() }
}

if (Install-Signed) { exit 0 }

$dev = (Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\AppModelUnlock' -ErrorAction SilentlyContinue).AllowDevelopmentWithoutDevLicense -eq 1
if ($dev -and -not $NoDevMode) {
  try { Add-AppxPackage -Register $manifest -ExternalLocation $InstallDir -ForceUpdateFromAnyVersion -ErrorAction Stop; exit 0 }
  catch { $script:lastErr = $_.Exception.Message }
}

if (Test-CertTrusted) { [Console]::Error.WriteLine($script:lastErr); exit 4 }   # 인증서는 믿는데도 실패
if (-not $Elevate) { exit 3 }

$cmd = "Import-Certificate -FilePath '$($cer -replace "'", "''")' -CertStoreLocation Cert:\LocalMachine\TrustedPeople | Out-Null"
$enc = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($cmd))
try { Start-Process powershell.exe -Verb RunAs -Wait -WindowStyle Hidden -ArgumentList '-NoProfile', '-EncodedCommand', $enc -ErrorAction Stop }
catch { exit 3 }   # 사용자가 '아니요'를 눌렀거나 관리자 계정이 아님
if (-not (Test-CertTrusted)) { exit 3 }
if (Install-Signed) { exit 0 }
[Console]::Error.WriteLine($script:lastErr)
exit 4
