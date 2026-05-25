Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$Root = Resolve-Path (Join-Path $PSScriptRoot "..")
Set-Location $Root

npm install

if (-not (Test-Path ".env")) {
  Copy-Item ".env.example" ".env"
  Write-Host "Created .env from .env.example. Fill FEISHU_APP_ID, FEISHU_APP_SECRET, CODEX_ROOT, then run npm run doctor."
} else {
  Write-Host ".env already exists; leaving it unchanged."
}

npm run check
