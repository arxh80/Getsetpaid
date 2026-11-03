#!/usr/bin/env bash
# ============================================================================
# THE ONE THING A SINGLE-SESSION psql SUITE CANNOT MEASURE (Task 9c fix round
# 2, re-review N1).
#
#   An Owner closes their workspace WHILE the superuser suspends / deletes it.
#
# As shipped, private.lifecycle_target() read the row unlocked and the Phase 7
# UPDATE matched on id only: the superuser's read saw 'active' (the Owner's
# close not yet committed), its UPDATE waited for the row lock, re-evaluated
# `where id = ...` on the committed owner_closed row and overwrote it -- the
# owner_closed discriminator lost, the item gone from /super/closures.
#
# Since 20261028000000 the read is FOR UPDATE and every lifecycle UPDATE
# re-checks the state it decided on. Either gate alone closes this race; CL9
# (the lock) and CL10 (the re-check) in rls_phase8_workspace_closure.sql pin
# each one structurally. This probe measures the race itself, and it insists
# the refusal is the LOCK's (owner_closed_is_decided_at_super_closures: the
# superuser's read waited and saw owner_closed). Measured 2026-10-05: with
# both gates reverted the race lands (suspended / deleted, one audit row);
# with only the lock reverted the re-check refuses (40001
# lifecycle_changed_concurrently) and this probe is still red on the hint.
#
# Shape (erasure_concurrency_probe.sh / retention_concurrency_probe.sh): the
# Owner opens a transaction, closes, holds it two seconds, commits; half a
# second in, the superuser calls suspend_organisation (round 1) or
# delete_organisation (round 2).
#
# EXPECTED: each round ends owner_closed, the superuser call is REFUSED with
# owner_closed_is_decided_at_super_closures, and no organisation.suspended
# / organisation.deleted audit row exists for the workspace.
#
# Run by run-rls-tests.sh, and by hand after a reset:
#   bash supabase/tests/lifecycle_concurrency_probe.sh
# It cleans up after itself and touches no other suite's fixtures.
# ============================================================================
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
CTR="supabase_db_$(grep -E '^project_id' "$ROOT/supabase/config.toml" | cut -d'"' -f2)"

psql_q() { MSYS_NO_PATHCONV=1 docker exec -i "$CTR" psql -U postgres -d postgres -Atq -c "$1"; }

OWNER=$(psql_q "select gen_random_uuid()")
SU=$(psql_q "select gen_random_uuid()")
psql_q "
insert into auth.users (id, instance_id, aud, role, email) values
  ('$OWNER', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'lc-race-owner-$OWNER@test.local'),
  ('$SU',    '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'lc-race-su-$SU@test.local');
insert into public.platform_admins (user_id) values ('$SU');
" >/dev/null
OWNER_C="{\"sub\":\"$OWNER\",\"role\":\"authenticated\",\"aal\":\"aal2\"}"
SU_C="{\"sub\":\"$SU\",\"role\":\"authenticated\",\"aal\":\"aal2\"}"

DIR=$(mktemp -d)
STATUS=0
ORGS=()

race_round() {
  local rpc="$1" audit_action="$2"
  local org slug
  org=$(psql_q "select gen_random_uuid()")
  slug="lc-race-${rpc%%_*}-${org:0:8}"
  ORGS+=("$org")
  psql_q "
insert into public.organisations (id, name, slug) values ('$org', 'Lifecycle Race', '$slug');
insert into public.organisation_memberships (organisation_id, user_id, role, status, joined_at)
  values ('$org', '$OWNER', 'owner', 'active', now());
" >/dev/null

  MSYS_NO_PATHCONV=1 docker exec -i "$CTR" psql -U postgres -d postgres -Atq > "$DIR/owner" 2>&1 <<SQL &
begin;
set local role authenticated;
set local request.jwt.claims = '$OWNER_C';
select 'closed:' || (public.close_my_workspace('$org', '$slug', 'race') is not null);
select pg_sleep(2);
commit;
SQL
  local p_owner=$!
  sleep 0.5
  MSYS_NO_PATHCONV=1 docker exec -i "$CTR" psql -U postgres -d postgres -Atq -v VERBOSITY=verbose > "$DIR/su" 2>&1 <<SQL &
\set VERBOSITY verbose
begin;
set local role authenticated;
set local request.jwt.claims = '$SU_C';
select 'superuser:' || public.$rpc('$slug', 'race');
commit;
SQL
  local p_su=$!
  wait $p_owner; wait $p_su

  local state audits
  state=$(psql_q "select lifecycle_state from public.organisations where id = '$org'")
  audits=$(psql_q "select count(*) from public.audit_events where organisation_id = '$org' and action = '$audit_action'")
  echo "round $rpc | owner: $(tr '\n' ' ' < "$DIR/owner")"
  echo "round $rpc | superuser: $(tr '\n' ' ' < "$DIR/su" | cut -c1-240)"
  echo "round $rpc | after: lifecycle_state=$state $audit_action rows=$audits"
  if [ "$state" != "owner_closed" ] || [ "$audits" != "0" ] \
     || ! grep -q 'closed:true' "$DIR/owner" \
     || ! grep -q 'owner_closed_is_decided_at_super_closures' "$DIR/su"; then
    echo "FAIL ($rpc): the superuser's transition overwrote owner_closed (or the race was not driven) -- N1 is back."
    STATUS=1
  else
    echo "PASS ($rpc): owner_closed survived and the superuser call was refused."
  fi
}

race_round suspend_organisation organisation.suspended
race_round delete_organisation  organisation.deleted

# Housekeeping. ORIGIN mode for the organisations (cascades jobs, members);
# replica for the users (their append-only audit rows reference them).
for org in "${ORGS[@]}"; do
  psql_q "delete from public.export_jobs where organisation_id = '$org';
          delete from public.organisations where id = '$org';" >/dev/null
done
psql_q "
delete from public.platform_admins where user_id = '$SU';
set session_replication_role = replica;
delete from public.audit_events where organisation_id in ($(printf "'%s'," "${ORGS[@]}" | sed 's/,$//'));
delete from auth.users where id in ('$OWNER', '$SU');
set session_replication_role = origin;
" >/dev/null
rm -rf "$DIR"
exit $STATUS
