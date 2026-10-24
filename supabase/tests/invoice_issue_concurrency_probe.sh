#!/usr/bin/env bash
# ============================================================================
# TWO DRAFTS IN ONE WORKSPACE ISSUED AT ONCE (Invoices part 1, Task 5; spec
# § Lifecycle: "Two concurrent issues get two consecutive numbers").
#
# A single-session suite cannot measure this: an unlocked read of
# next_number passes every assertion in rls_invoices.sql § IS and still lets
# two concurrent sessions take the same number. In each phase session one
# issues a draft and holds its transaction for two seconds; half a second in,
# session two issues another, and reports whether it WAITED (more than 0.3s
# inside its transaction), so a run with no overlap cannot pass.
#   PHASE 1, two drafts: PRB-0001 then PRB-0002, next_number 3.
#   PHASE 2, two drafts pulling ONE income entry (Q255 default (a)): session
#   one issues PRB-0003, session two is refused invoice_entry_already_invoiced
#   and its draft stays a draft. This holds only because the Q255 check runs
#   AFTER the settings row lock (a fresh READ COMMITTED snapshot); above the
#   lock, session two reads session one's draft uncommitted and issues too.
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
D3=$(psql_q "select gen_random_uuid()")
D4=$(psql_q "select gen_random_uuid()")
EV=$(psql_q "select gen_random_uuid()")
FE=$(psql_q "select gen_random_uuid()")
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
insert into public.events (id, organisation_id, name, starts_at) values ('$EV', '$ORG', 'Race Night', now() + interval '10 days');
insert into public.financial_entries (id, organisation_id, event_id, category, status, amount_minor, description)
  values ('$FE', '$ORG', '$EV', 'income', 'budgeted', 300, 'Race door');
insert into public.invoices (id, organisation_id, recipient_contact_id, recipient_address, event_id, created_by)
  values ('$D3', '$ORG', '$CON', '2 Race Road', '$EV', '$FIN'), ('$D4', '$ORG', '$CON', '2 Race Road', '$EV', '$FIN');
insert into public.invoice_lines (organisation_id, invoice_id, position, description, quantity, unit_price_minor, vat_rate, net_minor, vat_minor, financial_entry_id)
  values ('$ORG', '$D3', 1, 'Door', 1, 300, 'none', 300, 0, '$FE'), ('$ORG', '$D4', 1, 'Door', 1, 300, 'none', 300, 0, '$FE');
" >/dev/null

DIR=$(mktemp -d)
# race FIRST SECOND: session one issues FIRST and holds for 2s; session two
# issues SECOND 0.5s later. ON_ERROR_ROLLBACK keeps session two's transaction
# alive past a refusal so it can still report whether it waited.
race() {
  MSYS_NO_PATHCONV=1 docker exec -i "$CTR" psql -U postgres -d postgres -Atq > "$DIR/one" 2>&1 <<SQL &
begin;
set local role authenticated;
set local request.jwt.claims = '$FIN_C';
select 'issued:' || public.issue_invoice('$1');
select pg_sleep(2);
commit;
SQL
  local p1=$!
  sleep 0.5
  MSYS_NO_PATHCONV=1 docker exec -i "$CTR" psql -U postgres -d postgres -Atq > "$DIR/two" 2>&1 <<SQL &
\set ON_ERROR_ROLLBACK on
begin;
set local role authenticated;
set local request.jwt.claims = '$FIN_C';
select 'issued:' || public.issue_invoice('$2');
select 'waited:' || (clock_timestamp() - now() > interval '0.3 seconds')::text;
commit;
SQL
  local p2=$!
  wait $p1; wait $p2
  echo "  session one: $(tr '\n' ' ' < "$DIR/one")"
  echo "  session two: $(tr '\n' ' ' < "$DIR/two")"
}
STATUS=0

echo "phase 1: two drafts issued at once"
race "$D1" "$D2"
NUMBERS=$(psql_q "select string_agg(number, ',' order by number) from public.invoices where organisation_id = '$ORG'")
NEXT=$(psql_q "select next_number from public.invoice_settings where organisation_id = '$ORG'")
echo "  after: numbers=$NUMBERS next_number=$NEXT"
if [ "$NUMBERS" != "PRB-0001,PRB-0002" ] || [ "$NEXT" != "3" ] \
   || ! grep -q 'issued:PRB-0001' "$DIR/one" || ! grep -q 'issued:PRB-0002' "$DIR/two" \
   || ! grep -q 'waited:true' "$DIR/two"; then
  echo "FAIL: concurrent issues did not get two consecutive numbers with session two waiting -- the settings row lock is gone, or the sessions never overlapped."
  STATUS=1
else
  echo "PASS: two concurrent issues took PRB-0001 and PRB-0002, in order, with no gap; session two waited."
fi

echo "phase 2: two drafts pulling one income entry issued at once (Q255)"
race "$D3" "$D4"
NUMBERS=$(psql_q "select string_agg(number, ',' order by number) from public.invoices where organisation_id = '$ORG'")
NEXT=$(psql_q "select next_number from public.invoice_settings where organisation_id = '$ORG'")
D4_STATUS=$(psql_q "select status from public.invoices where id = '$D4'")
echo "  after: numbers=$NUMBERS next_number=$NEXT second_draft=$D4_STATUS"
if [ "$NUMBERS" != "PRB-0001,PRB-0002,PRB-0003" ] || [ "$NEXT" != "4" ] || [ "$D4_STATUS" != "draft" ] \
   || ! grep -q 'issued:PRB-0003' "$DIR/one" || ! grep -q 'HINT: *invoice_entry_already_invoiced' "$DIR/two" \
   || ! grep -q 'waited:true' "$DIR/two"; then
  echo "FAIL: one income entry was billed twice under a race, or session two never waited -- the Q255 check no longer sits after the settings row lock."
  STATUS=1
else
  echo "PASS: of two drafts pulling one entry, one issued (PRB-0003) and the other, having waited, was refused invoice_entry_already_invoiced."
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
