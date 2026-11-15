# Smoke test for a local Windows dev box (mirrors .github/workflows/windows.yml smoke step).
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File scripts\smoke-win.ps1
$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$env:BOT_TEAM_HOME = Join-Path $env:TEMP "bt-smoke"
$env:BOT_TEAM_HOST = "127.0.0.1"
$env:PORT = "4821"

Write-Host "== smoke: starting server.mjs (home=$env:BOT_TEAM_HOME, port=$env:PORT)"
$p = Start-Process node -ArgumentList "server.mjs" -PassThru -NoNewWindow
try {
  $ok = $false
  foreach ($i in 1..30) {
    Start-Sleep -Milliseconds 500
    try {
      $health = Invoke-RestMethod http://127.0.0.1:4821/api/health -TimeoutSec 3
      $ok = $true
      break
    } catch { }
  }
  if (-not $ok) { throw "server did not answer /api/health on 127.0.0.1:4821" }

  $setup = Invoke-RestMethod http://127.0.0.1:4821/api/setup/status
  $boot = Invoke-RestMethod http://127.0.0.1:4821/api/bootstrap

  if ($null -eq $health.cli -or -not $health.desktop) { throw "health failed" }
  if ($setup.platform -ne "win32") { throw "unexpected platform: $($setup.platform)" }
  if ($null -eq $boot) { throw "bootstrap failed" }

  Write-Host "== health.platform : $($health.platform)"
  Write-Host "== health.cli keys : $(($health.cli.PSObject.Properties.Name) -join ', ')"
  Write-Host "== setup.platform  : $($setup.platform)"
  Write-Host "== bootstrap bots  : $($boot.bots.Count)"
  Write-Host "SMOKE PASS"
} finally {
  Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
}
