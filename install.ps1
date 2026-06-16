# Partial Duplicate Checker — Windows installer.
#   ./install.ps1                      # auto-detect Stash plugins dir
#   ./install.ps1 -Target "C:\path\to\stash\plugins"
param([string]$Target = "")

$ErrorActionPreference = "Stop"
$PluginId = "partial_dup_checker"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Files = @("partial_dup_checker.yml", "manifest", "partialdup.py", "partialdup.js", "partialdup.css")

Write-Host "Running unit tests..." -ForegroundColor Cyan
& python -m unittest test_partialdup 2>&1 | Out-Host

if (-not $Target) {
    $candidates = @(
        "$env:USERPROFILE\.stash\plugins",
        "$env:LOCALAPPDATA\stash\plugins",
        "$env:APPDATA\stash\plugins"
    )
    $Target = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
}
if (-not $Target) {
    Write-Host "No Stash plugins dir found. Pass one: ./install.ps1 -Target <path>" -ForegroundColor Red
    exit 1
}

$Dest = Join-Path $Target $PluginId
New-Item -ItemType Directory -Path $Dest -Force | Out-Null
foreach ($f in $Files) {
    Copy-Item -Path (Join-Path $ScriptDir $f) -Destination (Join-Path $Dest $f) -Force
}
Write-Host "Installed to $Dest" -ForegroundColor Green
Write-Host "Next: Stash -> Settings -> Plugins -> Reload Plugins." -ForegroundColor Yellow
Write-Host "Ensure python deps are present: pip install requests pillow numpy" -ForegroundColor Yellow
