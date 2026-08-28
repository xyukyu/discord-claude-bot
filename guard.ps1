# bot.js（Gateway 常駐プロセス）の死活監視。
#
# Gateway 版は落ちると返信が完全に止まる（ポーリング版と違って自然復旧しない）。
# このスクリプトを1分ごとに走らせ、生きていなければ起動し直す。
#
# 起動は wscript 経由でウィンドウを出さずに行う。
# bot.js 自身が再接続とバックオフを持っているので、ここが見るのは
# 「プロセスが存在するか」だけでよい。

$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

$LOG = Join-Path $PSScriptRoot 'bot.log'

function Write-Log($msg) {
    $ts = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
    Add-Content -Path $LOG -Value "[$ts] [guard] $msg" -Encoding utf8
}

# bot.js を実行している node プロセスを探す
$running = @(
    Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -match 'bot\.js' }
)

if ($running.Count -gt 0) {
    exit 0   # 生きている。大半はここで終わる
}

Write-Log 'bot.js が停止しているため起動します'

$env:DISCORD_TOKEN = [Environment]::GetEnvironmentVariable('DISCORD_TOKEN', 'User')
if ([string]::IsNullOrEmpty($env:DISCORD_TOKEN)) {
    Write-Log 'ERROR: DISCORD_TOKEN が未設定のため起動できません'
    exit 1
}

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { $node = 'C:\Program Files\nodejs\node.exe' }
if (-not (Test-Path $node)) {
    Write-Log 'ERROR: node が見つかりません'
    exit 1
}

# ウィンドウを出さずに起動し、このスクリプトは待たずに終了する。
# （待つと guard 自身が常駐してしまい、タスクの多重起動抑止に引っかかる）
Start-Process -FilePath $node `
    -ArgumentList 'bot.js' `
    -WorkingDirectory $PSScriptRoot `
    -WindowStyle Hidden

Start-Sleep -Seconds 3

$after = @(
    Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -match 'bot\.js' }
)

if ($after.Count -gt 0) {
    Write-Log "起動しました (PID $($after[0].ProcessId))"
    exit 0
}

Write-Log 'ERROR: 起動を試みましたが確認できませんでした'
exit 1
