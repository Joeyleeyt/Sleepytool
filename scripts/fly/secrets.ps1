# Push secrets from .env into the EmberForge Fly app (sleepytool).
# Reads .env at repo root, skips comments + blank lines, and sets each KEY=VALUE
# as a Fly secret on every app listed in scripts/fly/apps.txt. Secrets apply to
# all of an app's process groups.
#
# Skips local-only vars (PORT, DATABASE_URL pointing to localhost, etc).
#
# Usage:  pwsh scripts/fly/secrets.ps1
#         pwsh scripts/fly/secrets.ps1 -App sleepytool  # one app only

param(
  [string]$App = ''
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Resolve-Path (Join-Path $here '..\..')
$envFile = Join-Path $root '.env'

if (-not (Test-Path $envFile)) {
    Write-Host ".env not found at $envFile" -ForegroundColor Red
    exit 1
}

# Vars we do NOT want pushed to Fly (local-only or insensitive)
$skip = @(
    'PORT', 'LOG_LEVEL', 'NODE_ENV',
    'FFMPEG_PATH', 'FFPROBE_PATH',           # Fly image has its own ffmpeg
    'RENDER_WORK_DIR',                       # set in sleepytool.fly.toml (render)
    'NVENC_ENABLED',                         # set in sleepytool.fly.toml
    'FX_LIBRARY_DIR'                         # path is image-local
)

$secrets = @{}
foreach ($line in Get-Content $envFile) {
    $t = $line.Trim()
    if (-not $t -or $t.StartsWith('#')) { continue }
    $eq = $t.IndexOf('=')
    if ($eq -lt 1) { continue }
    $key = $t.Substring(0, $eq).Trim()
    $val = $t.Substring($eq + 1).Trim().Trim('"').Trim("'")
    if ($skip -contains $key) { continue }
    if (-not $val) { continue }
    # Skip localhost DB / Redis URLs — Fly apps need a public DB
    if (($key -eq 'DATABASE_URL' -or $key -eq 'REDIS_URL') -and ($val -like '*localhost*' -or $val -like '*127.0.0.1*')) {
        Write-Host "Skipping $key — points at localhost (set a Supabase/Upstash URL for Fly)" -ForegroundColor Yellow
        continue
    }
    $secrets[$key] = $val
}

if ($secrets.Count -eq 0) {
    Write-Host "No usable secrets in .env" -ForegroundColor Red
    exit 1
}

$apps = Get-Content (Join-Path $here 'apps.txt') |
    Where-Object { $_ -and -not $_.StartsWith('#') } |
    ForEach-Object { ($_ -split '\s+', 2)[0] }

if ($App) { $apps = @($App) }

foreach ($a in $apps) {
    Write-Host "→ fly secrets set on $a" -ForegroundColor Cyan
    $args = @('secrets', 'set', '--app', $a, '--stage')
    foreach ($k in $secrets.Keys) {
        $args += "$k=$($secrets[$k])"
    }
    & fly @args | Out-Host
}

Write-Host ""
Write-Host "Secrets staged. They apply on next deploy." -ForegroundColor Green
