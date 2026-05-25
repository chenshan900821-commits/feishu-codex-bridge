Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$Root = Resolve-Path (Join-Path $PSScriptRoot "..")
$PidFile = Join-Path $Root "bridge.pid"

if (Test-Path $PidFile) {
  $BridgePid = [int](Get-Content -Raw $PidFile)
  $Process = Get-Process -Id $BridgePid -ErrorAction SilentlyContinue
  if ($Process) {
    Stop-Process -Id $BridgePid -Force
    Write-Host "Stopped bridge PID=$BridgePid"
  } else {
    Write-Host "No running process for PID=$BridgePid"
  }
  Remove-Item -LiteralPath $PidFile -Force
  exit 0
}

$Processes = Get-CimInstance Win32_Process |
  Where-Object { $_.Name -eq "node.exe" -and $_.CommandLine -like "*src/index.js*" }

foreach ($Process in $Processes) {
  Stop-Process -Id $Process.ProcessId -Force
  Write-Host "Stopped bridge PID=$($Process.ProcessId)"
}

if (-not $Processes) {
  Write-Host "No bridge process found."
}
