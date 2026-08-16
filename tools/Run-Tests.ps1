<#
.SYNOPSIS
  Runs all Profdictor self-tests and syntax checks.

.DESCRIPTION
  Needs a Node binary. If `node` is not on PATH the script looks in the usual
  install locations, and falls back to the Node runtime that ships with Adobe
  Creative Cloud, which is enough to run these tests.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\tools\Run-Tests.ps1
#>
[CmdletBinding()]
param([string]$NodePath)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Push-Location $root

function Resolve-Node {
    param([string]$Explicit)
    if ($Explicit) {
        if (Test-Path $Explicit) { return $Explicit }
        throw "No Node binary at $Explicit"
    }
    $cmd = Get-Command node -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    $candidates = @(
        "$env:ProgramFiles\nodejs\node.exe",
        "${env:ProgramFiles(x86)}\nodejs\node.exe",
        "$env:LOCALAPPDATA\Programs\nodejs\node.exe",
        "$env:ProgramFiles\Adobe\Adobe Creative Cloud Experience\libs\node.exe"
    )
    foreach ($c in $candidates) { if (Test-Path $c) { return $c } }
    throw "Node not found. Install Node.js, or pass -NodePath 'C:\path\to\node.exe'."
}

try {
    $node = Resolve-Node -Explicit $NodePath
    Write-Host "Using Node: $node"
    Write-Host "Version   : $(& $node --version)"
    Write-Host ""

    $failed = 0

    Write-Host "--- syntax check ---" -ForegroundColor Cyan
    foreach ($f in (Get-ChildItem -Recurse -Filter *.js extension)) {
        & $node --check $f.FullName 2>&1 | Out-Null
        if ($LASTEXITCODE -ne 0) {
            Write-Host ("  FAIL  " + $f.Name) -ForegroundColor Red
            & $node --check $f.FullName
            $failed++
        }
    }
    $tmpWorker = Join-Path $env:TEMP "pd-worker-check.mjs"
    Copy-Item "worker\worker.js" $tmpWorker -Force
    & $node --check $tmpWorker 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) { Write-Host "  FAIL  worker/worker.js" -ForegroundColor Red; $failed++ }
    Remove-Item $tmpWorker -Force -ErrorAction SilentlyContinue

    try { Get-Content "extension\manifest.json" -Raw | ConvertFrom-Json | Out-Null }
    catch { Write-Host "  FAIL  manifest.json is not valid JSON" -ForegroundColor Red; $failed++ }

    if ($failed -eq 0) { Write-Host "  all files parse cleanly" -ForegroundColor Green }
    Write-Host ""

    foreach ($suite in @("selftest.mjs", "selftest-scanner.mjs", "selftest-bridge.mjs", "selftest-integration.mjs")) {
        Write-Host "--- $suite ---" -ForegroundColor Cyan
        & $node (Join-Path "tools" $suite)
        if ($LASTEXITCODE -ne 0) { $failed++ }
        Write-Host ""
    }

    if ($failed -gt 0) {
        Write-Host "$failed suite(s)/file(s) failed." -ForegroundColor Red
        exit 1
    }
    Write-Host "Everything passed." -ForegroundColor Green
}
finally {
    Pop-Location
}
