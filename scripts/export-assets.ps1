Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$Root = Resolve-Path (Join-Path $PSScriptRoot "..")
$ChromeCandidates = @(
  "C:\Program Files\Google\Chrome\Application\chrome.exe",
  "C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
  "C:\Program Files\Microsoft\Edge\Application\msedge.exe",
  "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
)

$Browser = $ChromeCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $Browser) {
  throw "Chrome or Edge is required to export SVG assets to PNG."
}

$Items = @(
  @{ In = "docs\assets\generated\hero-bridge.svg"; Out = "docs\assets\generated\hero-bridge.png"; Size = "1600,900" },
  @{ In = "docs\assets\generated\architecture-flow.svg"; Out = "docs\assets\generated\architecture-flow.png"; Size = "1600,900" },
  @{ In = "docs\assets\screenshots\feishu-usage-redraw.svg"; Out = "docs\assets\screenshots\feishu-usage-redraw.png"; Size = "1400,780" },
  @{ In = "docs\assets\screenshots\feishu-menu-config-redraw.svg"; Out = "docs\assets\screenshots\feishu-menu-config-redraw.png"; Size = "1400,780" },
  @{ In = "docs\assets\screenshots\github-repo-redraw.svg"; Out = "docs\assets\screenshots\github-repo-redraw.png"; Size = "1400,780" }
)

foreach ($Item in $Items) {
  $InputPath = (Resolve-Path (Join-Path $Root $Item.In)).Path
  $OutputPath = Join-Path $Root $Item.Out
  $Uri = [Uri]::new($InputPath).AbsoluteUri

  & $Browser `
    --headless=new `
    --disable-gpu `
    --hide-scrollbars `
    --window-size=$($Item.Size) `
    --screenshot="$OutputPath" `
    "$Uri" | Out-String | Write-Verbose

  if (-not (Test-Path $OutputPath)) {
    throw "Failed to create $OutputPath"
  }

  Write-Host "Exported $OutputPath"
}
