#!/usr/bin/env bash
# Weekly WildScope run for the tiles listed below. Cron (Mondays 03:17):
#   17 3 * * 1  /home/USER/wildlife-habitat-explorer/pipeline/weekly.sh >> /home/USER/wildscope-weekly.log 2>&1
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
source "${WILDSCOPE_VENV:-$HOME/wildscope-env}/bin/activate"
cd "$HERE"
echo "=== WildScope weekly run $(date -u +%FT%TZ) on $(hostname)"
for TILE in 32UMU; do              # add more tiles here, for example: 32ULU 30UWB
  python run.py run --tile "$TILE" --extent full --mode weekly --cell 50 --web || echo "tile $TILE failed"
done
