Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$Root = Resolve-Path (Join-Path $PSScriptRoot "..")
$Out = Join-Path $Root "bridge.out.log"
$Err = Join-Path $Root "bridge.err.log"
$PidFile = Join-Path $Root "bridge.pid"

$Process = Start-Process `
  -FilePath "node.exe" `
  -ArgumentList @("src/index.js") `
  -WorkingDirectory $Root `
  -RedirectStandardOutput $Out `
  -RedirectStandardError $Err `
  -WindowStyle Hidden `
  -PassThru

Set-Content -Path $PidFile -Value $Process.Id -Encoding ASCII
Write-Host "Bridge started. PID=$($Process.Id)"
Write-Host "Logs: $Out"
