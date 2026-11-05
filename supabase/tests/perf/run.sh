#!/usr/bin/env bash
# ============================================================================
# Phase 10 Task 16 (G29): seed list volume and assert every hot list plan.
#
#   npx supabase db reset --local
#   bash supabase/tests/perf/run.sh
#   npx supabase db reset --local     # the volume must not leak into other runs
#
# Local stack only. It refuses a database that already holds the perf
# tenants, and it never resets anything itself: a reset wipes whatever other
# work shares this stack, so that stays a visible step.
# ============================================================================
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
WORKDIR="$(cd "$HERE/../../.." && pwd)"
CTR="supabase_db_$(grep -E '^project_id' "$WORKDIR/supabase/config.toml" | cut -d'"' -f2)"

psql_in() {
  MSYS_NO_PATHCONV=1 docker exec "$CTR" psql -U postgres -d postgres -q "$@"
}

if [ "$(psql_in -Atc "select count(*) from public.organisations where slug in ('perf-volume','perf-network')")" != "0" ]; then
  echo "perf/run.sh: the perf tenants already exist. Reset first: npx supabase db reset --local" >&2
  exit 1
fi

for f in seed-volume.sql list-plans.sql; do
  docker cp "$HERE/$f" "$CTR:/tmp/$f" >/dev/null
done

echo "== seeding (50,000 rows per hot table, 20,000 profiles)"
psql_in -f /tmp/seed-volume.sql >/dev/null
echo "== explaining every hot list as the perf-volume member"
psql_in -f /tmp/list-plans.sql
echo "perf/run.sh: done. Reset now: npx supabase db reset --local"
