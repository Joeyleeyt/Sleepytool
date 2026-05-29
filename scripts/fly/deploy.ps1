# Deploy one or all EmberForge apps to Fly.io.
#
# Usage:
#   pwsh scripts/fly/deploy.ps1                            # deploy all
#   pwsh scripts/fly/deploy.ps1 -App emberforge-api        # deploy one
#   pwsh scripts/fly/deploy.ps1 -Only workers              # api+orchestrator skipped
#   pwsh scripts/fly/deploy.ps1 -Only render               # render-worker only

param(
  [string]$App = '',
  [string]$Only = ''   # 'workers' | 'render' | 'api' | 'orchestrator'
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Resolve-Path (Join-Path $here '..\..')

Push-Location $root
try {
    $apps = Get-Content (Join-Path $here 'apps.txt') |
        Where-Object { $_ -and -not $_.StartsWith('#') } |
        ForEach-Object {
            $parts = $_ -split '\s+', 2
            [PSCustomObject]@{ Name = $parts[0]; Toml = $parts[1] }
        }

    if ($App)  { $apps = $apps | Where-Object { $_.Name -eq $App } }
    switch ($Only) {
        'workers'      { $apps = $apps | Where-Object { $_.Name -like '*-worker' } }
        'render'       { $apps = $apps | Where-Object { $_.Name -eq 'emberforge-render-worker' } }
        'api'          { $apps = $apps | Where-Object { $_.Name -eq 'emberforge-api' } }
        'orchestrator' { $apps = $apps | Where-Object { $_.Name -eq 'emberforge-orchestrator' } }
    }

    if (-not $apps) {
        Write-Host "No apps matched filter" -ForegroundColor Red
        exit 1
    }

    foreach ($a in $apps) {
        Write-Host ""
        Write-Host "════════ $($a.Name) ════════" -ForegroundColor Cyan
        & fly deploy --app $a.Name --config $a.Toml --remote-only | Out-Host
        if ($LASTEXITCODE -ne 0) {
            Write-Host "deploy failed for $($a.Name)" -ForegroundColor Red
            exit $LASTEXITCODE
        }
    }
}
finally {
    Pop-Location
}

Write-Host ""
Write-Host "All deploys complete." -ForegroundColor Green
