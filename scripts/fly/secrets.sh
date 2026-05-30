#!/usr/bin/env bash
# Push .env secrets to every Fly app (skipping local-only vars).
# Web + API now live on Vercel — set its env vars in the Vercel dashboard.
#
# Usage:  ./scripts/fly/secrets.sh
#         ./scripts/fly/secrets.sh emberforge-orchestrator    # one app
set -euo pipefail

cd "$(dirname "$0")/../.."
APP="${1:-}"

[[ -f .env ]] || { echo ".env not found"; exit 1; }

SKIP_KEYS=( PORT LOG_LEVEL NODE_ENV FFMPEG_PATH FFPROBE_PATH RENDER_WORK_DIR NVENC_ENABLED FX_LIBRARY_DIR )
is_skipped() { local k="$1"; for s in "${SKIP_KEYS[@]}"; do [[ "$s" == "$k" ]] && return 0; done; return 1; }

declare -a kv=()
while IFS= read -r line; do
  line="${line%%$'\r'}"
  [[ -z "${line// }" || "$line" =~ ^# ]] && continue
  key="${line%%=*}"; val="${line#*=}"
  key="$(echo "$key" | xargs)"; val="${val#\"}"; val="${val%\"}"; val="${val#\'}"; val="${val%\'}"
  [[ -z "$val" ]] && continue
  is_skipped "$key" && continue
  if [[ ( "$key" == "DATABASE_URL" || "$key" == "REDIS_URL" ) && ( "$val" == *localhost* || "$val" == *127.0.0.1* ) ]]; then
    echo "Skipping $key — points at localhost"
    continue
  fi
  kv+=( "$key=$val" )
done < .env

[[ ${#kv[@]} -gt 0 ]] || { echo "No secrets to push"; exit 1; }

while IFS=$' \t' read -r name toml _; do
  [[ -z "$name" || "$name" == \#* ]] && continue
  [[ -n "$APP" && "$name" != "$APP" ]] && continue
  echo "→ fly secrets set on $name"
  fly secrets set --app "$name" --stage "${kv[@]}"
done < scripts/fly/apps.txt

echo "Secrets staged. Run scripts/fly/deploy.sh to apply."
