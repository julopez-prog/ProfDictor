<#
.SYNOPSIS
  Generates one-time access passphrases and moderator credentials for Profdictor,
  together with the SHA-256 hashes the registry stores.

.DESCRIPTION
  Passphrases are what you hand out. Only their SHA-256 hashes are ever stored,
  in the Worker's KV or in access-codes.js, so the file list cannot be scraped
  back into working codes.

  Outputs three things:
    - codes.txt        the passphrases to distribute (keep private)
    - seed.json        the payload to POST to the Worker's /admin/seed
    - a snippet you can paste into extension/access-codes.js for local admins

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\tools\New-ProfdictorHashes.ps1 -AccessCount 100 -ModeratorNames "jared","kim"

.EXAMPLE
  # Just hash one passphrase you already chose:
  powershell -ExecutionPolicy Bypass -File .\tools\New-ProfdictorHashes.ps1 -HashOnly "my secret mod phrase"
#>
[CmdletBinding()]
param(
    [int]$AccessCount = 50,
    [string[]]$ModeratorNames = @("moderator"),
    [string]$OutDir = "secrets",
    [string]$HashOnly
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Get-Sha256Hex {
    param([Parameter(Mandatory)][string]$Text)
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($Text)
        return -join ($sha.ComputeHash($bytes) | ForEach-Object { $_.ToString("x2") })
    }
    finally { $sha.Dispose() }
}

function New-Passphrase {
    # URL-safe, unambiguous alphabet: no O/0/I/l to avoid transcription errors.
    $alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789".ToCharArray()
    $bytes = [byte[]]::new(24)
    [System.Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
    $chars = foreach ($b in $bytes) { $alphabet[$b % $alphabet.Length] }
    return (-join $chars)
}

if ($HashOnly) {
    Write-Host ""
    Write-Host "passphrase : $HashOnly"
    Write-Host "sha256     : $(Get-Sha256Hex -Text $HashOnly)"
    Write-Host ""
    return
}

$root = Split-Path -Parent $PSScriptRoot
$target = Join-Path $root $OutDir
New-Item -ItemType Directory -Force -Path $target | Out-Null

$accessCodes = 1..$AccessCount | ForEach-Object { New-Passphrase }
$moderators = foreach ($name in $ModeratorNames) {
    $phrase = New-Passphrase
    [pscustomobject]@{ name = $name; code = $phrase; sha256 = (Get-Sha256Hex -Text $phrase) }
}

# Human-readable list of what to hand out.
$codesPath = Join-Path $target "codes.txt"
$lines = @("# Profdictor access passphrases - generated $(Get-Date -Format s)", "# Distribute one per user. Each burns globally on first use.", "")
$lines += $accessCodes
$lines += @("", "# Moderator credentials - type these into the SEMESTER field in the popup.", "")
$lines += ($moderators | ForEach-Object { "{0,-14} {1}" -f $_.name, $_.code })
Set-Content -Path $codesPath -Value $lines -Encoding UTF8

# Payload for the Worker: hashes only, never the passphrases.
$seed = [ordered]@{
    accessCodes = @($accessCodes | ForEach-Object { Get-Sha256Hex -Text $_ })
    admins      = @($moderators | ForEach-Object { [ordered]@{ name = $_.name; code = $_.sha256 } })
}
$seedPath = Join-Path $target "seed.json"
$seed | ConvertTo-Json -Depth 5 | Set-Content -Path $seedPath -Encoding UTF8

Write-Host ""
Write-Host "Generated $AccessCount access passphrase(s) and $($moderators.Count) moderator credential(s)."
Write-Host "  passphrases : $codesPath   (private - do not commit)"
Write-Host "  seed payload : $seedPath"
Write-Host ""
Write-Host "1) Upload the hashes to your Worker:"
Write-Host "     curl -X POST `"https://YOUR-WORKER.workers.dev/admin/seed`" -H `"content-type: application/json`" -H `"x-profdictor-key: YOUR_CLAIM_KEY`" --data `"@$seedPath`""
Write-Host ""
Write-Host "2) Or skip the Worker and paste these moderator hashes into extension/access-codes.js:"
Write-Host "     const PROFDICTOR_LOCAL_ADMIN_HASHES = ["
foreach ($m in $moderators) { Write-Host "       `"$($m.sha256)`", // $($m.name)" }
Write-Host "     ];"
Write-Host ""
