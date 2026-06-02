# Deploy the EmberForge app(s) to Fly.io. Web + API now live on Vercel -- Fly
# only hosts the long-lived orchestrator + workers, all consolidated into the
# single "sleepytool" app as process groups (see infra/fly/sleepytool.fly.toml).
#
# Usage:
#   pwsh scripts/fly/deploy.ps1                          # deploy all apps + groups
#   pwsh scripts/fly/deploy.ps1 -App sleepytool          # one app (all its groups)
#   pwsh scripts/fly/deploy.ps1 -Group workers           # only the 4 worker groups
#   pwsh scripts/fly/deploy.ps1 -Group render            # only the render group
#   pwsh scripts/fly/deploy.ps1 -Group orchestrator      # only the orchestrator
#
# -Group targets Fly process groups within an app via `--process-groups`, since
# everything now lives in one app rather than separate per-role apps.

param(
  [string]$App = '',
  # Process group(s) to deploy. 'workers' expands to all four worker groups.
  # Accepts a comma list too, e.g. -Group 'labs,tts'. Empty = all groups.
  [string]$Group = ''
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

    if (-not $apps) {
        Write-Host "No apps matched filter" -ForegroundColor Red
        exit 1
    }

    # Resolve -Group into a Fly --process-groups value. 'workers' is a shorthand
    # for the four worker groups; everything else is passed through verbatim so
    # any group name (or comma list) in the fly.toml [processes] block works.
    $groups = ''
    switch ($Group) {
        ''        { $groups = '' }   # all groups
        'workers' { $groups = 'labs,tts,veo3,render' }
        default   { $groups = $Group }
    }

    foreach ($a in $apps) {
        Write-Host ""
        if ($groups) {
            Write-Host "======== $($a.Name)  [groups: $groups] ========" -ForegroundColor Cyan
        } else {
            Write-Host "======== $($a.Name) ========" -ForegroundColor Cyan
        }

        $deployArgs = @('deploy', '--app', $a.Name, '--config', $a.Toml, '--remote-only')
        if ($groups) { $deployArgs += @('--process-groups', $groups) }

        & fly @deployArgs | Out-Host
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
