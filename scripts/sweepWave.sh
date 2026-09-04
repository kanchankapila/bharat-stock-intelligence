#!/usr/bin/env bash
# Serial sweep driver. Serial is required, not a limitation: pg_stat_user_tables is
# database-wide, so two jobs running at once make their writes inseparable and destroy the
# per-job attribution the sweep exists to produce.
# Usage: bash scripts/sweepWave.sh <lane> <timeout-min> <<< "queue job\nqueue job"
LANE="${1:-unassigned}"; TMIN="${2:-20}"; SWEEP="${3:-2026-09-05}"
while read -r q j; do
  [ -z "$q" ] && continue
  echo "─────────────────────────────────────────────────────────"
  npx tsx scripts/runJobSweep.ts --queue "$q" --job "$j" --lane "$LANE" \
      --sweep-id "$SWEEP" --timeout-ms $((TMIN*60000)) 2>&1 | tail -18
done
