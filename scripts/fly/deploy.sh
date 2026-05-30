#!/usr/bin/env bash
# Deploy one or all EmberForge apps to Fly.io. Web + API live on Vercel —
# Fly only hosts the long-lived orchestrator + workers.
#
# Usage:
#   ./scripts/fly/deploy.sh                          # all
#   ./scripts/fly/deploy.sh emberforge-orchestrator  # one
set -euo pipefail

cd "$(dirname "$0")/../.."
APP="${1:-}"

while IFS=$' \t' read -r name toml _; do
  [[ -z "$name" || "$name" == \#* ]] && continue
  [[ -n "$APP" && "$name" != "$APP" ]] && continue
  echo ""
  echo "════════ $name ════════"
  fly deploy --app "$name" --config "$toml" --remote-only
done < scripts/fly/apps.txt

echo ""
echo "All deploys complete."
