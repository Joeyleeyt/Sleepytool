#!/usr/bin/env bash
# Deploy the EmberForge worker app (sleepytool) to Fly.io. Workers run as two
# process groups (workers + render) inside one app; `fly deploy` ships them all
# at once. Web + API live on Vercel.
#
# Usage:  ./scripts/fly/deploy.sh
set -euo pipefail

cd "$(dirname "$0")/../.."

while IFS=$' \t' read -r name toml _; do
  [[ -z "$name" || "$name" == \#* ]] && continue
  echo ""
  echo "════════ $name ════════"
  fly deploy --app "$name" --config "$toml" --remote-only
done < scripts/fly/apps.txt

echo ""
echo "Deploy complete."
