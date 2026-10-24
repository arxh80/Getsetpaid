#!/usr/bin/env bash
# ============================================================================
# TWO DRAFTS IN ONE WORKSPACE ISSUED AT ONCE (Invoices part 1, Task 5; spec
# § Lifecycle: "Two concurrent issues get two consecutive numbers").
#
# A single-session suite cannot measure this: an unlocked read of
# next_number passes every assertion in rls_invoices.sql § IS and still lets
# two concurrent sessions take the same number. Session one issues draft 1
# and holds its transaction for two seconds; half a second in, session two
# issues draft 2. EXPECTED: PRB-0001 and PRB-0002, next_number 3, and session
# two's call returned PRB-0002 (it waited on the settings row lock).
#
# Run by run-rls-tests.sh, and by hand after a reset:
#   bash supabase/tests/invoice_issue_concurrency_probe.sh
# It cleans up after itself.
# ============================================================================
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
CTR="supabase_db_$(grep -E '^project_id' "$ROOT/supabase/config.toml" | cut -d'"' -f2)"

psql_q() { MSYS_NO_PATHCONV=1 docker exec -i "$CTR" psql -U postgres -d postgres -Atq -c "$1"; }

FIN=$(psql_q "select gen_random_uuid()")
ORG=$(psql_q "select gen_random_uuid()")
CON=$(psql_q "select gen_random_uuid()")
D1=$(psql_q "select gen_random_uuid()")
D2=$(psql_q "select gen_random_uuid()")
FIN_C="{\"sub\":\"$FIN\",\"role\":\"authenticated\",\"aal\":\"aal2\"}"

psql_q "
insert into auth.users (id, instance_id, aud, role, email)
  values ('$FIN', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'inv-race-$FIN@test.local');
insert into public.organisations (id, name, slug) values ('$ORG', 'Invoice Race', 'inv-race-${ORG:0:8}');
insert into public.organisation_subscriptions (organisation_id, plan_id, billing_cycle, seat_count, status, current_period_end)
  values ('$ORG', 'pro', 'monthly', 1, 'active', now() + interval '30 days')
  on conflict (organisation_id) do update set plan_id = 'pro', status = 'active';
insert into public.organisation_memberships (organisation_id, user_id, role, status, joined_at)
  values ('$ORG', '$FIN', 'finance', 'active', now());
insert into public.contacts (id, organisation_id, name) values ('$CON', '$ORG', 'Race Customer');
insert into public.invoice_settings (organisation_id, business_name, business_address, number_prefix)
  values ('$ORG', 'Race Ltd', '1 Race Street', 'PRB-');
insert into public.invoices (id, organisation_id, recipient_contact_id, recipient_address, created_by)
  values ('$D1', '$ORG', '$CON', '2 Race Road', '$FIN'), ('$D2', '$ORG', '$CON', '2 Race Road', '$FIN');
insert into public.invoice_lines (organisation_id, invoice_id, position, description, quantity, unit_price_minor, vat_rate, net_minor, vat_minor)
  values ('$ORG', '$D1', 1, 'One', 1, 100, 'none', 100, 0), ('$ORG', '$D2', 1, 'Two', 1, 200, 'none', 200, 0);
" >/dev/null

DIR=$(mktemp -d)
MSYS_NO_PATHCONV=1 docker exec -i "$CTR" psql -U postgres -d postgres -Atq > "$DIR/one" 2>&1 <<SQL &
begin;
set local role authenticated;
set local request.jwt.claims = '$FIN_C';
select 'issued:' || public.issue_invoice('$D1');
select pg_sleep(2);
commit;
SQL
P1=$!
sleep 0.5
MSYS_NO_PATHCONV=1 docker exec -i "$CTR" psql -U postgres -d postgres -Atq > "$DIR/two" 2>&1 <<SQL &
begin;
set local role authenticated;
set local request.jwt.claims = '$FIN_C';
select 'issued:' || public.issue_invoice('$D2');
commit;
SQL
P2=$!
wait $P1; wait $P2

NUMBERS=$(psql_q "select string_agg(number, ',' order by number) from public.invoices where organisation_id = '$ORG'")
NEXT=$(psql_q "select next_number from public.invoice_settings where organisation_id = '$ORG'")
echo "session one: $(tr '\n' ' ' < "$DIR/one")"
echo "session two: $(tr '\n' ' ' < "$DIR/two")"
echo "after: numbers=$NUMBERS next_number=$NEXT"
STATUS=0
if [ "$NUMBERS" != "PRB-0001,PRB-0002" ] || [ "$NEXT" != "3" ] \
   || ! grep -q 'issued:PRB-0001' "$DIR/one" || ! grep -q 'issued:PRB-0002' "$DIR/two"; then
  echo "FAIL: concurrent issues did not get two consecutive numbers -- the settings row lock is gone."
  STATUS=1
else
  echo "PASS: two concurrent issues took PRB-0001 and PRB-0002, in order, with no gap."
fi

psql_q "delete from public.organisations where id = '$ORG';" >/dev/null
psql_q "
set session_replication_role = replica;
delete from public.audit_events where actor_user_id = '$FIN';
set session_replication_role = origin;
delete from auth.users where id = '$FIN';
" >/dev/null
rm -rf "$DIR"
exit $STATUS
