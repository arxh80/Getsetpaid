#!/usr/bin/env bash
# ============================================================================
# THE ONE THING A SINGLE-SESSION psql SUITE CANNOT MEASURE (Task 5, C2).
#
#   Two co-Owners of one workspace erase their accounts AT THE SAME TIME.
#
# Before fix round 1 both passed the unlocked Q131 guard and both committed,
# leaving a live workspace with a record in it, zero members and zero owners --
# unmanageable, un-invitable, and un-purgeable (erase_organisation() refuses a
# live workspace). Reproduced by the reviewer with two psql sessions on a
# minute boundary; reproduced again here, mechanically, so it stays measured.
#
# It is NOT part of run-rls-tests.sh: it needs two concurrent sessions and it
# is the only test in the repository that does. Run it by hand after a reset:
#
#   bash supabase/tests/erasure_concurrency_probe.sh
#
# EXPECTED, since 20261001001000: one erasure succeeds, the other is REFUSED
# (22023 last_owner_of_workspace, or 55000 workspace_left_ownerless if it got
# past the lock), and the workspace still has an active owner.
# It cleans up after itself and touches no other suite's fixtures.
# ============================================================================
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
CTR="supabase_db_$(grep -E '^project_id' "$ROOT/supabase/config.toml" | cut -d'"' -f2)"

psql_q() { MSYS_NO_PATHCONV=1 docker exec -i "$CTR" psql -U postgres -d postgres -Atq -c "$1"; }

ORG=$(psql_q "select gen_random_uuid()")
A=$(psql_q "select gen_random_uuid()")
B=$(psql_q "select gen_random_uuid()")

psql_q "
insert into auth.users (id, instance_id, aud, role, email) values
  ('$A', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'race-a-$A@test.local'),
  ('$B', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'race-b-$B@test.local');
insert into public.organisations (id, name, slug)
  values ('$ORG', 'Erasure Race Ltd', 'erasure-race-${ORG:0:8}');
insert into public.organisation_memberships (organisation_id, user_id, role, status) values
  ('$ORG', '$A', 'owner', 'active'), ('$ORG', '$B', 'owner', 'active');
insert into public.contacts (organisation_id, name, email)
  values ('$ORG', 'Race Contact', 'race-${ORG:0:8}@erase.test');
" >/dev/null

echo "fixture: workspace with two co-owners and one contact"
echo "before | members $(psql_q "select count(*) from public.organisation_memberships where organisation_id = '$ORG'") | owners $(psql_q "select count(*) from public.organisation_memberships where organisation_id = '$ORG' and role='owner' and status='active'") | crm $(psql_q "select count(*) from public.contacts where organisation_id = '$ORG'")"

# BOTH SESSIONS OPEN A TRANSACTION, READ THE GUARD, AND ONLY THEN COMMIT --
# which is the shape of the race: a sleep between the read and the write is
# what two independent runners have for free.
race_one() {
  MSYS_NO_PATHCONV=1 docker exec -i "$CTR" psql -U postgres -d postgres -Atq <<SQL 2>&1 | tr '\n' ' '
\set ON_ERROR_STOP on
begin;
select private.erase_account('$1', null) is not null;
select pg_sleep(2);
commit;
SQL
}

race_one "$A" > /tmp/erasure_race_a.out &
PID_A=$!
race_one "$B" > /tmp/erasure_race_b.out &
PID_B=$!
wait $PID_A; wait $PID_B

echo "session A: $(cat /tmp/erasure_race_a.out)"
echo "session B: $(cat /tmp/erasure_race_b.out)"

MEMBERS=$(psql_q "select count(*) from public.organisation_memberships where organisation_id = '$ORG'")
OWNERS=$(psql_q "select count(*) from public.organisation_memberships where organisation_id = '$ORG' and role='owner' and status='active'")
CRM=$(psql_q "select count(*) from public.contacts where organisation_id = '$ORG'")
LIVE=$(psql_q "select count(*) from public.organisations where id = '$ORG' and deleted_at is null")
echo "after  | live_org $LIVE | members $MEMBERS | owners $OWNERS | crm $CRM"

STATUS=0
if [ "$LIVE" = "1" ] && [ "$OWNERS" = "0" ]; then
  echo "FAIL: a live workspace was left with no active owner -- C2 is back."
  STATUS=1
else
  echo "PASS: the workspace still has an active owner."
fi

# Housekeeping: whichever account survived, and the workspace.
psql_q "
delete from public.contacts where organisation_id = '$ORG';
delete from public.organisations where id = '$ORG';
delete from auth.users where id in ('$A', '$B');
" >/dev/null
rm -f /tmp/erasure_race_a.out /tmp/erasure_race_b.out
exit $STATUS
