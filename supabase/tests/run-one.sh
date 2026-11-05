#!/usr/bin/env bash
# ============================================================================
# Re-run ONE psql suite against the database a full run has already built.
#
#   bash supabase/tests/run-one.sh rls_phase8_exports.sql
#
# THIS IS A LOOP TOOL, NOT A GATE. The full runner is the gate, and
# docs/parallel-stacks.md § Tiered gates says plainly that no handback or
# review may rest on this script. It exists because a one-line fix to one .sql
# file should not cost a `db reset` plus nineteen suites.
#
# WHY IT NEEDS A PRIOR RUN. Every suite after rls_foundation.sql is handed a
# `-v` array of fixture user uuids and session-claim JSON that run-rls-tests.sh
# builds by creating real auth.users over the Auth admin API. Nothing can
# reconstruct those uuids afterwards, so the runner now writes each array to
# `.last-run-vars.sh` (gitignored) as it builds it, and this script replays it.
# The suites deliberately do not tear their fixtures down -- that is the same
# property the full runner's dirty-database preflight exists to police -- so
# after a completed run the rows those variables point at are all still there.
#
# WHAT IT DOES NOT DO, stated so nobody mistakes a green line here for a pass:
#   * it does not reset the database, so a suite that is not idempotent will
#     see its own previous rows (most of these are not idempotent: that is why
#     the full runner refuses to run twice);
#   * it does not run the HTTP sections of the full runner;
#   * it does not run the suites BEFORE the one named, so a change that breaks
#     an earlier suite's assumptions passes here and fails there.
# Re-run the full gate before claiming anything.
# ============================================================================
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"

SUITE="${1:-}"
if [ -z "$SUITE" ]; then
  echo "usage: bash supabase/tests/run-one.sh <suite.sql>" >&2
  echo "suites:" >&2
  (cd "$HERE" && ls *.sql | sed 's/^/  /') >&2
  exit 2
fi
SUITE="$(basename "$SUITE")"
if [ ! -f "$HERE/$SUITE" ]; then
  echo "No such suite: $SUITE" >&2
  exit 2
fi

# Same stack resolution as run-rls-tests.sh: $SUPABASE_WORKDIR, else this
# worktree's claimed slot, else the repo root's committed config.
WORKDIR="${SUPABASE_WORKDIR:-}"
if [ -z "$WORKDIR" ]; then
  if [ -f "$ROOT/.supabase-slot/supabase/config.toml" ]; then
    WORKDIR="$ROOT/.supabase-slot"
  else
    WORKDIR="$ROOT"
  fi
fi
CTR="supabase_db_$(grep -E '^project_id' "$WORKDIR/supabase/config.toml" | cut -d'"' -f2)"

VARS_DUMP="$HERE/.last-run-vars.sh"
if [ ! -s "$VARS_DUMP" ]; then
  echo "No fixture variables recorded yet ($VARS_DUMP)." >&2
  echo "  Run the full suite once first:" >&2
  echo "      npx supabase db reset && bash supabase/tests/run-rls-tests.sh" >&2
  echo "  It writes the variables this script replays." >&2
  exit 1
fi
# shellcheck disable=SC1090
. "$VARS_DUMP"

# rls_foundation.sql and schema_invariants.sql predate the twelve-user CRM
# fixture and take the smaller array; everything else takes the superset.
case "$SUITE" in
  rls_foundation.sql|schema_invariants.sql) VARS=( "${FOUNDATION_VARS[@]}" ) ;;
  *)                                        VARS=( "${SUITE_VARS[@]}" ) ;;
esac

docker cp "$HERE/$SUITE" "$CTR:/tmp/$SUITE"
MSYS_NO_PATHCONV=1 docker exec "$CTR" psql -U postgres -d postgres -q --pset=footer=off \
  "${VARS[@]}" -f "/tmp/$SUITE"

echo
echo "Ran $SUITE against $CTR. Read the assertion output above -- this script"
echo "does NOT tally failures the way run-rls-tests.sh does, because each suite"
echo "counts them out of its own schema's results table under its own name."
