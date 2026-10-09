#!/usr/bin/env bash
# ============================================================================
# THE ONE THING A SINGLE-SESSION psql SUITE CANNOT MEASURE (Task 6 fix round
# 1, review finding I2).
#
#   Two retention runs are started AT THE SAME TIME.
#
# As shipped, public.start_retention_run() took no lock and refused nothing
# when a run was already `running`: two calls produced two `running` rows. The
# per-run ceiling is per RUN, so N concurrent runs delete up to N x 500 audit
# rows per pass; the sanity ceiling is computed per run and each run is blind
# to the other's deletions; and audit_events.total_before / total_after --
# which exist so "the run log's arithmetic is checkable rather than trusted"
# -- are both wrong under concurrency. It is reachable in the product: the
# pg_cron tick, a direct POST /api/retention/run and the /super/health preview
# button are three independent callers.
#
# Since 20261004003000 a partial unique index admits ONE `running` row, and
# start_retention_run() records the loser as a `refused` run carrying
# `retention_run_in_progress` rather than raising. This drives it for real:
# two sessions, each opens a transaction, starts a run, holds it for two
# seconds and commits -- the erasure_concurrency_probe.sh shape.
#
# EXPECTED: exactly one `running`, exactly one `refused` with that reason, and
# never two `running` rows at any instant.
#
# Run by run-rls-tests.sh after the retention suite, and by hand:
#
#   bash supabase/tests/retention_concurrency_probe.sh
#
# It cleans up after itself and touches no other suite's fixtures. It REFUSES
# to start if a run is already `running`, because then it would be measuring
# somebody else's run and not the race.
# ============================================================================
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
CTR="supabase_db_$(grep -E '^project_id' "$ROOT/supabase/config.toml" | cut -d'"' -f2)"

psql_q() { MSYS_NO_PATHCONV=1 docker exec -i "$CTR" psql -U postgres -d postgres -Atq -c "$1"; }

ALREADY=$(psql_q "select count(*) from public.retention_runs where status = 'running'")
if [ "$ALREADY" != "0" ]; then
  echo "FAIL: $ALREADY retention run(s) already \`running\` -- this probe would be measuring those, not the race."
  exit 1
fi
BEFORE=$(psql_q "select coalesce(max(started_at), '-infinity'::timestamptz) from public.retention_runs")

race_one() {
  MSYS_NO_PATHCONV=1 docker exec -i "$CTR" psql -U postgres -d postgres -Atq <<'SQL' 2>&1 | tr '\n' ' '
begin;
select (r).status || '/' || coalesce((r).refused->>'*', '-') from (select public.start_retention_run(false) as r) t;
select pg_sleep(2);
commit;
SQL
}

DIR=$(mktemp -d)
race_one > "$DIR/a" &
PID_A=$!
race_one > "$DIR/b" &
PID_B=$!
wait $PID_A; wait $PID_B

echo "session A: $(cat "$DIR/a")"
echo "session B: $(cat "$DIR/b")"

RUNNING=$(psql_q "select count(*) from public.retention_runs where started_at > '$BEFORE' and status = 'running'")
REFUSED=$(psql_q "select count(*) from public.retention_runs where started_at > '$BEFORE' and status = 'refused' and refused->>'*' = 'retention_run_in_progress'")
TOTAL=$(psql_q "select count(*) from public.retention_runs where started_at > '$BEFORE'")
echo "after  | runs $TOTAL | running $RUNNING | refused(retention_run_in_progress) $REFUSED"

STATUS=0
if [ "$TOTAL" = "2" ] && [ "$RUNNING" = "1" ] && [ "$REFUSED" = "1" ]; then
  echo "PASS: two concurrent starts, one run -- the other was recorded as refused."
else
  echo "FAIL: two retention runs were allowed at once (want runs 2 / running 1 / refused 1) -- I2 is back."
  echo "  The per-run ceiling, the sanity ceiling and the before/after totals are all per RUN."
  STATUS=1
fi

# Housekeeping: both rows this probe made, and nothing else.
psql_q "delete from public.retention_runs where started_at > '$BEFORE'" >/dev/null
rm -rf "$DIR"
exit $STATUS
