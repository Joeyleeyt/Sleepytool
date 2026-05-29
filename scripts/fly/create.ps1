# Creates the six EmberForge Fly apps. Idempotent — `fly apps create` errors
# politely on apps that already exist.
#
# Usage:  pwsh scripts/fly/create.ps1
# Requires: flyctl installed and `fly auth login` done.

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Resolve-Path (Join-Path $here '..\..')

$apps = Get-Content (Join-Path $here 'apps.txt') |
    Where-Object { $_ -and -not $_.StartsWith('#') } |
    ForEach-Object {
        $parts = $_ -split '\s+', 2
        [PSCustomObject]@{ Name = $parts[0]; Toml = $parts[1] }
    }

foreach ($a in $apps) {
    Write-Host "→ fly apps create $($a.Name)" -ForegroundColor Cyan
    & fly apps create $a.Name --org personal 2>&1 | Out-Host
    if ($LASTEXITCODE -ne 0) {
        Write-Host "  (already exists — continuing)" -ForegroundColor Yellow
    }
}

Write-Host ""
Write-Host "Next: pwsh scripts/fly/secrets.ps1   then   pwsh scripts/fly/deploy.ps1" -ForegroundColor Green
