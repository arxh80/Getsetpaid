#!/usr/bin/env bash
# ============================================================================
# PHASE 8 TASK 8 -- RUN ONE MUTANT AGAINST THE SUITES, AND SAY WHAT WENT RED
#
#   bash supabase/tests/mutations/run-mutation.sh <mutant.sql> <out-dir> [phase]
#
# Phases, so each step can be driven on its own (a full pass is ~10 minutes)
# and a stalled step loses only itself:
#   prep     `supabase db reset --local`, then apply the mutant with
#            ON_ERROR_STOP (a mutant that does not apply is a harness failure,
#            never a green)
#   psql     the WHOLE psql + HTTP runner (supabase/tests/run-rls-tests.sh)
#   vitest   the integration files in $T8_INTEGRATION (default: the
#            permission matrix and the Phase 8 integration directories)
#   summary  <out-dir>/<name>.summary: every red psql assertion by label,
#            every red HTTP check, every pinned-total mismatch, every psql
#            ERROR line, every failed vitest test by name -- LAYER BY LAYER
#   all      (default) the four in order
#
# The mutants beside this script are generated from the LIVE definitions at
# 210 migrations (each is the latest pg_get_functiondef() with one change), so
# a later migration that rebuilds one of these functions makes its mutant
# stale: regenerate rather than reuse. 00-control.sql is the harness's own
# denominator and must come back green in every layer.
#
# LOCAL ONLY. It resets the database. It is the measuring instrument behind
# task-8-report.md's mutation table; nothing in CI runs it and it creates no
# migration. Run `npx supabase db reset --local` afterwards: the last mutant
# stays applied until you do.
# ============================================================================
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
CTR="supabase_db_$(grep -E '^project_id' "$ROOT/supabase/config.toml" | cut -d'"' -f2)"
mutant="$1"; out="$2"; phase="${3:-all}"
name="$(basename "$mutant" .sql)"
mkdir -p "$out"
q() { MSYS_NO_PATHCONV=1 docker exec "$CTR" psql -U postgres -d postgres -tAc "$1" | tr -d '[:space:]'; }
cd "$ROOT"

do_prep() {
  : > "$out/$name.log"
  npx supabase db reset --local >> "$out/$name.log" 2>&1 || { echo "RESET FAILED" > "$out/$name.summary"; exit 2; }
  q "select count(*) from supabase_migrations.schema_migrations" > "$out/$name.migrations.before"
  docker cp "$mutant" "$CTR:/tmp/mutant.sql" >/dev/null
  if ! MSYS_NO_PATHCONV=1 docker exec "$CTR" psql -U postgres -d postgres -v ON_ERROR_STOP=1 -q \
        -f /tmp/mutant.sql >> "$out/$name.log" 2>&1; then
    echo "MUTANT DID NOT APPLY -- harness failure, not a result" > "$out/$name.summary"; exit 3
  fi
}
do_psql() {
  bash supabase/tests/run-rls-tests.sh > "$out/$name.psql.log" 2>&1
  echo $? > "$out/$name.psql.exit"
}
do_vitest() {
  local files="${T8_INTEGRATION:-tests/integration/security/phase7-permission-matrix.test.ts tests/integration/legal tests/integration/export tests/integration/erasure tests/integration/retention tests/integration/admin tests/integration/security/crm-audit-no-content-leak-p3-6.test.ts}"
  # shellcheck disable=SC2086
  pnpm exec vitest run --project integration $files > "$out/$name.vitest.log" 2>&1
  echo $? > "$out/$name.vitest.exit"
}
do_summary() {
  local after; after=$(q "select count(*) from supabase_migrations.schema_migrations")
  strip() { sed 's/\x1b\[[0-9;]*m//g' "$1" 2>/dev/null; }
  {
    echo "mutant: $name"
    echo "migrations before/after: $(cat "$out/$name.migrations.before" 2>/dev/null)/$after"
    echo "runner exit: $(cat "$out/$name.psql.exit" 2>/dev/null)   vitest exit: $(cat "$out/$name.vitest.exit" 2>/dev/null)"
    echo "--- psql: red assertions, read from each suite's results table ---"
    # From the DATABASE, not the log: not every suite prints its result rows,
    # and a suite that aborted still has the rows it recorded before it died.
    for sch in invariants harness crm ev op fa fin nw leak imp lc ov rl fb ca c7 lg cs dsr xp er rt pm; do
      MSYS_NO_PATHCONV=1 docker exec "$CTR" psql -U postgres -d postgres -tA         -c "select '  [$sch] ' || label from $sch.results where not pass order by seq" 2>/dev/null
    done
    echo "--- psql: pinned-total mismatches and ERROR lines ---"
    strip "$out/$name.psql.log" | grep -aE 'RECORDED [0-9]+ ASSERTIONS|psql ERROR line' | sed 's/^/  /'
    echo "--- HTTP: red checks ---"
    strip "$out/$name.psql.log" | grep -aE '^  FAIL  ' | sed 's/^/  /'
    echo "--- integration: red tests ---"
    strip "$out/$name.vitest.log" | grep -aE '^ FAIL ' | sed 's/^ FAIL  *//' | sort -u
    strip "$out/$name.vitest.log" | grep -aE '^ +Tests +' | sed 's/^/  /'
  } > "$out/$name.summary"
  cat "$out/$name.summary"
}

case "$phase" in
  prep) do_prep ;;
  psql) do_psql ;;
  vitest) do_vitest ;;
  summary) do_summary ;;
  all) do_prep; do_psql; do_vitest; do_summary ;;
  *) echo "unknown phase $phase" >&2; exit 64 ;;
esac
