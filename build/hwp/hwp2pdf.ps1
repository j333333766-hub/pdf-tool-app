# 한글(HWP/HWPX) → PDF·HWPX 변환 작업자. PDF 도구(app/hwp.js)가 띄운다.
#   작업 파일(UTF-16): 1줄 = 보안 모듈 DLL 경로, 2줄 = 저장 형식(PDF|HWPX), 3줄부터 = "원본<TAB>저장할 파일"
#   표준 출력(UTF-8) 한 줄씩: "hwppid|PID" / "번호|run|" / "번호|ok|저장경로" / "번호|err|사유" / "done|"
param([string]$JobPath)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8

function Say([string]$s) { [Console]::Out.WriteLine($s); [Console]::Out.Flush() }

$lines = @(Get-Content -LiteralPath $JobPath -Encoding Unicode)
$dll = $lines[0]
$saveFmt = $lines[1]
$jobs = @($lines[2..($lines.Count - 1)] | Where-Object { $_.Trim() -ne '' })
$cancel = $JobPath + '.cancel'

# 한글 '파일 접근 승인' 대화상자를 끄는 한컴 보안 모듈 — 다른 프로그램과 겹치지 않게 이름을 따로 쓴다
try {
    if (Test-Path -LiteralPath $dll) {
        $key = 'HKCU:\Software\HNC\HwpAutomation\Modules'
        if (-not (Test-Path $key)) { $null = New-Item -Path $key -Force }
        Set-ItemProperty -Path $key -Name 'PdfToolModule' -Value $dll
    }
} catch { }

$hwp = $null
$owned = $true
function Get-Hwp {
    if ($script:hwp) { return $script:hwp }
    $before = @(Get-Process -Name Hwp -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id)
    try { $h = New-Object -ComObject HWPFrame.HwpObject }
    catch { throw '한글 프로그램을 실행할 수 없습니다 (한글이 설치되어 있는지 확인하세요)' }
    $new = @(Get-Process -Name Hwp -ErrorAction SilentlyContinue | Where-Object { $before -notcontains $_.Id } | Select-Object -ExpandProperty Id)
    # 이미 떠 있던 한글에 붙었으면 끝날 때 닫지 않는다
    $script:owned = ($new.Count -gt 0)
    foreach ($p in $new) { Say ('hwppid|' + $p) }
    $null = $h.RegisterModule('FilePathCheckDLL', 'PdfToolModule')
    $script:hwp = $h
    return $h
}

for ($i = 0; $i -lt $jobs.Count; $i++) {
    if (Test-Path -LiteralPath $cancel) { break }
    $src, $dest = $jobs[$i] -split "`t", 2
    Say ('' + $i + '|run|')
    try {
        if (-not (Test-Path -LiteralPath $src)) { throw '원본 파일을 찾을 수 없습니다' }
        $h = Get-Hwp
        if ($src.ToLower().EndsWith('.hwpx')) { $fmt = 'HWPX' } else { $fmt = 'HWP' }
        $ok = $h.Open($src, '', 'forceopen:true')
        if (-not $ok) { $ok = $h.Open($src, $fmt, 'forceopen:true') }
        if (-not $ok) { throw '파일을 열 수 없습니다 (손상되었거나 암호가 걸린 문서)' }
        try { $saved = $h.SaveAs($dest, $saveFmt, '') }
        finally { try { $null = $h.XHwpDocuments.Close($true) } catch { } }
        if (-not $saved -or -not (Test-Path -LiteralPath $dest)) { throw '저장에 실패했습니다' }
        $b = New-Object byte[] 4
        $fs = [IO.File]::OpenRead($dest)
        try { $null = $fs.Read($b, 0, 4) } finally { $fs.Close() }
        if ($saveFmt -eq 'HWPX') { $magic = 'PK' + [char]3 + [char]4 } else { $magic = '%PDF' }
        if ([Text.Encoding]::ASCII.GetString($b) -ne $magic) {
            Remove-Item -LiteralPath $dest -Force -ErrorAction SilentlyContinue
            throw '만들어진 파일이 올바르지 않습니다'
        }
        Say ('' + $i + '|ok|' + $dest)
    } catch {
        Say ('' + $i + '|err|' + ($_.Exception.Message -replace '[\r\n\|]', ' '))
        # 한글을 띄우지 못한 경우는 남은 파일도 마찬가지
        if (-not $script:hwp) {
            for ($k = $i + 1; $k -lt $jobs.Count; $k++) { Say ('' + $k + '|err|' + ($_.Exception.Message -replace '[\r\n\|]', ' ')) }
            break
        }
    }
}

if ($script:hwp) {
    if ($script:owned) { try { $script:hwp.Quit() } catch { } }
    try { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($script:hwp) } catch { }
}
Say 'done|'
