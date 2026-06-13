# Deploy the EmberForge worker app (sleepytool) to Fly.io. The orchestrator +
# 69labs/veo3 workers run as the `workers` process group and ffmpeg as the
# `render` group - both inside this one app (infra/fly/sleepytool.fly.toml).
# `fly deploy` ships the whole app (all process groups) at once. Web + API
# live on Vercel.
#
# Usage:  pwsh scripts/fly/deploy.ps1

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

    foreach ($a in $apps) {
        Write-Host ""
        Write-Host "======== $($a.Name) ========" -ForegroundColor Cyan
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
Write-Host "Deploy complete." -ForegroundColor Green
