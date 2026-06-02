# Creates the EmberForge Fly app(s) from apps.txt and the render volume.
# Idempotent -- `fly apps create` errors politely on apps that already exist,
# and the volume step is skipped when a render_work volume already exists.
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

$org = 'info-logovectorservice-nl'

# Render volume: the sleepytool fly.toml mounts `render_work` onto the `render`
# process group. The volume must exist BEFORE deploy or the render machine
# fails to start. One volume per render machine (we run a single render VM).
$volApp    = 'sleepytool'
$volName   = 'render_work'
$volRegion = 'iad'    # matches primary_region in infra/fly/sleepytool.fly.toml
$volSizeGb = 10

foreach ($a in $apps) {
    Write-Host "-> fly apps create $($a.Name) (org: $org)" -ForegroundColor Cyan
    # Capture combined output so we can tell "already exists" apart from real
    # failures (billing, quota, etc). ErrorActionPreference is dropped to
    # Continue locally so PS 5.1 doesn't turn fly's stderr into a terminating
    # NativeCommandError before we can inspect it.
    $prev = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    $out = (& fly apps create $a.Name --org $org 2>&1 | Out-String)
    $code = $LASTEXITCODE
    $ErrorActionPreference = $prev

    Write-Host $out.TrimEnd()
    if ($code -ne 0) {
        if ($out -match '(?i)already|taken|exists') {
            Write-Host "  (already exists -- continuing)" -ForegroundColor Yellow
        } else {
            Write-Host "  CREATE FAILED for $($a.Name) -- stopping." -ForegroundColor Red
            exit $code
        }
    }
}

# Ensure the render volume exists. `fly volumes create` is NOT idempotent (it
# would add a SECOND volume on every run), so list first and only create when
# absent. Drop ErrorActionPreference like above so PS 5.1 doesn't choke on
# fly's stderr before we can read the output.
Write-Host ""
Write-Host "-> ensuring volume '$volName' on $volApp ($volRegion)" -ForegroundColor Cyan
$prev = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
$vols = (& fly volumes list --app $volApp 2>&1 | Out-String)
$ErrorActionPreference = $prev

if ($vols -match "(?m)\b$([regex]::Escape($volName))\b") {
    Write-Host "  (volume already exists -- continuing)" -ForegroundColor Yellow
} else {
    & fly volumes create $volName --app $volApp --region $volRegion --size $volSizeGb --yes | Out-Host
    if ($LASTEXITCODE -ne 0) {
        Write-Host "  VOLUME CREATE FAILED for $volName -- stopping." -ForegroundColor Red
        exit $LASTEXITCODE
    }
}

Write-Host ""
Write-Host "Next: pwsh scripts/fly/secrets.ps1   then   pwsh scripts/fly/deploy.ps1" -ForegroundColor Green
