#!/usr/bin/env bash
# Phase 9 Task 5 mutation driver. Detached: nohup bash run.sh > run.log 2>&1 &
# Applies 14 mutants (M01-M11, M13-M15) plus the M12 control to the LIVE local database one at a time (restoring each),
# running supabase/tests/rls_phase9_integrations.sql against each; writes
# results.txt beside this script. Resumable by arguments: bash run.sh M05 M06.
# The database must be freshly reset to the repo's migrations first.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
echo "$(date '+%F %T') START" >> "$HERE/progress.log"
python "$HERE/mutants.py" "$@"
rc=$?
echo "$(date '+%F %T') END exit=$rc" >> "$HERE/progress.log"
