#!/usr/bin/env bash
# ============================================================================
# Runs supabase/tests/rls_foundation.sql against the LOCAL Supabase stack.
#
#   supabase db reset --local          # required: the fixtures assume an
#                                      # empty public schema and no auth users
#   supabase/tests/run-rls-tests.sh
#
# Creates five throwaway auth.users rows through the Auth admin API (so the
# tests run against real users, not hand-inserted auth rows), then hands their
# UUIDs to psql as variables.
#
# The service-role key is read from `supabase status` at runtime and never
# committed -- see CLAUDE.md, "Never commit ... Supabase service-role keys".
# LOCAL ONLY: this script must never be pointed at a hosted project.
# ============================================================================
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
CTR="supabase_db_$(grep -E '^project_id' "$ROOT/supabase/config.toml" | cut -d'"' -f2)"
API="http://127.0.0.1:54321"

SRK=$(cd "$ROOT" && supabase status -o json 2>/dev/null \
      | python -c "import sys,json;print(json.load(sys.stdin)['SERVICE_ROLE_KEY'])")
if [ -z "${SRK:-}" ]; then
  echo "Could not read SERVICE_ROLE_KEY from 'supabase status'. Is the local stack up?" >&2
  exit 1
fi

# Accumulated across the whole run rather than exiting at the first failure --
# see the summary at the bottom of this file (New-5).
psql_status=0
http_status=0

# ============================================================================
# PREFLIGHT: REFUSE TO RUN AGAINST A DIRTY DATABASE.
#
# NEW-6. Neither rls_foundation.sql nor rls_phase2_crm.sql tears its fixtures
# down -- deliberately, because the HTTP sections below read them. So a second
# run without an intervening `npx supabase db reset` starts with the previous
# run's rows still present, and schema_invariants.sql (which runs FIRST and
# assumes an empty public schema) fails E3 and Z1 with "0/0/0/0 expected,
# 4/15/3/4 actual".
#
# That is not a real finding, but it LOOKS exactly like one -- Z1 exists to
# catch leftover fixtures and cannot tell its own suite's from a previous
# invocation's. The header has always said a reset is required; this makes the
# script enforce it, so the failure mode is one actionable line instead of two
# red tenant-boundary-shaped assertions.
dirty=$(MSYS_NO_PATHCONV=1 docker exec "$CTR" psql -U postgres -d postgres -tAc \
  "select coalesce(sum(n),0) from (
     select count(*) n from public.organisations
     union all select count(*) from public.contacts
     union all select count(*) from public.companies
     union all select count(*) from public.venues
     union all select count(*) from public.artists
     union all select count(*) from public.merges
     union all select count(*) from public.merge_candidates) s" | tr -d '[:space:]')
if [ "${dirty:-0}" != "0" ]; then
  echo "REFUSING TO RUN: public schema is not empty ($dirty tenant rows present)." >&2
  echo "  These suites are not idempotent -- they build fixtures and do not tear" >&2
  echo "  them down, because the HTTP sections read them. Run:" >&2
  echo "      npx supabase db reset" >&2
  echo "  and try again. (Running anyway would fail schema_invariants E3/Z1 in a" >&2
  echo "  way that looks like a reopened tenant boundary and is not.)" >&2
  exit 1
fi

# ----------------------------------------------------------------------------
# ASSURANCE LEVEL PER FIXTURE USER.
#
# A real Supabase access token always carries a top-level `aal` claim --
# verified against this stack: a password grant returns "aal":"aal1", and
# mfa.challengeAndVerify() moves the same session to "aal2". The claims handed
# to psql below previously omitted it entirely, which was fine while nothing
# read it and is not fine now that 20260827210000_mfa_aal_permission_gate.sql
# gates every privileged permission on it.
#
# Each fixture user gets the level a REAL session of theirs would plausibly
# have, so the existing assertions keep meaning what they always meant:
#   alice/bob  owners  -> aal2. MFA is REQUIRED for them (CLAUDE.md § Session
#                        security), so a session of theirs that can do anything
#                        privileged is by definition one that presented a
#                        factor. Every existing owner assertion is unchanged.
#   super               -> aal2, same reason.
#   carol      standard_user -> aal1. MFA is OPTIONAL for her role at MVP, so
#                        aal1 is her REALISTIC steady state -- and running her
#                        assertions at aal1 is what proves the new gate is
#                        role-scoped rather than a blanket "aal2 to write
#                        anything", which would lock out every unprivileged
#                        role in the product.
#   dave       invited  -> aal1, same.
#
# Two extra claim sets per user are exported for the new section K:
#   <u>_c1   the same user at aal1        (the stolen-password session)
#   <u>_c0   the same user with NO `aal` claim at all (fail-closed check)
# ----------------------------------------------------------------------------
declare -A AAL=( [alice]=aal2 [bob]=aal2 [carol]=aal1 [dave]=aal1 [super]=aal2 )

declare -A ID
for u in alice bob carol dave super; do
  resp=$(curl -s -X POST "$API/auth/v1/admin/users" \
    -H "apikey: $SRK" -H "Authorization: Bearer $SRK" -H "Content-Type: application/json" \
    -d "{\"email\":\"$u@test.local\",\"password\":\"Test-Passw0rd!\",\"email_confirm\":true}")
  id=$(printf '%s' "$resp" | python -c "import sys,json;print(json.load(sys.stdin).get('id') or '')")
  if [ -z "$id" ]; then
    # Already present from an earlier run against this same database.
    id=$(MSYS_NO_PATHCONV=1 docker exec "$CTR" psql -U postgres -d postgres -tAc \
         "select id from auth.users where email='$u@test.local'" | tr -d '[:space:]')
  fi
  if [ -z "$id" ]; then echo "Could not create or find auth user $u: $resp" >&2; exit 1; fi
  ID[$u]=$id
done

# ============================================================================
# SCHEMA INVARIANTS / TENANT BOUNDARY (Phase 2).
#
# Runs FIRST, and needs no fixture users at all -- every assertion in it is
# enforced by a constraint rather than a policy, which is the entire reason the
# cross-tenant write was fixed at the constraint layer (see
# 20260828001132's header). It uses its own `invariants` schema because
# rls_foundation.sql opens with `drop schema if exists harness cascade`, and it
# tears its own fixtures down so the suite below still meets an empty schema.
# ============================================================================
docker cp "$HERE/schema_invariants.sql" "$CTR:/tmp/schema_invariants.sql"
MSYS_NO_PATHCONV=1 docker exec "$CTR" psql -U postgres -d postgres -q --pset=footer=off \
  -f /tmp/schema_invariants.sql

inv_fails=$(MSYS_NO_PATHCONV=1 docker exec "$CTR" psql -U postgres -d postgres -tAc \
            "select count(*) from invariants.results where not pass" | tr -d '[:space:]')
if [ "$inv_fails" != "0" ]; then
  echo "SCHEMA INVARIANT SUITE FAILED: $inv_fails failing assertion(s)" >&2
  echo "  A failure in section A is a REOPENED TENANT BOUNDARY -- treat as Sev1." >&2
  psql_status=1
else
  echo "Schema invariants: all assertions passed."
fi
echo

docker cp "$HERE/rls_foundation.sql" "$CTR:/tmp/rls_foundation.sql"

VARS=()
for u in alice bob carol dave super; do
  VARS+=( -v "$u=${ID[$u]}" )
  VARS+=( -v "${u}_c={\"sub\":\"${ID[$u]}\",\"role\":\"authenticated\",\"aal\":\"${AAL[$u]}\"}" )
  VARS+=( -v "${u}_c1={\"sub\":\"${ID[$u]}\",\"role\":\"authenticated\",\"aal\":\"aal1\"}" )
  VARS+=( -v "${u}_c0={\"sub\":\"${ID[$u]}\",\"role\":\"authenticated\"}" )
done

MSYS_NO_PATHCONV=1 docker exec "$CTR" psql -U postgres -d postgres -q --pset=footer=off \
  "${VARS[@]}" -f /tmp/rls_foundation.sql

# Non-zero exit if anything failed, so this is usable as a gate.
fails=$(MSYS_NO_PATHCONV=1 docker exec "$CTR" psql -U postgres -d postgres -tAc \
        "select count(*) from harness.results where not pass" | tr -d '[:space:]')
if [ "$fails" != "0" ]; then
  echo "RLS SUITE FAILED: $fails failing assertion(s)" >&2
  psql_status=1
else
  echo "RLS suite: all assertions passed."
fi

# ============================================================================
# PHASE 2 (CORE CRM) RLS / PERMISSION / RECORD-SCOPE SUITE.
#
# Its twelve fixture users are created HERE, after rls_foundation.sql has run,
# and deliberately not in the loop at the top of this script. That suite makes
# assertions over the whole of public.profiles (`string_agg(full_name)` and a
# bare `count(*)`), so twelve extra auth.users rows -- each of which the
# handle_new_user trigger turns into a profile -- would be reasoning about a
# different database than the one it was written against. Creating them after
# it finishes keeps the two suites independent.
#
# ASSURANCE LEVEL PER FIXTURE USER, same rule as the block at the top of this
# script: each user gets the level a REAL session of theirs would plausibly
# have. owner/admin/finance require MFA (CLAUDE.md § Session security), so a
# session of theirs that can do anything at all is one that presented a factor
# -- and since 20260827210000 they hold NO permission below aal2, which now
# reaches the CRM read policies too. Everyone else is aal1, which is their
# realistic steady state and is what proves the gate is role-scoped rather
# than a blanket lockout.
# ============================================================================
declare -A P2AAL=(
  [powner]=aal2 [padmin]=aal2 [pmanager]=aal1 [pbooker]=aal1 [pvenuemgr]=aal1
  [pfinance]=aal2 [pmarketing]=aal1 [pstd1]=aal1 [pstd2]=aal1 [pro]=aal1
  [pbowner]=aal2 [pmulti]=aal2
)

declare -A P2ID
for u in powner padmin pmanager pbooker pvenuemgr pfinance pmarketing \
         pstd1 pstd2 pro pbowner pmulti; do
  resp=$(curl -s -X POST "$API/auth/v1/admin/users" \
    -H "apikey: $SRK" -H "Authorization: Bearer $SRK" -H "Content-Type: application/json" \
    -d "{\"email\":\"$u@test.local\",\"password\":\"Test-Passw0rd!\",\"email_confirm\":true}")
  id=$(printf '%s' "$resp" | python -c "import sys,json;print(json.load(sys.stdin).get('id') or '')")
  if [ -z "$id" ]; then
    id=$(MSYS_NO_PATHCONV=1 docker exec "$CTR" psql -U postgres -d postgres -tAc \
         "select id from auth.users where email='$u@test.local'" | tr -d '[:space:]')
  fi
  if [ -z "$id" ]; then echo "Could not create or find auth user $u: $resp" >&2; exit 1; fi
  P2ID[$u]=$id
done

docker cp "$HERE/rls_phase2_crm.sql" "$CTR:/tmp/rls_phase2_crm.sql"

P2VARS=()
for u in powner padmin pmanager pbooker pvenuemgr pfinance pmarketing \
         pstd1 pstd2 pro pbowner pmulti; do
  P2VARS+=( -v "$u=${P2ID[$u]}" )
  P2VARS+=( -v "${u}_c={\"sub\":\"${P2ID[$u]}\",\"role\":\"authenticated\",\"aal\":\"${P2AAL[$u]}\"}" )
  P2VARS+=( -v "${u}_c1={\"sub\":\"${P2ID[$u]}\",\"role\":\"authenticated\",\"aal\":\"aal1\"}" )
done

MSYS_NO_PATHCONV=1 docker exec "$CTR" psql -U postgres -d postgres -q --pset=footer=off \
  "${P2VARS[@]}" -f /tmp/rls_phase2_crm.sql

p2_fails=$(MSYS_NO_PATHCONV=1 docker exec "$CTR" psql -U postgres -d postgres -tAc \
           "select count(*) from crm.results where not pass" | tr -d '[:space:]')
if [ "$p2_fails" != "0" ]; then
  echo "PHASE 2 CRM SUITE FAILED: $p2_fails failing assertion(s)" >&2
  echo "  A failure in section B or E is a REOPENED TENANT BOUNDARY -- treat as Sev1." >&2
  psql_status=1
else
  echo "Phase 2 CRM suite: all assertions passed."
fi

# ============================================================================
# PHASE 3 (EVENTS) RLS / PERMISSION / RECORD-SCOPE SUITE.
#
# Runs AFTER the Phase 2 suite and REUSES ITS FIXTURES WHOLE -- the same twelve
# users, the same two organisations, the same venues and artists -- so no new
# auth.users rows are created here and P2VARS is handed straight over. That is
# deliberate: a second cast of characters would be a second place for the role
# matrix to drift, and what this phase is actually about is how events sit on
# top of the Phase 2 record scope.
#
# It writes into its OWN `ev` schema rather than `crm`, so the count above
# stays a statement about the Phase 2 suite alone and a Phase 3 failure is not
# reported under a Phase 2 heading.
# ============================================================================
docker cp "$HERE/rls_phase3_events.sql" "$CTR:/tmp/rls_phase3_events.sql"

MSYS_NO_PATHCONV=1 docker exec "$CTR" psql -U postgres -d postgres -q --pset=footer=off \
  "${P2VARS[@]}" -f /tmp/rls_phase3_events.sql

p3_fails=$(MSYS_NO_PATHCONV=1 docker exec "$CTR" psql -U postgres -d postgres -tAc \
           "select count(*) from ev.results where not pass" | tr -d '[:space:]')
if [ "$p3_fails" != "0" ]; then
  echo "PHASE 3 EVENTS SUITE FAILED: $p3_fails failing assertion(s)" >&2
  echo "  A failure in section EB, EF or EK is a REOPENED TENANT BOUNDARY -- treat as Sev1." >&2
  echo "  A failure in EF10-EF12 means the FK LIFT did not put the schema back:" >&2
  echo "  discard the run, reset the database, and do not trust anything after it." >&2
  psql_status=1
else
  echo "Phase 3 events suite: all assertions passed."
fi

# ============================================================================
# PHASE 4 (OPERATIONS) RLS / PERMISSION / TENANT-BOUNDARY SUITE.
#
# Runs AFTER the Phase 3 events suite and REUSES THE SAME FIXTURES WHOLE -- the
# twelve users, orgs ALPHA and BETA, and the Phase 2 contacts / companies /
# venues that the *_links target end points at. Only operational rows (tasks,
# meetings, notes, documents, links) are created, in its OWN `op` schema, so the
# count below is a statement about the Phase 4 suite alone.
# ============================================================================
docker cp "$HERE/rls_phase4_operations.sql" "$CTR:/tmp/rls_phase4_operations.sql"

MSYS_NO_PATHCONV=1 docker exec "$CTR" psql -U postgres -d postgres -q --pset=footer=off \
  "${P2VARS[@]}" -f /tmp/rls_phase4_operations.sql

p4_fails=$(MSYS_NO_PATHCONV=1 docker exec "$CTR" psql -U postgres -d postgres -tAc \
           "select count(*) from op.results where not pass" | tr -d '[:space:]')
if [ "$p4_fails" != "0" ]; then
  echo "PHASE 4 OPERATIONS SUITE FAILED: $p4_fails failing assertion(s)" >&2
  echo "  A failure in OC, OD, OE or OF is a REOPENED TENANT BOUNDARY or a" >&2
  echo "  broken note-visibility / link-target control -- treat as Sev1." >&2
  echo "  A failure in OE3/OE3b means the FK LIFT did not put the schema back:" >&2
  echo "  discard the run, reset the database, and do not trust anything after it." >&2
  psql_status=1
else
  echo "Phase 4 operations suite: all assertions passed."
fi

# ============================================================================
# PHASE 4 FILE-ACCESS SUITE (Task 5).
#
# The download half of the file-security pipeline at the DB layer: the
# storage-key invariant, the storage.objects deny-all fence (proven to hold even
# under a broad permissive grant), and the scan-status transition guard. Runs
# AFTER the phase 4 operations suite, reuses the same fixtures (orgs
# org-alpha/org-beta and the P2VARS claims), and tears down every row it plants
# so the HTTP checks below start clean.
# ============================================================================
docker cp "$HERE/file_access_phase4.sql" "$CTR:/tmp/file_access_phase4.sql"

MSYS_NO_PATHCONV=1 docker exec "$CTR" psql -U postgres -d postgres -q --pset=footer=off \
  "${P2VARS[@]}" -f /tmp/file_access_phase4.sql

fa_fails=$(MSYS_NO_PATHCONV=1 docker exec "$CTR" psql -U postgres -d postgres -tAc \
           "select count(*) from fa.results where not pass" | tr -d '[:space:]')
if [ "$fa_fails" != "0" ]; then
  echo "PHASE 4 FILE-ACCESS SUITE FAILED: $fa_fails failing assertion(s)" >&2
  echo "  A failure in A is a BROKEN storage-key invariant (a cross-tenant" >&2
  echo "  file is now insertable); in B, a BREACHED storage.objects fence" >&2
  echo "  (a client can read the private bytes); in C, a scan-status guard" >&2
  echo "  that no longer holds (a verdict can be rolled back). Treat as Sev1." >&2
  psql_status=1
else
  echo "Phase 4 file-access suite: all assertions passed."
fi

# ============================================================================
# PHASE 5 (FINANCE) RLS SUITE -- THE THREE-GATE BREAKOUT PROOF (Task 4).
#
# Runs LAST of the psql suites and REUSES THE SAME FIXTURES WHOLE -- the twelve
# users and orgs org-alpha/org-beta, plus the P2VARS claims (it needs
# `pfinance_c` AND `pfinance_c1`, the same user at aal2 and aal1, which is the
# entire MFA half of the proof).
#
# It plants its own events and finance lines, and it deliberately DELETES the
# one contact and the one artist it adds (its section FJ), so the HTTP block
# below still meets the contact and artist censuses it was written against.
# ============================================================================
docker cp "$HERE/rls_phase5_finance.sql" "$CTR:/tmp/rls_phase5_finance.sql"

MSYS_NO_PATHCONV=1 docker exec "$CTR" psql -U postgres -d postgres -q --pset=footer=off \
  "${P2VARS[@]}" -f /tmp/rls_phase5_finance.sql

p5_fails=$(MSYS_NO_PATHCONV=1 docker exec "$CTR" psql -U postgres -d postgres -tAc \
           "select count(*) from fin.results where not pass" | tr -d '[:space:]')
if [ "$p5_fails" != "0" ]; then
  echo "PHASE 5 FINANCE SUITE FAILED: $p5_fails failing assertion(s)" >&2
  echo "  A failure in FD is a BREACHED ROLE GATE (a non-finance role reads or" >&2
  echo "  writes money); in FE, a BROKEN TIER GATE (a non-Pro org writes finance," >&2
  echo "  or a downgrade hid existing data); in FF, a BROKEN MFA GATE (an aal1" >&2
  echo "  session holds a finance key); in FG/FH, a REOPENED TENANT BOUNDARY." >&2
  echo "  Every one of those is Sev1." >&2
  psql_status=1
else
  echo "Phase 5 finance suite: all assertions passed."
fi

# ============================================================================
# API-SURFACE CHECKS (PostgREST, over HTTP).
#
# The psql suite above proves the policies are right. It CANNOT prove which
# functions are published as HTTP endpoints -- and that was a real defect: a
# SECURITY DEFINER helper sat in `public` with EXECUTE to authenticated, which
# made it an RPC that returned any membership row's status cross-tenant. Schema
# placement is the control, so it gets tested at the layer it applies to.
#
# Runs as a REAL signed-in user (password grant), not a hand-made JWT.
# ============================================================================
echo
echo "=== API surface (PostgREST) ==="

ANON=$(cd "$ROOT" && supabase status -o json 2>/dev/null \
       | python -c "import sys,json;print(json.load(sys.stdin)['ANON_KEY'])")

TOKEN=$(curl -s -X POST "$API/auth/v1/token?grant_type=password" \
  -H "apikey: $ANON" -H "Content-Type: application/json" \
  -d '{"email":"carol@test.local","password":"Test-Passw0rd!"}' \
  | python -c "import sys,json;print(json.load(sys.stdin).get('access_token') or '')")
[ -n "$TOKEN" ] || { echo "could not sign in as carol over HTTP" >&2; exit 1; }

api_fails=0
probe() { # name  expected_http  path  body
  local name="$1" want="$2" path="$3" body="${4:-{\}}"
  local code
  code=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$API/rest/v1/$path" \
    -H "apikey: $ANON" -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" -d "$body")
  if [ "$code" = "$want" ]; then
    printf '  PASS  %-58s %s\n' "$name" "$code"
  else
    printf '  FAIL  %-58s got %s want %s\n' "$name" "$code" "$want"; api_fails=$((api_fails+1))
  fi
}

# Every private helper must be unroutable (404 = not in an exposed schema).
probe "private helper membership_update_is_permitted not an RPC" 404 \
      "rpc/membership_update_is_permitted"
probe "private helper has_platform_permission not an RPC"        404 "rpc/has_platform_permission"
probe "private helper is_active_member not an RPC"               404 "rpc/is_active_member"
probe "private helper shares_active_organisation not an RPC"     404 "rpc/shares_active_organisation"
probe "private helper log_audit_event not an RPC"                404 "rpc/log_audit_event"
probe "private helper handle_new_user not an RPC"                404 "rpc/handle_new_user"
# Task 5: private.audit_document_action and the scan-status guard trigger fn are
# not in `public` and must never be an RPC (rpc/audit_document_action resolves
# to the PUBLIC thin wrapper, tested below; there is no private path at the API).
probe "private helper guard_document_scan_status not an RPC"     404 "rpc/guard_document_scan_status"
# public.audit_document_action IS the client-callable thin RPC, and it is
# GUARDED: a null org and a forged arbitrary org both fail closed (42501 -> 403),
# so it is reachable (not 404) yet cannot mint an audit row for an org the caller
# has no relationship with. The actor is always forced to auth.uid().
probe "audit_document_action IS routable and fails closed on a null org"   403 \
      "rpc/audit_document_action" '{"p_action":"document_downloaded","p_org":null,"p_document_id":null}'
probe "audit_document_action refuses a forged org the caller cannot view"  403 \
      "rpc/audit_document_action" '{"p_action":"document_downloaded","p_org":"00000000-0000-0000-0000-0000000000aa","p_document_id":"00000000-0000-0000-0000-0000000000bb"}'
# The two DEFINER functions that ARE meant to be client endpoints stay routable
# (400 = reached it, rejected the deliberately invalid slug / null id).
probe "create_organisation IS routable (positive control)"       400 \
      "rpc/create_organisation" '{"p_name":"X","p_slug":"!"}'
probe "accept_invite IS routable (positive control)"             400 \
      "rpc/accept_invite" '{"p_membership_id":null}'
# has_permission is SECURITY INVOKER and self-scoped, so it stays public.
probe "has_permission IS routable (positive control)"            200 \
      "rpc/has_permission" '{"p_org_id":null,"p_permission":"manage_members"}'

# End-to-end: RLS through the real API, not just through psql.
rows=$(curl -s "$API/rest/v1/organisations?select=slug" \
  -H "apikey: $ANON" -H "Authorization: Bearer $TOKEN" \
  | python -c "import sys,json;print(len(json.load(sys.stdin)))")
if [ "$rows" = "1" ]; then
  printf '  PASS  %-58s %s\n' "carol sees exactly 1 org over the REST API" "$rows"
else
  printf '  FAIL  %-58s got %s want 1\n' "carol sees exactly 1 org over the REST API" "$rows"
  api_fails=$((api_fails+1))
fi

# ----------------------------------------------------------------------------
# THE MFA BYPASS, OVER REAL HTTP.
#
# The psql section K proves the aal gate holds when the claims are set by hand.
# This proves it against the actual attack: a REAL access token, minted by a
# REAL password sign-in (which returns aal1 -- no MFA challenge is possible
# here, alice has no factor), plus the public anon key that ships in every
# browser bundle, POSTed straight at PostgREST. That request never touches the
# Next.js app, so no Server Action guard and no layout gate is on its path.
# This is the request the whole Layer-2 half of the fix exists for.
#
# Its positive controls are the GET below (same token, same table, still works
# -- so a 403 is the policy talking, not a dead endpoint or a bad token) and
# psql K11/C7 (the same owner CAN do this at aal2).
# ----------------------------------------------------------------------------
echo
echo "=== MFA enforcement at the API surface ==="

ATOKEN=$(curl -s -X POST "$API/auth/v1/token?grant_type=password" \
  -H "apikey: $ANON" -H "Content-Type: application/json" \
  -d '{"email":"alice@test.local","password":"Test-Passw0rd!"}' \
  | python -c "import sys,json;print(json.load(sys.stdin).get('access_token') or '')")
[ -n "$ATOKEN" ] || { echo "could not sign in as alice over HTTP" >&2; exit 1; }

# Sanity: this really is an aal1 session, not an accidentally-privileged one.
alice_aal=$(printf '%s' "$ATOKEN" | python -c "
import sys,json,base64
p=sys.stdin.read().split('.')[1]; p+='='*(-len(p)%4)
print(json.loads(base64.urlsafe_b64decode(p)).get('aal',''))")
if [ "$alice_aal" = "aal1" ]; then
  printf '  PASS  %-58s %s\n' "password sign-in really does yield an aal1 session" "$alice_aal"
else
  printf '  FAIL  %-58s got %s want aal1\n' "password sign-in really does yield an aal1 session" "$alice_aal"
  api_fails=$((api_fails+1))
fi

ORG_A=$(curl -s "$API/rest/v1/organisations?select=id&slug=eq.org-a" \
  -H "apikey: $ANON" -H "Authorization: Bearer $ATOKEN" \
  | python -c "import sys,json;d=json.load(sys.stdin);print(d[0]['id'] if d else '')")
[ -n "$ORG_A" ] || { echo "alice could not read her own org over HTTP" >&2; exit 1; }

code=$(curl -s -o /dev/null -w "%{http_code}" -X POST \
  "$API/rest/v1/organisation_memberships" \
  -H "apikey: $ANON" -H "Authorization: Bearer $ATOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"organisation_id\":\"$ORG_A\",\"user_id\":\"${ID[super]}\",\"role\":\"admin\",\"status\":\"invited\"}")
if [ "$code" = "403" ]; then
  printf '  PASS  %-58s %s\n' "aal1 owner CANNOT invite an admin via PostgREST" "$code"
else
  printf '  FAIL  %-58s got %s want 403\n' "aal1 owner CANNOT invite an admin via PostgREST" "$code"
  api_fails=$((api_fails+1))
fi

# Positive control for the line above, AND the lockout guard at the HTTP layer:
# the same aal1 token must still read the membership list, or an un-enrolled
# Owner cannot render the app far enough to enrol.
rows=$(curl -s "$API/rest/v1/organisation_memberships?select=id" \
  -H "apikey: $ANON" -H "Authorization: Bearer $ATOKEN" \
  | python -c "import sys,json;d=json.load(sys.stdin);print(len(d) if isinstance(d,list) else -1)")
if [ "$rows" -ge 1 ] 2>/dev/null; then
  printf '  PASS  %-58s %s\n' "LOCKOUT GUARD: aal1 owner still READS memberships" "$rows"
else
  printf '  FAIL  %-58s got %s want >=1\n' "LOCKOUT GUARD: aal1 owner still READS memberships" "$rows"
  api_fails=$((api_fails+1))
fi

# ============================================================================
# PHASE 2 CRM OVER REAL HTTP.
#
# The psql suite above proves the policies. It CANNOT prove that the same
# answers come back through PostgREST, and that gap is not theoretical in this
# repo: Foundation found that grant-layer and policy-layer denials surface
# differently (401 vs 403 vs an empty 200), and that a SECURITY DEFINER helper
# in the wrong schema is an HTTP endpoint no psql assertion would notice.
#
# Every request below uses a REAL access token from a REAL password sign-in
# plus the public anon key that ships in the browser bundle -- i.e. the request
# an attacker sends, which never touches the Next.js app and so meets no Server
# Action guard and no layout gate.
#
# NOTE the assurance level a password grant yields: aal1, always (measured in
# the MFA block above). So powner's probes below are the aal1-owner case, which
# is why they expect an EMPTY result rather than a full one -- see
# 20260828121000 design note (i).
# ============================================================================
echo
echo "=== Phase 2 CRM at the API surface ==="

BETA_ORG=$(MSYS_NO_PATHCONV=1 docker exec "$CTR" psql -U postgres -d postgres -tAc \
           "select id from public.organisations where slug='org-beta'" | tr -d '[:space:]')
ALPHA_ORG=$(MSYS_NO_PATHCONV=1 docker exec "$CTR" psql -U postgres -d postgres -tAc \
            "select id from public.organisations where slug='org-alpha'" | tr -d '[:space:]')

p2_token() { # email -> access token
  curl -s -X POST "$API/auth/v1/token?grant_type=password" \
    -H "apikey: $ANON" -H "Content-Type: application/json" \
    -d "{\"email\":\"$1@test.local\",\"password\":\"Test-Passw0rd!\"}" \
    | python -c "import sys,json;print(json.load(sys.stdin).get('access_token') or '')"
}

p2_code() { # name want_http METHOD path [body] [token]
  local name="$1" want="$2" method="$3" path="$4" body="${5:-}" tok="${6:-}"
  local code
  if [ -n "$body" ]; then
    code=$(curl -s -o /dev/null -w "%{http_code}" -X "$method" "$API/rest/v1/$path" \
      -H "apikey: $ANON" ${tok:+-H "Authorization: Bearer $tok"} \
      -H "Content-Type: application/json" -d "$body")
  else
    code=$(curl -s -o /dev/null -w "%{http_code}" -X "$method" "$API/rest/v1/$path" \
      -H "apikey: $ANON" ${tok:+-H "Authorization: Bearer $tok"})
  fi
  if [ "$code" = "$want" ]; then printf '  PASS  %-58s %s\n' "$name" "$code"
  else printf '  FAIL  %-58s got %s want %s\n' "$name" "$code" "$want"; api_fails=$((api_fails+1)); fi
}

p2_rows() { # name want_count path token
  local name="$1" want="$2" path="$3" tok="$4" n
  n=$(curl -s "$API/rest/v1/$path" -H "apikey: $ANON" -H "Authorization: Bearer $tok" \
      | python -c "import sys,json;d=json.load(sys.stdin);print(len(d) if isinstance(d,list) else -1)")
  if [ "$n" = "$want" ]; then printf '  PASS  %-58s %s\n' "$name" "$n"
  else printf '  FAIL  %-58s got %s want %s\n' "$name" "$n" "$want"; api_fails=$((api_fails+1)); fi
}

# THE VALUE VARIANT OF p2_rows, ADDED IN PHASE 3 TASK 1 (final review I-7).
#
# p2_rows counts rows. That is enough for a visibility question -- "does this
# tenant see the other tenant's contacts" -- and it is NOT enough for the one
# this was added for: `merges.field_resolution` is written by exactly one
# function, and a row coming back proves nothing about whether the snapshot the
# /merges screen and the activity timeline both read is inside it. So this
# walks a dotted path into the FIRST row's JSON and compares the value.
#
# `<null>` for an absent key or a null value, `<none>` for no rows at all, so
# "the key is missing" and "the query matched nothing" are different failures.
p2_json() { # name want path token dotted.key
  local name="$1" want="$2" path="$3" tok="$4" key="$5" v
  v=$(curl -s "$API/rest/v1/$path" -H "apikey: $ANON" -H "Authorization: Bearer $tok" \
      | KEY="$key" python -c "
import sys, json, os
d = json.load(sys.stdin)
if not isinstance(d, list) or not d:
    print('<none>')
else:
    cur = d[0]
    for part in os.environ['KEY'].split('.'):
        cur = cur.get(part) if isinstance(cur, dict) else None
    print('<null>' if cur is None else cur)
")
  if [ "$v" = "$want" ]; then printf '  PASS  %-58s %s\n' "$name" "$v"
  else printf '  FAIL  %-58s got %s want %s\n' "$name" "$v" "$want"; api_fails=$((api_fails+1)); fi
}

MGR=$(p2_token pmanager);   [ -n "$MGR" ] || { echo "no token for pmanager" >&2; exit 1; }
BKR=$(p2_token pbooker);    [ -n "$BKR" ] || { echo "no token for pbooker" >&2; exit 1; }
STD=$(p2_token pstd1);      [ -n "$STD" ] || { echo "no token for pstd1" >&2; exit 1; }
OWN=$(p2_token powner);     [ -n "$OWN" ] || { echo "no token for powner" >&2; exit 1; }
# Task 4: the read_only role, for the RPC refusal checks at the bottom.
RO=$(p2_token pro);         [ -n "$RO" ]  || { echo "no token for pro" >&2; exit 1; }
# Task 4b: the venue_manager, who is the role that DIVERGES on an agency page --
# manage_contacts and manage_venues, and no manage_artists. Read out of
# role_permissions rather than guessed; see T22c in rls_phase2_crm.sql for the
# assumption that got corrected.
VNM=$(p2_token pvenuemgr);  [ -n "$VNM" ] || { echo "no token for pvenuemgr" >&2; exit 1; }

# anon: the tables must not be reachable logged out at all.
p2_code "anon GET contacts"                       401 GET  "contacts?select=id"
p2_code "anon GET custom_field_values"            401 GET  "custom_field_values?select=id"
p2_code "anon POST contacts"                      401 POST "contacts" \
        "{\"organisation_id\":\"$ALPHA_ORG\",\"name\":\"anon\"}"

# Tenant boundary, over HTTP, aimed directly at the other tenant's org id --
# the request an attacker actually sends, since the org id is in every URL.
p2_rows "manager GET contacts of org BETA (expect 0)"   0 \
        "contacts?select=id&organisation_id=eq.$BETA_ORG" "$MGR"
p2_rows "manager GET venue_rooms of org BETA (expect 0)" 0 \
        "venue_rooms?select=id&organisation_id=eq.$BETA_ORG" "$MGR"
p2_code "manager POSTs a contact into org BETA"         403 POST "contacts" \
        "{\"organisation_id\":\"$BETA_ORG\",\"name\":\"planted\"}" "$MGR"

# The role matrix, over HTTP.
p2_code "booker POSTs a venue (no manage_venues)"       403 POST "venues" \
        "{\"organisation_id\":\"$ALPHA_ORG\",\"name\":\"http venue\"}" "$BKR"
p2_code "booker POSTs an artist (has manage_artists)"   201 POST "artists" \
        "{\"organisation_id\":\"$ALPHA_ORG\",\"name\":\"http artist\"}" "$BKR"
p2_code "booker POSTs a custom field DEFINITION"        403 POST "custom_field_definitions" \
        "{\"organisation_id\":\"$ALPHA_ORG\",\"entity_type\":\"artist\",\"key\":\"http_key\",\"label\":\"H\",\"field_type\":\"text\"}" "$BKR"

# The polymorphic hole, over HTTP: an ALPHA row naming a BETA contact.
BETA_CONTACT='2222000b-0000-0000-0000-00000000000b'
CFD_CONTACT='aaaa0000-0000-0000-0000-000000000002'
p2_code "manager POSTs a custom field value onto a BETA entity" 403 POST "custom_field_values" \
        "{\"organisation_id\":\"$ALPHA_ORG\",\"field_id\":\"$CFD_CONTACT\",\"entity_type\":\"contact\",\"entity_id\":\"$BETA_CONTACT\",\"value\":\"\\\"x\\\"\"}" "$MGR"

# The absent grants are absent at the HTTP layer too, which is the only place a
# missing grant and a denying policy look different.
p2_code "manager DELETEs a contact (no DELETE grant)"   403 DELETE \
        "contacts?id=eq.22220000-0000-0000-0000-000000000002" "" "$MGR"
p2_code "manager PATCHes merges (append-only)"          403 PATCH \
        "merges?id=eq.cccc0000-0000-0000-0000-000000000002" \
        '{"field_resolution":{}}' "$MGR"
p2_code "manager DELETEs merges (append-only)"          403 DELETE \
        "merges?id=eq.cccc0000-0000-0000-0000-000000000002" "" "$MGR"

# Record scope, over HTTP: every row pstd1 gets back is a row pstd1 owns.
STD_ID="${P2ID[pstd1]}"
foreign=$(curl -s "$API/rest/v1/contacts?select=id,owner_user_id" \
  -H "apikey: $ANON" -H "Authorization: Bearer $STD" \
  | python -c "
import sys,json
d=json.load(sys.stdin)
print(-1 if not isinstance(d,list) else sum(1 for r in d if r['owner_user_id']!='$STD_ID'))")
if [ "$foreign" = "0" ]; then
  printf '  PASS  %-58s %s\n' "standard_user GETs only rows they own" "$foreign"
else
  printf '  FAIL  %-58s got %s want 0\n' "standard_user GETs only rows they own" "$foreign"
  api_fails=$((api_fails+1))
fi

# THE MFA READ GATE, over real HTTP. A password sign-in yields aal1, and an
# Owner requires MFA -- so this is the stolen-password case reaching PostgREST
# directly with the anon key, which is the path SECURITY.md § 4 is about.
p2_rows "aal1 OWNER GETs zero contacts (MFA read gate)"  0 "contacts?select=id" "$OWN"
p2_code "aal1 OWNER cannot POST a contact"              403 POST "contacts" \
        "{\"organisation_id\":\"$ALPHA_ORG\",\"name\":\"aal1\"}" "$OWN"
# Positive control / lockout guard: the SAME aal1 token still reads the tables
# the enrolment screen needs, so an un-enrolled Owner is not locked out.
p2_rows "LOCKOUT GUARD: aal1 owner still GETs their org" 1 \
        "organisations?select=id&slug=eq.org-alpha" "$OWN"

# ----------------------------------------------------------------------------
# SUBSCRIPTION ENTITLEMENT, OVER REAL HTTP.
#
# The review reproduced the missing gate exactly here -- three Free-tier users
# POSTing artists, contacts and venues and getting 201 each -- so the fix is
# proven at the same layer rather than only in psql. The psql suite's § N is the
# thorough version; this is the end-to-end one, and it is the one that matches
# the reproduction.
#
# The subscription row is written with psql because organisation_subscriptions
# is superuser-only over the API by design (Foundation design note (g): an
# org-scoped write path there is a free upgrade to Pro).
# ----------------------------------------------------------------------------
echo
echo "=== Subscription entitlement at the API surface ==="

p2_sub() { # sql
  MSYS_NO_PATHCONV=1 docker exec "$CTR" psql -U postgres -d postgres -q -c "$1" > /dev/null
}

p2_sub "insert into public.organisation_subscriptions
          (organisation_id, plan_id, billing_cycle, seat_count, status, current_period_end)
        values ('$ALPHA_ORG','free','monthly',1,'active', now() + interval '30 days')
        on conflict (organisation_id) do update set plan_id='free', status='active';"

p2_code "FREE tier: booker POSTs an artist"    403 POST "artists" \
        "{\"organisation_id\":\"$ALPHA_ORG\",\"name\":\"free artist\"}" "$BKR"
p2_code "FREE tier: manager POSTs a contact"   403 POST "contacts" \
        "{\"organisation_id\":\"$ALPHA_ORG\",\"name\":\"free contact\"}" "$MGR"
p2_code "FREE tier: standard_user POSTs a venue" 403 POST "venues" \
        "{\"organisation_id\":\"$ALPHA_ORG\",\"name\":\"free venue\"}" "$STD"
# Free is a READ tier (CLAUDE.md § Subscription tiers), and a downgrade must
# never hide a customer's existing data. So reads stay open.
rows=$(curl -s "$API/rest/v1/contacts?select=id" -H "apikey: $ANON" \
       -H "Authorization: Bearer $MGR" \
       | python -c "import sys,json;d=json.load(sys.stdin);print(len(d) if isinstance(d,list) else -1)")
if [ "$rows" -ge 1 ] 2>/dev/null; then
  printf '  PASS  %-58s %s\n' "FREE tier: reads still work (Free is a read tier)" "$rows"
else
  printf '  FAIL  %-58s got %s want >=1\n' "FREE tier: reads still work (Free is a read tier)" "$rows"
  api_fails=$((api_fails+1))
fi

p2_sub "update public.organisation_subscriptions set plan_id='starter'
        where organisation_id='$ALPHA_ORG';"
p2_code "STARTER tier: the same artist POST is allowed"  201 POST "artists" \
        "{\"organisation_id\":\"$ALPHA_ORG\",\"name\":\"starter artist\"}" "$BKR"

# The founder's past_due grace window (lib/entitlements/policy.ts, 2026-08-28),
# at the layer that enforces it. Both sides of the boundary, because a window
# that never opens and a window that never closes are opposite bugs and a
# one-sided probe passes for both.
p2_sub "update public.organisation_subscriptions
          set status='past_due', current_period_end = now() - interval '1 day'
        where organisation_id='$ALPHA_ORG';"
p2_code "PAST_DUE inside the 3-day grace: writes are KEPT"     201 POST "artists" \
        "{\"organisation_id\":\"$ALPHA_ORG\",\"name\":\"in grace artist\"}" "$BKR"

p2_sub "update public.organisation_subscriptions
          set current_period_end = now() - interval '4 days'
        where organisation_id='$ALPHA_ORG';"
p2_code "PAST_DUE after the grace expires: writes fall to Free" 403 POST "artists" \
        "{\"organisation_id\":\"$ALPHA_ORG\",\"name\":\"lapsed artist\"}" "$BKR"

# 'cancelled' is something the customer chose, so it is honoured at once --
# set INSIDE what would be a grace window, so only the status can deny it.
p2_sub "update public.organisation_subscriptions
          set status='cancelled', current_period_end = now() - interval '1 day'
        where organisation_id='$ALPHA_ORG';"
p2_code "CANCELLED inside the window: no grace, closed at once"  403 POST "artists" \
        "{\"organisation_id\":\"$ALPHA_ORG\",\"name\":\"cancelled artist\"}" "$BKR"

# Restore the shipped state -- no subscription row, so the gate is inert again.
p2_sub "delete from public.organisation_subscriptions where organisation_id='$ALPHA_ORG';"
p2_code "RESTORED: no subscription row, writes allowed again" 201 POST "artists" \
        "{\"organisation_id\":\"$ALPHA_ORG\",\"name\":\"inert artist\"}" "$BKR"

echo
echo "=== Read-only suspension at the API surface (Q6 / Task 3a) ==="
#
# The psql sections drive the same policies through the same mechanism PostgREST
# uses (the `authenticated` role plus request.jwt.claims), so this block is not
# a different gate -- it is a different LAYER, and this phase has twice found a
# defect that only the HTTP layer showed. It also pins the SHAPE of each
# refusal, which the browser has to interpret and psql's ok(0) does not describe.
#
# ============================================================================
# REWRITTEN IN TASK 3a FIX ROUND 1 (review finding I-5). TWO OF THE EIGHT
# CHECKS HERE WERE VACUOUS: THEY MEASURED THE MFA GATE, NOT SUSPENSION.
# ============================================================================
# $OWN comes from a password grant, which yields aal1 (measured in the MFA block
# above), and `owner` is an MFA-required role. So
#
#     SUSPENDED: owner POSTs a venue                             403
#     SUSPENDED: owner PATCHes deleted_at back to null -> no rows 204
#
# returned exactly those values with the organisation LIVE as well. The reviewer
# proved it material rather than tidy: under a mutation that genuinely opened a
# suspended organisation (manage_organisation.survives_suspension := true) the
# psql suite went red on P7/P7a/P7b while this entire HTTP block stayed green,
# INCLUDING the "deleted_at really is still set" line -- which passed because
# the aal1 owner could not have performed the write in any state.
#
# Two things fix it, and both are used below.
#
#   1. A REAL aal2 OWNER SESSION. A real TOTP enrolment against this stack, the
#      same journey tests/integration/mfa/aal-enforcement.test.ts walks in
#      vitest, done here in curl + python. Nothing is mocked: GoTrue issues the
#      secret, we compute the RFC 6238 code from it, GoTrue verifies it and
#      returns a token whose `aal` claim is asserted before use.
#   2. A LIVE CONTROL FOR EVERY SUSPENDED CHECK, taken with the same token and
#      the same statement moments earlier. If the pair does not differ, the
#      check is not measuring what its name says -- which is exactly the
#      discipline the psql suite's P2q/P2r already carry and this block did not.
#
# AND THE MECHANISM THAT MAKES A PATCH READABLE AT ALL (review M-3, corrected
# by re-review I-A). A PATCH refused by a USING clause matches no rows and
# PostgREST answers 204 No Content -- byte-identical, IN THE STATUS LINE, to a
# PATCH that changed fifteen rows.
#
# THE ROW COUNT IS IN THE `Content-Range` RESPONSE HEADER AND IS NEVER IN THE
# STATUS CODE. Fix round 1 measured only the status code, concluded that
# `Prefer: count=exact` "does not distinguish them (still 204)", and wrote that
# into four places. It is false. Measured on this stack, same caller, same
# PATCH, live then suspended:
#
#   no Prefer header at all   204   Content-Range: 0-14/*   vs   */*
#   Prefer: count=exact       204   Content-Range: 0-14/15  vs   */0
#   Prefer: return=represent. 200   6056 bytes of body      vs   2 bytes ([])
#
# So there are THREE mechanisms, in increasing cost, and all three work:
#   1. nothing at all -- the RANGE part alone separates them (`0-14` vs `*`);
#   2. `Prefer: count=exact` -- makes the TOTAL explicit (`/15` vs `/0`), still
#      a 204 with an empty body. This is the cheap, correct default;
#   3. `Prefer: return=representation` -- also works and returns `[]`, but
#      downloads every mutated row on every save to learn a number the header
#      already carried.
# All three are asserted below, against a live control, because Task 4's save
# path has to send one of them and should send the cheapest that works.
#
# NOTE ON ORDERING: the elevation happens HERE and not earlier, because
# verifying a user's first TOTP factor revokes their other sessions, and the
# aal1-owner checks above are load-bearing (the MFA read gate and its lockout
# guard). $OWN keeps its aal1 meaning; $OWN2 is the elevated session.

p2_totp_elevate() { # aal1 access token -> aal2 access token ('' on failure)
  local tok="$1" enroll fid secret ch cid code
  enroll=$(curl -s -X POST "$API/auth/v1/factors" -H "apikey: $ANON" \
    -H "Authorization: Bearer $tok" -H "Content-Type: application/json" \
    -d "{\"factor_type\":\"totp\",\"friendly_name\":\"rls-suite-$$-$RANDOM\"}")
  fid=$(printf '%s' "$enroll" | python -c \
    "import sys,json;print(json.load(sys.stdin).get('id',''))")
  secret=$(printf '%s' "$enroll" | python -c \
    "import sys,json;print(json.load(sys.stdin).get('totp',{}).get('secret',''))")
  [ -n "$fid" ] && [ -n "$secret" ] || { printf ''; return; }
  ch=$(curl -s -X POST "$API/auth/v1/factors/$fid/challenge" -H "apikey: $ANON" \
    -H "Authorization: Bearer $tok" -H "Content-Type: application/json" -d '{}')
  cid=$(printf '%s' "$ch" | python -c \
    "import sys,json;print(json.load(sys.stdin).get('id',''))")
  # RFC 6238, SHA-1 / 30s / 6 digits -- GoTrue's defaults. The same algorithm
  # tests/support/totp.ts implements for the vitest suites; reimplemented in
  # python here so this script keeps its no-node-dependency shape.
  code=$(SECRET="$secret" python -c "
import os,base64,hmac,hashlib,struct,time
s=os.environ['SECRET'].upper(); s+='='*(-len(s)%8)
h=hmac.new(base64.b32decode(s), struct.pack('>Q', int(time.time())//30), hashlib.sha1).digest()
o=h[-1]&0x0f
print(str((struct.unpack('>I',h[o:o+4])[0]&0x7fffffff)%1000000).zfill(6))")
  curl -s -X POST "$API/auth/v1/factors/$fid/verify" -H "apikey: $ANON" \
    -H "Authorization: Bearer $tok" -H "Content-Type: application/json" \
    -d "{\"challenge_id\":\"$cid\",\"code\":\"$code\"}" \
    | python -c "import sys,json;print(json.load(sys.stdin).get('access_token') or '')"
}

p2_aal() { # token -> its aal claim
  printf '%s' "$1" | python -c "
import sys,json,base64
p=sys.stdin.read().split('.')[1]; p+='='*(-len(p)%4)
print(json.loads(base64.urlsafe_b64decode(p)).get('aal',''))" 2>/dev/null
}

p2_written() { # name want_rows METHOD path body token
  # Rows ACTUALLY written, read from the representation PostgREST returns when
  # asked for it. This is the number a 204 hides.
  local name="$1" want="$2" method="$3" path="$4" body="$5" tok="$6" n
  n=$(curl -s -X "$method" "$API/rest/v1/$path" \
      -H "apikey: $ANON" -H "Authorization: Bearer $tok" \
      -H "Content-Type: application/json" -H "Prefer: return=representation" \
      -d "$body" \
      | python -c "import sys,json;d=json.load(sys.stdin);print(len(d) if isinstance(d,list) else -1)")
  if [ "$n" = "$want" ]; then printf '  PASS  %-58s %s\n' "$name" "$n rows written"
  else printf '  FAIL  %-58s got %s want %s\n' "$name" "$n" "$want"; api_fails=$((api_fails+1)); fi
}

# NOTE on the `|| true` inside the two helpers below: a refused write can answer
# 403 with NO Content-Range header at all, and under `set -o pipefail` a grep
# that matches nothing would abort the whole run instead of failing one check.
# An empty $cr is a FAILURE here, not a crash -- which is what lets the mutation
# runs in task-3a-fix-2-report.md report the rest of the suite.
p2_range_shape() { # name want(rows|none) METHOD path body token
  # NO Prefer header at all. The RANGE half of Content-Range is `first-last`
  # when rows were written and a bare `*` when none were, so even the default
  # request already separates the two cases. Asserted as a SHAPE rather than a
  # literal range so it does not hardcode the fixture size.
  local name="$1" want="$2" method="$3" path="$4" body="$5" tok="$6" cr half got
  local args=(-s -D - -o /dev/null -X "$method" "$API/rest/v1/$path"
      -H "apikey: $ANON" -H "Authorization: Bearer $tok"
      -H "Content-Type: application/json")
  [ -n "$body" ] && args+=(-d "$body")
  cr=$(curl "${args[@]}" | tr -d '\r' | grep -i '^content-range:' | head -1 \
       | sed 's/^[Cc]ontent-[Rr]ange:[[:space:]]*//' || true)
  half="${cr%%/*}"
  if [ "$half" = "*" ]; then got=none; else got=rows; fi
  if [ "$got" = "$want" ]; then printf '  PASS  %-58s %s\n' "$name" "Content-Range: $cr"
  else printf '  FAIL  %-58s got "%s" (%s) want %s\n' "$name" "$cr" "$got" "$want"; api_fails=$((api_fails+1)); fi
}

p2_range_written() { # name want_total METHOD path body token -- count=exact
  # Only the TOTAL after the slash, so it does not hardcode a fixture size on
  # the live side.
  local name="$1" want="$2" method="$3" path="$4" body="$5" tok="$6" cr n
  local args=(-s -D - -o /dev/null -X "$method" "$API/rest/v1/$path"
      -H "apikey: $ANON" -H "Authorization: Bearer $tok"
      -H "Content-Type: application/json" -H "Prefer: count=exact")
  [ -n "$body" ] && args+=(-d "$body")
  cr=$(curl "${args[@]}" | tr -d '\r' | grep -i '^content-range:' | head -1 \
       | sed 's/^[Cc]ontent-[Rr]ange:[[:space:]]*//' || true)
  n="${cr##*/}"
  if [ "$want" = ">=1" ]; then
    if [ "${n:-0}" -ge 1 ] 2>/dev/null
    then printf '  PASS  %-58s %s\n' "$name" "count=exact total $n (Content-Range: $cr)"; return; fi
  elif [ "$n" = "$want" ]; then
    printf '  PASS  %-58s %s\n' "$name" "count=exact total $n (Content-Range: $cr)"; return
  fi
  printf '  FAIL  %-58s got "%s" want "%s"\n' "$name" "$cr" "$want"; api_fails=$((api_fails+1))
}

# ============================================================================
# PHASE 3 (EVENTS) AT THE API SURFACE.
#
# The psql suite proves the six policies are right. This proves the same claims
# reach PostgREST -- which is a different statement, because the grant surface,
# the status codes and the row COUNT of a write all live at the transport and
# none of them is visible from psql.
#
# PLACED HERE, and the position is load-bearing: it needs p2_range_shape and
# p2_range_written (defined immediately above) and it must run while org ALPHA
# is LIVE and UNSUBSCRIBED -- the subscription block above deletes its row on
# its last line, and the suspension block below is about to soft-delete the
# organisation. Between those two is the only window where a 201 means "the
# policy allowed it" rather than "the entitlement gate happened to be open".
#
# THE PATCH-COUNT CHECK IS THE ONE THAT MATTERS. A PostgREST PATCH that changed
# NOTHING answers `204 No Content` -- byte-identical, in the status line, to one
# that changed fifteen rows. The row count is only ever in the `Content-Range`
# RESPONSE HEADER. So "manager PATCHes a BETA event" asserts 204 AND `*/0`: a
# 204 alone would pass against a policy that let the write through.
# ============================================================================
echo
echo "=== Phase 3 events at the API surface ==="

EV_ALPHA='ee110000-0000-0000-0000-000000000001'   # Alpha Manager Event
EV_BETA='ee11000b-0000-0000-0000-00000000000b'    # Beta Secret Event
EV_STD1='ee110000-0000-0000-0000-000000000002'    # Std1 Event, owned by pstd1
# T Std1 Artist -- owned by pstd1, so a record-scoped caller can read it, and
# NOT already on EV_STD1's bill. The psql suite books 4444...0001 (fixture),
# ...0002 (EF3) and ...000f (EH2) there, so any of those would meet
# event_lineup_event_artist_live_unique instead of the policy and the control
# below would be measuring the wrong refusal.
ART_STD1='444400b0-0000-0000-0000-0000000000b1'

# anon: the two tables must not be reachable logged out at all.
p2_code "anon GET events"                        401 GET  "events?select=id"
p2_code "anon GET event_lineup"                  401 GET  "event_lineup?select=id"
p2_code "anon POST events"                       401 POST "events" \
        "{\"organisation_id\":\"$ALPHA_ORG\",\"name\":\"anon\",\"starts_at\":\"2026-12-01T20:00:00Z\"}"

# Tenant boundary, aimed directly at the other tenant's org id -- the request
# an attacker actually sends, since the org id is in every URL.
p2_rows "manager GET events of org BETA (expect 0)"       0 \
        "events?select=id&organisation_id=eq.$BETA_ORG" "$MGR"
p2_rows "manager GET event_lineup of org BETA (expect 0)" 0 \
        "event_lineup?select=id&organisation_id=eq.$BETA_ORG" "$MGR"
p2_code "manager POSTs an event into org BETA"          403 POST "events" \
        "{\"organisation_id\":\"$BETA_ORG\",\"name\":\"planted\",\"starts_at\":\"2026-12-01T20:00:00Z\"}" "$MGR"
# POSITIVE CONTROL for the two zeros above: the same token, the same table,
# their own tenant. Without it a 0 is satisfied by a dead endpoint or a policy
# that denies everybody.
p2_rows "CONTROL: the same manager GETs ALPHA's Manager Event"  1 \
        "events?select=id&id=eq.$EV_ALPHA" "$MGR"

# The role matrix, over HTTP. Booker holds manage_events; read_only does not.
p2_code "booker POSTs an event (has manage_events)"     201 POST "events" \
        "{\"organisation_id\":\"$ALPHA_ORG\",\"name\":\"http booker event\",\"starts_at\":\"2026-12-02T20:00:00Z\"}" "$BKR"
p2_code "read_only POSTs an event"                      403 POST "events" \
        "{\"organisation_id\":\"$ALPHA_ORG\",\"name\":\"http ro event\",\"starts_at\":\"2026-12-03T20:00:00Z\"}" "$RO"

# The absent DELETE grant is absent at the HTTP layer too, which is the only
# place a missing grant and a denying policy look different.
p2_code "manager DELETEs an event (no DELETE grant)"    403 DELETE \
        "events?id=eq.$EV_ALPHA" "" "$MGR"
p2_code "manager DELETEs a lineup row (no DELETE grant)" 403 DELETE \
        "event_lineup?event_id=eq.$EV_ALPHA" "" "$MGR"

# RECORD SCOPE ON THE CHILD, OVER HTTP (Phase 3 Task 5). A lineup slot has no
# owner_user_id of its own -- its scope is its EVENT's -- so this is the one
# request that tells "the child inherits the parent's scope" apart from "the
# child is unscoped": pstd1 is a standard_user who owns EV_STD1 and not
# EV_ALPHA, and the row they are POSTing is perfectly well formed apart from
# whose event it names. A 403 here is event_lineup_insert_via_event's EXISTS
# failing to find an event pstd1 may write; a 201 would be a slot planted on
# somebody else's bill through a URL, with no Server Action guard in the way.
#
# 403 AND NOT 204: an INSERT policy has only WITH CHECK, so PostgREST raises
# rather than silently matching nothing. That asymmetry with PATCH is why the
# count checks above exist for the UPDATE path and not for this one.
p2_code "standard_user POSTs a lineup row on an event they do not own" 403 POST \
        "event_lineup" \
        "{\"organisation_id\":\"$ALPHA_ORG\",\"event_id\":\"$EV_ALPHA\",\"artist_id\":\"$ART_STD1\"}" "$STD"
# THE POSITIVE CONTROL, and it is mandatory here: without it the 403 above is
# satisfied by a policy that refuses pstd1 every lineup INSERT, or by a table
# nobody can write at all. Same token, same table, same body shape -- their
# OWN event, and an artist not already on that bill.
p2_code "CONTROL: ...and CAN POST one on their own event" 201 POST \
        "event_lineup" \
        "{\"organisation_id\":\"$ALPHA_ORG\",\"event_id\":\"$EV_STD1\",\"artist_id\":\"$ART_STD1\"}" "$STD"

# THE COUNT CHECK. A cross-tenant PATCH is a silent 204; only the header says
# it wrote nothing. Both spellings are asserted -- the bare request, where the
# RANGE half is `*`, and `Prefer: count=exact`, where the TOTAL is 0.
p2_code "manager PATCHes a BETA event -> silent 204, not 403"  204 PATCH \
        "events?id=eq.$EV_BETA" '{"name":"rewritten over http"}' "$MGR"
p2_range_shape "...and with NO Prefer header the range IS '*'" none PATCH \
        "events?id=eq.$EV_BETA" '{"name":"rewritten over http"}' "$MGR"
p2_range_written "...and count=exact reports the 0 the 204 hid" 0 PATCH \
        "events?id=eq.$EV_BETA" '{"name":"rewritten over http"}' "$MGR"
# THE LIVE CONTROL for the three above: the identical PATCH on their OWN
# tenant's event writes a row and says so. Without it a `*/0` is satisfied by a
# PATCH that never works for anybody.
p2_range_written "CONTROL: the same PATCH on an ALPHA event writes rows" ">=1" PATCH \
        "events?id=eq.$EV_ALPHA" '{"notes":"http control"}' "$MGR"
p2_range_shape "CONTROL: ...and its range is not '*'" rows PATCH \
        "events?id=eq.$EV_ALPHA" '{"notes":"http control"}' "$MGR"

# RECORD SCOPE, over HTTP: every event row pstd1 gets back is one pstd1 owns.
# The unowned `T Alpha Event` (rls_phase2_crm.sql § T32) is in this table and
# is exactly what a broken record-scope term would hand over.
STD_EV=$(curl -s "$API/rest/v1/events?select=id,owner_user_id" \
  -H "apikey: $ANON" -H "Authorization: Bearer $STD" \
  | python -c "
import sys,json
d=json.load(sys.stdin)
print(-1 if not isinstance(d,list) else
      '%d/%d' % (len(d), sum(1 for r in d if r['owner_user_id']!='${P2ID[pstd1]}')))")
if [ "${STD_EV#*/}" = "0" ] && [ "${STD_EV%/*}" -ge 1 ] 2>/dev/null; then
  printf '  PASS  %-58s %s\n' "standard_user GETs only events they own" "$STD_EV"
else
  printf '  FAIL  %-58s got %s want <n>=1/0\n' "standard_user GETs only events they own" "$STD_EV"
  api_fails=$((api_fails+1))
fi

OWN2=$(p2_totp_elevate "$OWN")
own2_aal=$(p2_aal "$OWN2")
if [ "$own2_aal" = "aal2" ]; then
  printf '  PASS  %-58s %s\n' "the OWNER session is genuinely aal2 (real TOTP enrol)" "$own2_aal"
else
  printf '  FAIL  %-58s got "%s" want aal2\n' \
         "the OWNER session is genuinely aal2 (real TOTP enrol)" "$own2_aal"
  api_fails=$((api_fails+1))
  echo "  (without an aal2 owner the suspension checks below measure the MFA gate," >&2
  echo "   which is review finding I-5 -- failing loudly rather than passing hollow)" >&2
fi

ALPHA_NAME=$(MSYS_NO_PATHCONV=1 docker exec "$CTR" psql -U postgres -d postgres -tAc \
  "select name from public.organisations where id='$ALPHA_ORG'" | tr -d '\r')

# ---- THE LIVE CONTROLS. Same token, same statements, organisation LIVE. -----
p2_code "LIVE CONTROL: aal2 owner POSTs a venue"           201 POST "venues" \
        "{\"organisation_id\":\"$ALPHA_ORG\",\"name\":\"live venue\"}" "$OWN2"
p2_written "LIVE CONTROL: aal2 owner PATCHes the org NAME"   1 PATCH \
        "organisations?id=eq.$ALPHA_ORG" "{\"name\":\"$ALPHA_NAME\"}" "$OWN2"
p2_written "LIVE CONTROL: aal2 owner PATCHes deleted_at=null" 1 PATCH \
        "organisations?id=eq.$ALPHA_ORG" "{\"deleted_at\":null}" "$OWN2"

live_patched=$(curl -s -X PATCH "$API/rest/v1/contacts?organisation_id=eq.$ALPHA_ORG" \
  -H "apikey: $ANON" -H "Authorization: Bearer $MGR" \
  -H "Content-Type: application/json" -H "Prefer: return=representation" \
  -d '{"title":"live patch"}' \
  | python -c "import sys,json;d=json.load(sys.stdin);print(len(d) if isinstance(d,list) else -1)")
if [ "$live_patched" -ge 1 ] 2>/dev/null; then
  printf '  PASS  %-58s %s\n' "LIVE CONTROL: manager PATCHes contacts" "$live_patched rows written"
else
  printf '  FAIL  %-58s got %s want >=1\n' "LIVE CONTROL: manager PATCHes contacts" "$live_patched"
  api_fails=$((api_fails+1))
fi
# The same write, read out of the header rather than a body (re-review I-A).
p2_range_written "LIVE CONTROL: count=exact reports the rows written" ">=1" PATCH \
        "contacts?organisation_id=eq.$ALPHA_ORG" '{"title":"live patch"}' "$MGR"
p2_range_shape "LIVE CONTROL: and with NO Prefer header the range is not '*'" rows PATCH \
        "contacts?organisation_id=eq.$ALPHA_ORG" '{"title":"live patch"}' "$MGR"

# Every count here is compared against the same request made moments earlier
# with the organisation live, so nothing is hardcoded against a fixture size.
susp_before=$(curl -s "$API/rest/v1/contacts?select=id&organisation_id=eq.$ALPHA_ORG" \
  -H "apikey: $ANON" -H "Authorization: Bearer $MGR" \
  | python -c "import sys,json;d=json.load(sys.stdin);print(len(d) if isinstance(d,list) else -1)")

p2_sub "update public.organisations set deleted_at = now() where id='$ALPHA_ORG';"

susp_after=$(curl -s "$API/rest/v1/contacts?select=id&organisation_id=eq.$ALPHA_ORG" \
  -H "apikey: $ANON" -H "Authorization: Bearer $MGR" \
  | python -c "import sys,json;d=json.load(sys.stdin);print(len(d) if isinstance(d,list) else -1)")

if [ "$susp_after" = "$susp_before" ] && [ "$susp_before" -ge 1 ] 2>/dev/null; then
  printf '  PASS  %-58s %s\n' "SUSPENDED: reads are UNCHANGED (Q6 read-only)" \
         "$susp_after of $susp_before"
else
  printf '  FAIL  %-58s got %s want %s (and >=1)\n' \
         "SUSPENDED: reads are UNCHANGED (Q6 read-only)" "$susp_after" "$susp_before"
  api_fails=$((api_fails+1))
fi

p2_code "SUSPENDED: manager POSTs a contact"    403 POST "contacts" \
        "{\"organisation_id\":\"$ALPHA_ORG\",\"name\":\"suspended contact\"}" "$MGR"
p2_code "SUSPENDED: booker POSTs an artist"     403 POST "artists" \
        "{\"organisation_id\":\"$ALPHA_ORG\",\"name\":\"suspended artist\"}" "$BKR"
# 201 LIVE (above) -> 403 SUSPENDED. The pair differs, so this line is now
# measuring suspension. With $OWN (aal1) it read 403 in both states.
p2_code "SUSPENDED: aal2 owner POSTs a venue"   403 POST "venues" \
        "{\"organisation_id\":\"$ALPHA_ORG\",\"name\":\"suspended venue\"}" "$OWN2"
# The aal1 owner is still probed, because MFA composing WITH suspension is its
# own property -- but it is LABELLED for what it is, matching P2q/P2r's wording.
p2_code "SUSPENDED: aal1 owner POSTs a venue (MFA refuses this when live too)" \
        403 POST "venues" \
        "{\"organisation_id\":\"$ALPHA_ORG\",\"name\":\"aal1 suspended venue\"}" "$OWN"

# THE SHAPE TASK 4 HAS TO HANDLE. A PATCH is refused by the USING clause, so it
# matches no rows and PostgREST answers 204 No Content -- a SILENT SUCCESS as
# far as a naive client is concerned. A save form that treats 2xx as "saved"
# will tell a suspended user their edit went through. The INSERT above is a
# loud 403; the UPDATE is not, and the difference is not cosmetic.
#
# The 204 itself is NOT new and NOT caused by Task 3a -- PostgREST answers 204
# for any PATCH matching no rows, including one at an id that does not exist and
# one aimed at another tenant. What Task 3a changed is REACHABILITY: before it,
# a suspended organisation's member could not read the record, so no edit form
# could exist to submit. Now one can.
p2_code "SUSPENDED: manager PATCHes a contact -> silent 204, not 403" 204 PATCH \
        "contacts?organisation_id=eq.$ALPHA_ORG&limit=1" \
        "{\"title\":\"suspended patch\"}" "$MGR"
# The three mechanisms, cheapest first. Re-review I-A: fix round 1 asserted only
# the third and told Task 4 it was the only one that worked.
p2_range_shape "SUSPENDED: ...and with NO Prefer header the range IS '*'" none PATCH \
        "contacts?organisation_id=eq.$ALPHA_ORG" '{"title":"suspended patch"}' "$MGR"
p2_range_written "SUSPENDED: ...and count=exact reports the 0, not the live count" 0 PATCH \
        "contacts?organisation_id=eq.$ALPHA_ORG" '{"title":"suspended patch"}' "$MGR"
p2_written "SUSPENDED: ...and return=representation shows the 0" 0 PATCH \
        "contacts?organisation_id=eq.$ALPHA_ORG" '{"title":"suspended patch"}' "$MGR"

# The Owner cannot lift their own suspension over the API either (P7), and now
# that the session is aal2 this measures P7 rather than the MFA gate: 1 row
# written LIVE, 0 rows written SUSPENDED, same token, same statement.
p2_code "SUSPENDED: aal2 owner PATCHes deleted_at -> silent 204" 204 PATCH \
        "organisations?id=eq.$ALPHA_ORG" "{\"deleted_at\":null}" "$OWN2"
p2_written "SUSPENDED: ...and 0 rows were written (LIVE wrote 1)" 0 PATCH \
        "organisations?id=eq.$ALPHA_ORG" "{\"deleted_at\":null}" "$OWN2"
p2_written "SUSPENDED: nor can the aal2 owner rename it (LIVE wrote 1)" 0 PATCH \
        "organisations?id=eq.$ALPHA_ORG" "{\"name\":\"Renamed While Suspended\"}" "$OWN2"

# THE FOUR ENDPOINTS THE ROUND-1 CENSUS MISSED (re-review M-A). Its list of
# twelve was labelled "every mutating endpoint the Phase 2 tables expose today"
# and it is sixteen. These four are the difference; they are asserted here so
# the number cannot drift back into being a claim nobody runs.
p2_range_written "SUSPENDED: PATCH artist_fee_history writes 0"     0 PATCH \
        "artist_fee_history?organisation_id=eq.$ALPHA_ORG"     '{"note":"x"}'         "$OWN2"
p2_range_written "SUSPENDED: PATCH artist_representations writes 0" 0 PATCH \
        "artist_representations?organisation_id=eq.$ALPHA_ORG" '{"territory":"x"}'    "$OWN2"
p2_range_written "SUSPENDED: PATCH contact_companies writes 0"      0 PATCH \
        "contact_companies?organisation_id=eq.$ALPHA_ORG"      '{"is_primary":false}' "$MGR"
p2_range_written "SUSPENDED: DELETE organisation_memberships writes 0" 0 DELETE \
        "organisation_memberships?organisation_id=eq.$ALPHA_ORG&role=eq.read_only" '' "$OWN2"
susp_still=$(MSYS_NO_PATHCONV=1 docker exec "$CTR" psql -U postgres -d postgres -tAc \
  "select (deleted_at is not null)::text from public.organisations where id='$ALPHA_ORG'" \
  | tr -d '[:space:]')
if [ "$susp_still" = "true" ]; then
  printf '  PASS  %-58s %s\n' "SUSPENDED: ...and deleted_at really is still set" "$susp_still"
else
  printf '  FAIL  %-58s got %s want true\n' \
         "SUSPENDED: ...and deleted_at really is still set" "$susp_still"
  api_fails=$((api_fails+1))
fi
susp_name=$(MSYS_NO_PATHCONV=1 docker exec "$CTR" psql -U postgres -d postgres -tAc \
  "select name from public.organisations where id='$ALPHA_ORG'" | tr -d '\r' | tr -d '\n')
if [ "$susp_name" = "$ALPHA_NAME" ]; then
  printf '  PASS  %-58s %s\n' "SUSPENDED: ...and the name really is unchanged" "$susp_name"
else
  printf '  FAIL  %-58s got "%s" want "%s"\n' \
         "SUSPENDED: ...and the name really is unchanged" "$susp_name" "$ALPHA_NAME"
  api_fails=$((api_fails+1))
fi

p2_sub "update public.organisations set deleted_at = null where id='$ALPHA_ORG';"
p2_code "REINSTATED: the same contact POST is allowed again" 201 POST "contacts" \
        "{\"organisation_id\":\"$ALPHA_ORG\",\"name\":\"reinstated contact\"}" "$MGR"
p2_code "REINSTATED: the same aal2 owner venue POST is allowed again" 201 POST "venues" \
        "{\"organisation_id\":\"$ALPHA_ORG\",\"name\":\"reinstated venue\"}" "$OWN2"
# The live controls for the four M-A endpoints. Without these, "writes 0 while
# suspended" is satisfied by an endpoint that writes 0 in every state.
p2_range_written "REINSTATED: PATCH artist_fee_history writes rows again"     ">=1" PATCH \
        "artist_fee_history?organisation_id=eq.$ALPHA_ORG"     '{"note":"y"}'        "$OWN2"
p2_range_written "REINSTATED: PATCH artist_representations writes rows again" ">=1" PATCH \
        "artist_representations?organisation_id=eq.$ALPHA_ORG" '{"territory":"y"}'   "$OWN2"
p2_range_written "REINSTATED: PATCH contact_companies writes rows again"      ">=1" PATCH \
        "contact_companies?organisation_id=eq.$ALPHA_ORG"      '{"is_primary":false}' "$MGR"
p2_range_written "REINSTATED: DELETE organisation_memberships writes rows again" ">=1" DELETE \
        "organisation_memberships?organisation_id=eq.$ALPHA_ORG&role=eq.read_only" '' "$OWN2"

# ---------------------------------------------------------------------------
# TASK 4. The two things the application depends on that only PostgREST can
# answer, and which the psql suite therefore cannot check.
# ---------------------------------------------------------------------------
echo
echo "-- Task 4: the write path over PostgREST --"

# 1. THE DELETED-SCOPE FILTER'S GRAMMAR.
#    lib/list/query.ts writes `.filter("deleted_at", "not.is", null)` for the
#    restore view, which becomes `deleted_at=not.is.null` on the wire. If that
#    spelling is wrong PostgREST does not error -- it returns a page, and the
#    restore queue quietly shows the wrong set. Asserted as a PAIR against the
#    live predicate, because either one alone is satisfied by a filter that
#    matches everything.
p2_sub "update public.contacts set deleted_at = now()
        where organisation_id='$ALPHA_ORG' and name='S Manager Contact';"
p2_rows "deleted_at=is.null excludes the soft-deleted contact" 0 \
  "contacts?organisation_id=eq.$ALPHA_ORG&name=eq.S%20Manager%20Contact&deleted_at=is.null" "$MGR"
p2_rows "deleted_at=not.is.null includes exactly it" 1 \
  "contacts?organisation_id=eq.$ALPHA_ORG&name=eq.S%20Manager%20Contact&deleted_at=not.is.null" "$MGR"
p2_sub "update public.contacts set deleted_at = null
        where organisation_id='$ALPHA_ORG' and name='S Manager Contact';"

# 2. THE RPC'S STATUS CODES.
#    set_contact_primary_company() raises 42501 rather than returning 0 when
#    nothing applied, specifically so the refusal arrives as a 403 the
#    application can read from the error rather than as a 200 carrying a zero.
#    That mapping is PostgREST's, not Postgres's, so it has to be measured here.
t4_rpc() { # name want_code contact company token [org]
  local name="$1" want="$2" ct="$3" co="$4" tok="$5" org="${6:-$ALPHA_ORG}" code
  code=$(curl -s -o /dev/null -w "%{http_code}" -X POST \
    "$API/rest/v1/rpc/set_contact_primary_company" \
    -H "apikey: $ANON" -H "Authorization: Bearer $tok" \
    -H "Content-Type: application/json" \
    -d "{\"p_contact_id\":\"$ct\",\"p_company_id\":$co,\"p_organisation_id\":\"$org\"}")
  if [ "$code" = "$want" ]; then printf '  PASS  %-58s %s\n' "$name" "$code"
  else printf '  FAIL  %-58s got %s want %s\n' "$name" "$code" "$want"; api_fails=$((api_fails+1)); fi
}
# The 2-arg overload, by NAME, exactly as a caller who simply omits the new
# argument would send it. PostgREST resolves an RPC by the argument names in
# the body, so leaving the old function granted would have left the unscoped
# path one missing key away. 20260828234500 drops it; this is what says so.
t4_rpc_2arg() { # name want_code contact company token
  local name="$1" want="$2" ct="$3" co="$4" tok="$5" code
  code=$(curl -s -o /dev/null -w "%{http_code}" -X POST \
    "$API/rest/v1/rpc/set_contact_primary_company" \
    -H "apikey: $ANON" -H "Authorization: Bearer $tok" \
    -H "Content-Type: application/json" \
    -d "{\"p_contact_id\":\"$ct\",\"p_company_id\":$co}")
  if [ "$code" = "$want" ]; then printf '  PASS  %-58s %s\n' "$name" "$code"
  else printf '  FAIL  %-58s got %s want %s\n' "$name" "$code" "$want"; api_fails=$((api_fails+1)); fi
}
S_CONTACT=$(MSYS_NO_PATHCONV=1 docker exec "$CTR" psql -U postgres -d postgres -tAc \
  "select id from public.contacts where organisation_id='$ALPHA_ORG'
   and name='S Std1 Contact'" | tr -d '[:space:]')
S_CO1=$(MSYS_NO_PATHCONV=1 docker exec "$CTR" psql -U postgres -d postgres -tAc \
  "select id from public.companies where organisation_id='$ALPHA_ORG'
   and name='S Co One'" | tr -d '[:space:]')
t4_rpc "LIVE CONTROL: a manager sets a primary company -> 200" 200 \
  "$S_CONTACT" "\"$S_CO1\"" "$MGR"
t4_rpc "a read_only caller is refused -> 403, not a 200 carrying 0" 403 \
  "$S_CONTACT" "\"$S_CO1\"" "$RO"
# THE WORKSPACE TERM AT THE TRANSPORT. The manager is a member of org-alpha and
# these are org-alpha's rows; only the organisation argument is wrong, and that
# alone has to refuse. Sent as a real uuid rather than a nonsense one, so the
# statement is well-formed and the 403 is the predicate rather than a parse
# error.
t4_rpc "the RIGHT rows with the WRONG organisation id -> 403" 403 \
  "$S_CONTACT" "\"$S_CO1\"" "$MGR" "$BETA_ORG"
# And the old signature is GONE, not merely ungranted: PostgREST answers 404
# (PGRST202, no function matching those argument names) rather than resolving
# the unscoped 2-arg version.
t4_rpc_2arg "omitting p_organisation_id finds NO function -> 404" 404 \
  "$S_CONTACT" "\"$S_CO1\"" "$MGR"
p2_sub "update public.organisations set deleted_at = now() where id='$ALPHA_ORG';"
t4_rpc "SUSPENDED: the manager is refused -> 403, not a silent 204" 403 \
  "$S_CONTACT" "\"$S_CO1\"" "$MGR"
susp_primary=$(MSYS_NO_PATHCONV=1 docker exec "$CTR" psql -U postgres -d postgres -tAc \
  "select count(*) from public.contact_companies
   where contact_id='$S_CONTACT' and is_primary" | tr -d '[:space:]')
if [ "$susp_primary" = "1" ]; then
  printf '  PASS  %-58s %s\n' "SUSPENDED: ...and the demote half did not commit" "$susp_primary primary"
else
  printf '  FAIL  %-58s got %s want 1\n' \
         "SUSPENDED: ...and the demote half did not commit" "$susp_primary"
  api_fails=$((api_fails+1))
fi
p2_sub "update public.organisations set deleted_at = null where id='$ALPHA_ORG';"

# ---------------------------------------------------------------------------
# TASK 4b. The three new entities and their children, at the layer the psql
# suite cannot reach.
#
# Three things only PostgREST can answer, and each has already been a real
# defect somewhere in this phase:
#
#   1. WHICH FUNCTIONS ARE PUBLISHED, and with which argument names. PostgREST
#      resolves an RPC by the NAMES in the request body, so a 2-arg variant of
#      the primary-representation function would be one missing JSON key away
#      from an unscoped write. 20260828234500 had to DROP the old
#      set_contact_primary_company(uuid,uuid) for exactly that reason. This one
#      never had a 2-arg version; the check below is what says it still does
#      not.
#   2. HOW A REFUSAL ARRIVES. The RPC raises 42501 so the refusal is a 403 the
#      application reads from the error rather than a 200 carrying a zero. That
#      mapping is PostgREST's, not Postgres's.
#   3. THE ROW COUNT ON A REFUSED PATCH. `Content-Range: */0` under
#      `Prefer: count=exact`, against a live control -- the mechanism
#      lib/crm/write.ts exists for, on the two child tables Task 4b opened.
#
# The ids are the fixture's literals (section T of rls_phase2_crm.sql), which
# is safe for the reason the whole HTTP block is safe: the preflight refuses a
# dirty database, so the psql suite has just built them.
# ---------------------------------------------------------------------------
echo
echo "-- Task 4b: artists, agencies, venues and their children over PostgREST --"

T_ARTIST='444400b0-0000-0000-0000-0000000000b1'   # T Std1 Artist  (alpha)
T_REP='888800b0-0000-0000-0000-0000000000a2'      # r2, open-ended, not primary
T_AGENCY='333300b0-0000-0000-0000-0000000000b1'   # T Agency One   (alpha)
T_VENUE='555500b0-0000-0000-0000-0000000000b2'    # T Manager Venue (alpha)
B_ARTIST='4444000b-0000-0000-0000-00000000000b'   # Beta Artist
B_VENUE='5555000b-0000-0000-0000-00000000000b'    # Beta Venue

t4b_rpc() { # name want_code artist representation token [org]
  local name="$1" want="$2" ar="$3" rep="$4" tok="$5" org="${6:-$ALPHA_ORG}" code
  code=$(curl -s -o /dev/null -w "%{http_code}" -X POST \
    "$API/rest/v1/rpc/set_artist_primary_representation" \
    -H "apikey: $ANON" -H "Authorization: Bearer $tok" \
    -H "Content-Type: application/json" \
    -d "{\"p_artist_id\":\"$ar\",\"p_representation_id\":$rep,\"p_organisation_id\":\"$org\"}")
  if [ "$code" = "$want" ]; then printf '  PASS  %-58s %s\n' "$name" "$code"
  else printf '  FAIL  %-58s got %s want %s\n' "$name" "$code" "$want"; api_fails=$((api_fails+1)); fi
}

# The 2-arg body, exactly as a caller who omits the workspace would send it.
# 20260828234500's instruction to this task was to copy the organisation term
# AND never ship an overload without it; a 404 (PGRST202, no function matching
# those argument names) is what "never shipped one" looks like from outside.
t4b_rpc_2arg() { # name want_code artist representation token
  local name="$1" want="$2" ar="$3" rep="$4" tok="$5" code
  code=$(curl -s -o /dev/null -w "%{http_code}" -X POST \
    "$API/rest/v1/rpc/set_artist_primary_representation" \
    -H "apikey: $ANON" -H "Authorization: Bearer $tok" \
    -H "Content-Type: application/json" \
    -d "{\"p_artist_id\":\"$ar\",\"p_representation_id\":$rep}")
  if [ "$code" = "$want" ]; then printf '  PASS  %-58s %s\n' "$name" "$code"
  else printf '  FAIL  %-58s got %s want %s\n' "$name" "$code" "$want"; api_fails=$((api_fails+1)); fi
}

t4b_rpc "LIVE CONTROL: a manager sets a primary representation -> 200" 200 \
  "$T_ARTIST" "\"$T_REP\"" "$MGR"
t4b_rpc "a read_only caller is refused -> 403, not a 200 carrying 0" 403 \
  "$T_ARTIST" "\"$T_REP\"" "$RO"
# THE WORKSPACE TERM AT THE TRANSPORT. The manager is a member of org-alpha and
# these are org-alpha's rows; only the organisation argument is wrong, and that
# alone has to refuse. A real uuid rather than a nonsense one, so the statement
# is well-formed and the 403 is the predicate rather than a parse error.
t4b_rpc "the RIGHT rows with the WRONG organisation id -> 403" 403 \
  "$T_ARTIST" "\"$T_REP\"" "$MGR" "$BETA_ORG"
t4b_rpc_2arg "omitting p_organisation_id finds NO function -> 404" 404 \
  "$T_ARTIST" "\"$T_REP\"" "$MGR"
# A venue_manager holds manage_contacts and manage_venues and NOT
# manage_artists -- the divergence the agency detail page asks two keys for.
t4b_rpc "a venue_manager has no manage_artists -> 403" 403 \
  "$T_ARTIST" "\"$T_REP\"" "$VNM"

# OWNER, THE ROLE THIS BLOCK NEVER EXERCISED (fix round 1, I-3; fix round 2
# corrected the token). $OWN is fetched at the top of this file for the
# Foundation suite and nothing in this block used it before fix round 1 -- a
# superset role assumed to behave like the subset roles rather than measured,
# the same shape of gap T22c already found in the psql suite.
#
# $OWN2, NOT $OWN. Fix round 1 used $OWN here and every one of these checks
# came back 403 want 201/200 -- correctly. `$OWN` is documented a few hundred
# lines up as staying aal1 ON PURPOSE ("$OWN keeps its aal1 meaning; $OWN2 is
# the elevated session"), and CLAUDE.md requires MFA for Owner: the write
# policies gate on `has_permission()`, which is aal2-gated for this role
# (20260827210000_mfa_aal_permission_gate.sql), so an aal1 Owner is refused a
# write exactly the way an aal1 Manager is not (Manager holds no MFA
# requirement). The psql half of this same fix round used `:'powner_c'`,
# which rls_phase2_crm.sql's own cast-of-characters table declares aal2 --
# the psql and HTTP halves were never actually testing the same session, and
# only the HTTP transport surfaced it. $OWN2 -- the real, TOTP-elevated
# session minted above -- is the correct token for a write CLAUDE.md requires
# MFA to perform. Six write paths, six checks, all POSITIVE CONTROLS against
# ALPHA's own fixtures: the org is not suspended and an aal2 Owner holds every
# CRM key, so 200/201 is the expected mechanism throughout.
t4b_rpc "OWNER (aal2) sets a primary representation -> 200" 200 \
  "$T_ARTIST" "\"888800b0-0000-0000-0000-0000000000a1\"" "$OWN2"
p2_code "OWNER (aal2) creates an artist (POSITIVE CONTROL)" 201 POST "artists" \
  "{\"organisation_id\":\"$ALPHA_ORG\",\"name\":\"Owner HTTP Artist\"}" "$OWN2"
p2_code "OWNER (aal2) creates an agency (POSITIVE CONTROL)" 201 POST "agencies" \
  "{\"organisation_id\":\"$ALPHA_ORG\",\"name\":\"Owner HTTP Agency\"}" "$OWN2"
p2_code "OWNER (aal2) creates a venue (POSITIVE CONTROL)" 201 POST "venues" \
  "{\"organisation_id\":\"$ALPHA_ORG\",\"name\":\"Owner HTTP Venue\"}" "$OWN2"
p2_code "OWNER (aal2) adds a venue_room (POSITIVE CONTROL)" 201 POST "venue_rooms" \
  "{\"organisation_id\":\"$ALPHA_ORG\",\"venue_id\":\"$T_VENUE\",\"name\":\"owner http room\"}" \
  "$OWN2"
p2_code "OWNER (aal2) adds an artist_representation (POSITIVE CONTROL)" 201 POST \
  "artist_representations" \
  "{\"organisation_id\":\"$ALPHA_ORG\",\"artist_id\":\"$T_ARTIST\",\"agency_id\":\"$T_AGENCY\"}" \
  "$OWN2"

# THE MISMATCHED PAIR: this workspace's organisation_id with THAT workspace's
# parent id. It is the shape that looks legitimate to a naive check ("the org
# matches my session"), it is what the composite tenant-scoped foreign keys
# from 20260828001132 exist for, and it is the request an attacker actually
# sends because both ids are in the URL bar.
p2_code "ALPHA org id + BETA artist id in artist_representations" 403 POST \
  "artist_representations" \
  "{\"organisation_id\":\"$ALPHA_ORG\",\"artist_id\":\"$B_ARTIST\",\"agency_id\":\"$T_AGENCY\"}" \
  "$MGR"
p2_code "ALPHA org id + BETA venue id in venue_rooms" 403 POST "venue_rooms" \
  "{\"organisation_id\":\"$ALPHA_ORG\",\"venue_id\":\"$B_VENUE\",\"name\":\"planted\"}" "$MGR"
# The positive controls. Without them "403 for the mismatched pair" is
# satisfied by an endpoint that 403s for everything.
p2_code "POSITIVE CONTROL: the same POST with THIS workspace's artist" 201 POST \
  "artist_representations" \
  "{\"organisation_id\":\"$ALPHA_ORG\",\"artist_id\":\"$T_ARTIST\",\"agency_id\":\"$T_AGENCY\"}" \
  "$MGR"
p2_code "POSITIVE CONTROL: the same POST with THIS workspace's venue" 201 POST \
  "venue_rooms" \
  "{\"organisation_id\":\"$ALPHA_ORG\",\"venue_id\":\"$T_VENUE\",\"name\":\"http control room\"}" \
  "$MGR"

# THE ROW COUNT ON A CHILD WHOSE PARENT IS SOFT-DELETED. 20260829001000 put
# `p.deleted_at is null` into the artist_representations and venue_rooms write
# policies, so this PATCH matches nothing -- and PostgREST answers 204 either
# way. The count is the only thing that differs, which is the whole of
# lib/crm/write.ts.
p2_range_written "LIVE CONTROL: PATCH artist_representations writes rows" ">=1" PATCH \
  "artist_representations?artist_id=eq.$T_ARTIST" '{"territory":"UK"}' "$MGR"
p2_sub "update public.artists set deleted_at = now() where id='$T_ARTIST';"
p2_code "DELETED ARTIST: the PATCH is a silent 204, not a 403" 204 PATCH \
  "artist_representations?artist_id=eq.$T_ARTIST" '{"territory":"pwned"}' "$MGR"
p2_range_written "DELETED ARTIST: ...and count=exact reports the 0" 0 PATCH \
  "artist_representations?artist_id=eq.$T_ARTIST" '{"territory":"pwned"}' "$MGR"
p2_code "DELETED ARTIST: ...while a new representation is a LOUD 403" 403 POST \
  "artist_representations" \
  "{\"organisation_id\":\"$ALPHA_ORG\",\"artist_id\":\"$T_ARTIST\",\"agency_id\":\"$T_AGENCY\"}" \
  "$MGR"
p2_sub "update public.artists set deleted_at = null where id='$T_ARTIST';"
p2_range_written "RESTORED: the same PATCH writes rows again" ">=1" PATCH \
  "artist_representations?artist_id=eq.$T_ARTIST" '{"territory":"UK"}' "$MGR"

p2_range_written "LIVE CONTROL: PATCH venue_rooms writes rows" ">=1" PATCH \
  "venue_rooms?venue_id=eq.$T_VENUE" '{"name":"http renamed"}' "$MGR"
p2_sub "update public.venues set deleted_at = now() where id='$T_VENUE';"
p2_range_written "DELETED VENUE: ...and count=exact reports the 0" 0 PATCH \
  "venue_rooms?venue_id=eq.$T_VENUE" '{"name":"pwned"}' "$MGR"
p2_sub "update public.venues set deleted_at = null where id='$T_VENUE';"
p2_range_written "RESTORED: the same PATCH writes rows again" ">=1" PATCH \
  "venue_rooms?venue_id=eq.$T_VENUE" '{"name":"http renamed"}' "$MGR"

# The three new tables have NO DELETE grant. A missing grant and a denying
# policy look different only at this layer -- 403 with no Content-Range at all.
p2_code "manager DELETEs an artist (no DELETE grant)" 403 DELETE \
  "artists?id=eq.$T_ARTIST" "" "$MGR"
p2_code "manager DELETEs a venue_room (no DELETE grant)" 403 DELETE \
  "venue_rooms?venue_id=eq.$T_VENUE" "" "$MGR"
p2_code "manager DELETEs an artist_representation (no DELETE grant)" 403 DELETE \
  "artist_representations?artist_id=eq.$T_ARTIST" "" "$MGR"

# The RPC under suspension: a 403 rather than a silent 204, and the demote half
# must not have committed on its own.
p2_sub "update public.organisations set deleted_at = now() where id='$ALPHA_ORG';"
t4b_rpc "SUSPENDED: the manager is refused -> 403, not a silent 204" 403 \
  "$T_ARTIST" "\"$T_REP\"" "$MGR"
t4b_susp=$(MSYS_NO_PATHCONV=1 docker exec "$CTR" psql -U postgres -d postgres -tAc \
  "select count(*) from public.artist_representations
   where artist_id='$T_ARTIST' and is_primary and ended_at is null
     and deleted_at is null" | tr -d '[:space:]')
if [ "$t4b_susp" = "1" ]; then
  printf '  PASS  %-58s %s\n' "SUSPENDED: ...and the demote half did not commit" "$t4b_susp primary"
else
  printf '  FAIL  %-58s got %s want 1\n' \
         "SUSPENDED: ...and the demote half did not commit" "$t4b_susp"
  api_fails=$((api_fails+1))
fi
p2_sub "update public.organisations set deleted_at = null where id='$ALPHA_ORG';"


echo
echo "=== Custom fields: the tier limit at the API surface (Task 5) ==="
#
# THE POINT OF THIS BLOCK. CLAUDE.md § Permissions: "Entitlements are enforced
# server-side -- hiding UI is not enforcement", and the anon key ships in the
# browser bundle by design. So a Server Action that counts definitions before
# inserting is not the control; these requests never touch the Next.js app.
# The psql section U drives the same trigger through `authenticated` + claims,
# which is the same mechanism -- this is the same rule at the TRANSPORT, and
# this phase has twice found a defect that only the HTTP layer showed.
#
# `company` is the entity type used throughout: the psql suite defines fields
# on artist, contact and venue in org-alpha and none on company, so the
# starting count is zero and every number below is this block's own.

cf_start=$(MSYS_NO_PATHCONV=1 docker exec "$CTR" psql -U postgres -d postgres -tAc \
  "select count(*) from public.custom_field_definitions
    where organisation_id='$ALPHA_ORG' and entity_type='company'" | tr -d '[:space:]')
if [ "$cf_start" = "0" ]; then
  printf '  PASS  %-58s %s\n' "company custom fields start at zero (non-vacuous)" "$cf_start"
else
  printf '  FAIL  %-58s got %s want 0\n' \
         "company custom fields start at zero (non-vacuous)" "$cf_start"
  api_fails=$((api_fails+1))
fi

# Starter: custom_field_limit = 5, per entity type. Written with psql because
# organisation_subscriptions is superuser-only over the API by design
# (Foundation design note (g): an org-scoped write path there is a free
# upgrade to Pro).
p2_sub "insert into public.organisation_subscriptions
          (organisation_id, plan_id, billing_cycle, seat_count, status, current_period_end)
        values ('$ALPHA_ORG','starter','monthly',1,'active', now() + interval '30 days')
        on conflict (organisation_id) do update set plan_id='starter', status='active',
          current_period_end = now() + interval '30 days';"

# The allowance, in one request. PostgREST accepts a JSON array, which is one
# INSERT statement with five rows.
p2_code "STARTER: the aal2 OWNER POSTs the five it allows" 201 POST \
  "custom_field_definitions" \
  "[{\"organisation_id\":\"$ALPHA_ORG\",\"entity_type\":\"company\",\"key\":\"h1\",\"label\":\"H1\",\"field_type\":\"text\"},
    {\"organisation_id\":\"$ALPHA_ORG\",\"entity_type\":\"company\",\"key\":\"h2\",\"label\":\"H2\",\"field_type\":\"number\"},
    {\"organisation_id\":\"$ALPHA_ORG\",\"entity_type\":\"company\",\"key\":\"h3\",\"label\":\"H3\",\"field_type\":\"date\"},
    {\"organisation_id\":\"$ALPHA_ORG\",\"entity_type\":\"company\",\"key\":\"h4\",\"label\":\"H4\",\"field_type\":\"boolean\"},
    {\"organisation_id\":\"$ALPHA_ORG\",\"entity_type\":\"company\",\"key\":\"h5\",\"label\":\"H5\",\"field_type\":\"url\"}]" \
  "$OWN2"

# THE ASSERTION THE WHOLE TASK TURNS ON: a direct PostgREST insert past the
# limit, with the public anon key and a real session, is refused by the
# DATABASE.
p2_code "STARTER: the SIXTH is refused by the database, not by the app" 403 POST \
  "custom_field_definitions" \
  "{\"organisation_id\":\"$ALPHA_ORG\",\"entity_type\":\"company\",\"key\":\"h6\",\"label\":\"H6\",\"field_type\":\"text\"}" \
  "$OWN2"

# A BULK POST IS ONE STATEMENT, AND A BEFORE ROW TRIGGER COUNTING ITS OWN
# TABLE COULD PLAUSIBLY NOT SEE THE ROWS THE SAME STATEMENT ALREADY INSERTED --
# which would make an array the bypass. MEASURED RATHER THAN REASONED ABOUT:
# eight rows in one request against a limit of five is refused, so the count a
# BEFORE trigger sees does include the statement's earlier rows.
p2_code "an ARRAY of six in ONE request is refused too (no bulk bypass)" 403 POST \
  "custom_field_definitions" \
  "[{\"organisation_id\":\"$ALPHA_ORG\",\"entity_type\":\"agency\",\"key\":\"b1\",\"label\":\"B1\",\"field_type\":\"text\"},
    {\"organisation_id\":\"$ALPHA_ORG\",\"entity_type\":\"agency\",\"key\":\"b2\",\"label\":\"B2\",\"field_type\":\"text\"},
    {\"organisation_id\":\"$ALPHA_ORG\",\"entity_type\":\"agency\",\"key\":\"b3\",\"label\":\"B3\",\"field_type\":\"text\"},
    {\"organisation_id\":\"$ALPHA_ORG\",\"entity_type\":\"agency\",\"key\":\"b4\",\"label\":\"B4\",\"field_type\":\"text\"},
    {\"organisation_id\":\"$ALPHA_ORG\",\"entity_type\":\"agency\",\"key\":\"b5\",\"label\":\"B5\",\"field_type\":\"text\"},
    {\"organisation_id\":\"$ALPHA_ORG\",\"entity_type\":\"agency\",\"key\":\"b6\",\"label\":\"B6\",\"field_type\":\"text\"}]" \
  "$OWN2"

# PER ENTITY TYPE. Without this, the 403 above is satisfied by a limit that is
# simply wrong -- and CLAUDE.md § Subscription tiers is explicit that Starter
# gets five on contacts AND five on companies.
p2_code "POSITIVE CONTROL: an AGENCY field still fits -- the limit is per type" 201 POST \
  "custom_field_definitions" \
  "{\"organisation_id\":\"$ALPHA_ORG\",\"entity_type\":\"agency\",\"key\":\"b1\",\"label\":\"B1\",\"field_type\":\"text\"}" \
  "$OWN2"

# THE SOFT DELETE, over HTTP. There is no DELETE grant on this table -- the
# composite FK's cascade would take every value with it -- so removing a field
# is a PATCH, and the row count is the only honest signal that it applied.
p2_range_written "removing a field is a PATCH of deleted_at, and writes a row" 1 PATCH \
  "custom_field_definitions?organisation_id=eq.$ALPHA_ORG&entity_type=eq.company&key=eq.h5" \
  "{\"deleted_at\":\"2026-08-29T00:00:00Z\"}" "$OWN2"
p2_code "a hard DELETE is refused -- no grant, so the cascade is unreachable" 403 DELETE \
  "custom_field_definitions?organisation_id=eq.$ALPHA_ORG&entity_type=eq.company&key=eq.h5" \
  "" "$OWN2"

# FOUNDER DECISION Q12, at the transport: a removed definition frees its slot.
p2_code "Q12: the removed field freed its slot, so the sixth now fits" 201 POST \
  "custom_field_definitions" \
  "{\"organisation_id\":\"$ALPHA_ORG\",\"entity_type\":\"company\",\"key\":\"h6\",\"label\":\"H6\",\"field_type\":\"text\"}" \
  "$OWN2"
# ...and the other half: RESTORING it is a slot-consuming write, which is why
# the limit is a trigger and not a WITH CHECK -- a WITH CHECK cannot see OLD.
#
# A LOUD 403, NOT A SILENT 204, AND THIS WAS MEASURED RATHER THAN ASSUMED. The
# first version of this check used p2_range_written expecting a row count of 0,
# on the reasoning that "an UPDATE a policy refuses matches nothing" -- the rule
# lib/crm/write.ts exists for. It came back with NO Content-Range header at all,
# because this refusal is not a policy filtering rows: the trigger RAISES 42501,
# which PostgREST answers 403. The distinction matters to the client -- one is a
# silent no-op and the other is an error -- so it is asserted as the mechanism it
# actually is.
p2_code "restoring it is refused -- the freed slot is taken (a LOUD 403)" 403 PATCH \
  "custom_field_definitions?organisation_id=eq.$ALPHA_ORG&entity_type=eq.company&key=eq.h5" \
  "{\"deleted_at\":null}" "$OWN2"

# AT THE LIMIT, EVERYTHING THAT IS NOT A COUNT INCREASE STILL WORKS. This is
# the over-limit/at-limit state a downgrade produces, and CLAUDE.md is explicit
# that it must be limited rather than broken.
p2_range_written "AT THE LIMIT: an ordinary label edit still applies" 1 PATCH \
  "custom_field_definitions?organisation_id=eq.$ALPHA_ORG&entity_type=eq.company&key=eq.h1" \
  '{"label":"Renamed at the limit"}' "$OWN2"

# I-1: entity_type IS IMMUTABLE, AT THE TRANSPORT AND WITH THE ANON KEY.
#
# The limit trigger returns early on every UPDATE of a live row, so before
# 20260829012000 a PATCH could move a definition into another per-type bucket
# with no slot check at all: five on each of five types, then all 25 PATCHed to
# entity_type=contact, on a plan whose limit is 5. Reproduced in psql before the
# fix (UPDATE 5, then contact | 10). This is the same request over HTTP.
#
# 403 rather than a silent 204: the refusal is the UPDATE policy's WITH CHECK,
# which raises 42501, not a USING clause filtering rows to nothing. Measured,
# and it is the distinction lib/crm/write.ts exists to keep straight.
p2_code "I-1: PATCHing entity_type is refused (a LOUD 403)" 403 PATCH \
  "custom_field_definitions?organisation_id=eq.$ALPHA_ORG&entity_type=eq.company&key=eq.h1" \
  '{"entity_type":"venue"}' "$OWN2"
# The whole-bucket form, which is the request an attacker actually sends.
p2_code "I-1: the whole-bucket re-type is refused too" 403 PATCH \
  "custom_field_definitions?organisation_id=eq.$ALPHA_ORG&entity_type=eq.company" \
  '{"entity_type":"venue"}' "$OWN2"
# ...and nothing moved. A 403 with rows already written would be worse than no
# check at all, so the count is read back out of the database rather than
# inferred from the status code.
#
# SIX, NOT FIVE, AND `deleted_at` IS DELIBERATELY NOT FILTERED. This block has
# created h1-h4 and h6 live plus h5 removed -- six rows, five of them live. The
# invariant is that no row LEFT the company bucket, and a re-typed row leaves it
# whether it is live or removed, so filtering the removed one out would stop
# measuring half of what the PATCH could have moved. The first version of this
# check expected 5 and failed against 6: the check was right and the expectation
# was wrong.
cf_types=$(MSYS_NO_PATHCONV=1 docker exec "$CTR" psql -U postgres -d postgres -tAc \
  "select count(*) from public.custom_field_definitions
    where organisation_id='$ALPHA_ORG' and entity_type='company'" | tr -d '[:space:]')
if [ "$cf_types" = "6" ]; then
  printf '  PASS  %-58s %s\n' "I-1: ...and all six company definitions stayed put" "$cf_types"
else
  printf '  FAIL  %-58s got %s want 6\n' \
         "I-1: ...and all six company definitions stayed put" "$cf_types"
  api_fails=$((api_fails+1))
fi
# POSITIVE CONTROL: the same row, the same verb, entity_type left alone. Without
# it, "the PATCH is refused" is satisfied by a policy that refuses every UPDATE
# -- which would break the downgrade rule the check above this one asserts.
p2_range_written "I-1 POSITIVE CONTROL: the same row PATCHes label fine" 1 PATCH \
  "custom_field_definitions?organisation_id=eq.$ALPHA_ORG&entity_type=eq.company&key=eq.h1" \
  '{"label":"Renamed again"}' "$OWN2"

# THE PERMISSION SPLIT. manage_custom_fields is Owner/Admin only; a Manager
# holds every other CRM key and not this one, and a Read Only user holds none.
p2_code "a MANAGER cannot define a field (manage_custom_fields: no)" 403 POST \
  "custom_field_definitions" \
  "{\"organisation_id\":\"$ALPHA_ORG\",\"entity_type\":\"venue\",\"key\":\"mgr\",\"label\":\"Mgr\",\"field_type\":\"text\"}" \
  "$MGR"
p2_code "a READ_ONLY caller cannot either" 403 POST \
  "custom_field_definitions" \
  "{\"organisation_id\":\"$ALPHA_ORG\",\"entity_type\":\"venue\",\"key\":\"ro\",\"label\":\"RO\",\"field_type\":\"text\"}" \
  "$RO"
# ...but a MANAGER CAN read them, because a definition is not a record: it is
# the label and type that make a value renderable, and withholding it would
# leave a Standard User looking at values with no field names.
cf_read=$(curl -s "$API/rest/v1/custom_field_definitions?select=id&organisation_id=eq.$ALPHA_ORG&entity_type=eq.company" \
  -H "apikey: $ANON" -H "Authorization: Bearer $MGR" \
  | python -c "import sys,json;d=json.load(sys.stdin);print(len(d) if isinstance(d,list) else -1)")
if [ "$cf_read" -ge 5 ] 2>/dev/null; then
  printf '  PASS  %-58s %s\n' "a manager READS every definition (view_crm)" "$cf_read"
else
  printf '  FAIL  %-58s got %s want >=5\n' \
         "a manager READS every definition (view_crm)" "$cf_read"
  api_fails=$((api_fails+1))
fi

# THE OPTIONS CONTRACT, enforced by a CHECK constraint rather than only in
# TypeScript: a select field whose options are not [{key,label}] would render
# an input the entity form cannot build, in a table the form has no choice but
# to read. 400 rather than 403 -- it is a constraint violation, not a refusal.
p2_code "malformed select OPTIONS are refused by the constraint (400)" 400 POST \
  "custom_field_definitions" \
  "{\"organisation_id\":\"$ALPHA_ORG\",\"entity_type\":\"venue\",\"key\":\"badopts\",\"label\":\"Bad\",\"field_type\":\"single_select\",\"options\":[1,2,3]}" \
  "$OWN2"
p2_code "POSITIVE CONTROL: well-formed options are accepted" 201 POST \
  "custom_field_definitions" \
  "{\"organisation_id\":\"$ALPHA_ORG\",\"entity_type\":\"venue\",\"key\":\"goodopts\",\"label\":\"Good\",\"field_type\":\"single_select\",\"options\":[{\"key\":\"a\",\"label\":\"Alpha\"}]}" \
  "$OWN2"

# FREE. Its custom_field_limit is 0, and CLAUDE.md also gives it crm_writes =
# No -- so both controls refuse and the request is closed either way. The READ
# stays open, because a downgrade must never hide a customer's existing data.
p2_sub "update public.organisation_subscriptions set plan_id='free'
        where organisation_id='$ALPHA_ORG';"
p2_code "FREE: no custom fields at all -- the sixth company field is refused" 403 POST \
  "custom_field_definitions" \
  "{\"organisation_id\":\"$ALPHA_ORG\",\"entity_type\":\"company\",\"key\":\"free1\",\"label\":\"Free\",\"field_type\":\"text\"}" \
  "$OWN2"
cf_free=$(curl -s "$API/rest/v1/custom_field_definitions?select=id&organisation_id=eq.$ALPHA_ORG&entity_type=eq.company" \
  -H "apikey: $ANON" -H "Authorization: Bearer $OWN2" \
  | python -c "import sys,json;d=json.load(sys.stdin);print(len(d) if isinstance(d,list) else -1)")
if [ "$cf_free" -ge 5 ] 2>/dev/null; then
  printf '  PASS  %-58s %s\n' "FREE: the fields it already has stay readable" "$cf_free"
else
  printf '  FAIL  %-58s got %s want >=5\n' \
         "FREE: the fields it already has stay readable" "$cf_free"
  api_fails=$((api_fails+1))
fi

# Restore the shipped state: no subscription row, so the gate is inert again --
# the same clean-up the entitlement block above performs for the same reason.
p2_sub "delete from public.organisation_subscriptions where organisation_id='$ALPHA_ORG';"

echo
echo "=== Custom field VALUES at the API surface (Task 5) ==="
#
# The RPC is what the panel calls, and it is the one write in this task that
# cannot be a single statement -- a form with six fields would otherwise be six
# PostgREST requests and could half-save. p_organisation_id is mandatory and
# there is no overload without it (20260828234500): PostgREST resolves by
# ARGUMENT NAME, so an unscoped variant would be one omitted key away.

CF_TEXT=$(MSYS_NO_PATHCONV=1 docker exec "$CTR" psql -U postgres -d postgres -tAc \
  "select id from public.custom_field_definitions
    where organisation_id='$ALPHA_ORG' and entity_type='company' and key='h1'" | tr -d '[:space:]')
H_COMPANY=$(MSYS_NO_PATHCONV=1 docker exec "$CTR" psql -U postgres -d postgres -tAc \
  "select id from public.companies
    where organisation_id='$ALPHA_ORG' and deleted_at is null limit 1" | tr -d '[:space:]')

cf_rpc() { # name want_http org entity_type entity_id values_json token
  local name="$1" want="$2" org="$3" et="$4" eid="$5" vals="$6" tok="$7" code
  code=$(curl -s -o /dev/null -w "%{http_code}" -X POST \
    "$API/rest/v1/rpc/set_custom_field_values" \
    -H "apikey: $ANON" -H "Authorization: Bearer $tok" \
    -H "Content-Type: application/json" \
    -d "{\"p_organisation_id\":$org,\"p_entity_type\":\"$et\",\"p_entity_id\":\"$eid\",\"p_values\":$vals}")
  if [ "$code" = "$want" ]; then printf '  PASS  %-58s %s\n' "$name" "$code"
  else printf '  FAIL  %-58s got %s want %s\n' "$name" "$code" "$want"; api_fails=$((api_fails+1)); fi
}

cf_rpc "LIVE CONTROL: a manager saves a value through the RPC" 200 \
  "\"$ALPHA_ORG\"" company "$H_COMPANY" "{\"$CF_TEXT\":\"filled in\"}" "$MGR"
# THE WORKSPACE TERM. RLS answers "may this caller write this row"; the
# organisation argument answers "is this row the one this URL is about", and
# for a multi-org member those diverge. A real uuid, so the statement is
# well-formed and the refusal is the predicate rather than a parse error.
cf_rpc "the RIGHT rows with the WRONG organisation id -> refused" 403 \
  "\"$BETA_ORG\"" company "$H_COMPANY" "{\"$CF_TEXT\":\"wrong workspace\"}" "$MGR"
cf_rpc "a read_only caller is refused -> 403, not a 200 carrying 0" 403 \
  "\"$ALPHA_ORG\"" company "$H_COMPANY" "{\"$CF_TEXT\":\"read only\"}" "$RO"
# JSON null IS THE CLEAR INSTRUCTION, and it is never stored: clearing deletes
# the row, so SQL NULL and jsonb 'null' are both unreachable through this path.
cf_rpc "JSON null in the payload CLEARS the value" 200 \
  "\"$ALPHA_ORG\"" company "$H_COMPANY" "{\"$CF_TEXT\":null}" "$MGR"
cf_cleared=$(MSYS_NO_PATHCONV=1 docker exec "$CTR" psql -U postgres -d postgres -tAc \
  "select count(*) from public.custom_field_values where field_id='$CF_TEXT'" | tr -d '[:space:]')
if [ "$cf_cleared" = "0" ]; then
  printf '  PASS  %-58s %s\n' "...and the ROW is gone, not set to null" "$cf_cleared rows"
else
  printf '  FAIL  %-58s got %s want 0\n' "...and the ROW is gone, not set to null" "$cf_cleared"
  api_fails=$((api_fails+1))
fi

# Omitting the organisation finds NO function at all, rather than an unscoped
# one. There is deliberately no 3-argument overload to fall back to.
code=$(curl -s -o /dev/null -w "%{http_code}" -X POST \
  "$API/rest/v1/rpc/set_custom_field_values" \
  -H "apikey: $ANON" -H "Authorization: Bearer $MGR" -H "Content-Type: application/json" \
  -d "{\"p_entity_type\":\"company\",\"p_entity_id\":\"$H_COMPANY\",\"p_values\":{}}")
if [ "$code" = "404" ]; then
  printf '  PASS  %-58s %s\n' "omitting p_organisation_id finds NO function" "$code"
else
  printf '  FAIL  %-58s got %s want 404\n' "omitting p_organisation_id finds NO function" "$code"
  api_fails=$((api_fails+1))
fi

# A DELETED PARENT. 20260829011000 puts private.entity_is_live() into the three
# custom_field_values WRITE policies and deliberately not into the SELECT one:
# a deleted record's page still has to render, because that is the restore path.
p2_sub "update public.companies set deleted_at = now() where id='$H_COMPANY';"
cf_rpc "DELETED COMPANY: the RPC refuses -- the DB backs the parent end" 403 \
  "\"$ALPHA_ORG\"" company "$H_COMPANY" "{\"$CF_TEXT\":\"while deleted\"}" "$MGR"
p2_sub "update public.companies set deleted_at = null where id='$H_COMPANY';"
cf_rpc "RESTORED: the same save applies again" 200 \
  "\"$ALPHA_ORG\"" company "$H_COMPANY" "{\"$CF_TEXT\":\"after restore\"}" "$MGR"

# A SUSPENDED WORKSPACE is READ-ONLY (founder decision Q6), and the read half
# is what makes it read-only rather than closed.
p2_sub "update public.organisations set deleted_at = now() where id='$ALPHA_ORG';"
cf_rpc "SUSPENDED: the RPC refuses -> 403, not a silent 200" 403 \
  "\"$ALPHA_ORG\"" company "$H_COMPANY" "{\"$CF_TEXT\":\"suspended\"}" "$MGR"
cf_susp=$(curl -s "$API/rest/v1/custom_field_values?select=id&organisation_id=eq.$ALPHA_ORG" \
  -H "apikey: $ANON" -H "Authorization: Bearer $MGR" \
  | python -c "import sys,json;d=json.load(sys.stdin);print(len(d) if isinstance(d,list) else -1)")
if [ "$cf_susp" -ge 1 ] 2>/dev/null; then
  printf '  PASS  %-58s %s\n' "SUSPENDED: values are still READABLE" "$cf_susp"
else
  printf '  FAIL  %-58s got %s want >=1\n' "SUSPENDED: values are still READABLE" "$cf_susp"
  api_fails=$((api_fails+1))
fi
p2_sub "update public.organisations set deleted_at = null where id='$ALPHA_ORG';"
cf_rpc "REINSTATED: the same save applies again (positive control)" 200 \
  "\"$ALPHA_ORG\"" company "$H_COMPANY" "{\"$CF_TEXT\":\"reinstated\"}" "$MGR"


# ----------------------------------------------------------------------------
# DEDUP AND MERGE AT THE API SURFACE (Task 6)
#
# The psql suite proves the policies and the function bodies. What only HTTP can
# prove is which of these functions PostgREST publishes: private.duplicate_probe
# is the one that returns rows outside the caller's record scope, and schema
# placement is the entire control on it -- the same defect class the block at
# the top of this section exists for.
#
# Its own organisation, because the psql § W fixtures have already been merged
# and dismissed by the time this runs, and a merge is not idempotent.
# ----------------------------------------------------------------------------
echo
echo "=== Dedup and merge at the API surface (Task 6) ==="

MERGE_ORG="b0b00000-0000-0000-0000-00000000000b"
HM_W="4d0000ff-0000-0000-0000-000000000001"   # older -> the winner
HM_L="4d0000ff-0000-0000-0000-000000000002"   # newer -> the loser
HM_N="4d0000ff-0000-0000-0000-000000000003"   # a fuzzy-name match, pstd1's
# The OWNER's own pair. Separate records, because the aal1 refusal and the aal2
# success have to be the SAME caller on the SAME pair to be a controlled pair,
# and a merge consumes the pair it runs on -- so it cannot be the one the
# manager's positive control at the bottom needs. Named nothing like "Ines", so
# they do not turn up in the fuzzy screening the checks above count.
HM_OW="4d0000ff-0000-0000-0000-000000000004"  # older -> the Owner's winner
HM_OL="4d0000ff-0000-0000-0000-000000000005"  # newer -> the Owner's loser

p2_sub "insert into public.organisations (id, name, slug)
        values ('$MERGE_ORG','Org HTTP Merge','org-http-merge')
        on conflict (id) do nothing;
        insert into public.organisation_memberships
          (organisation_id, user_id, role, status, joined_at)
        values ('$MERGE_ORG','${P2ID[pmanager]}','manager','active',now()),
               ('$MERGE_ORG','${P2ID[powner]}','owner','active',now()),
               ('$MERGE_ORG','${P2ID[pstd1]}','standard_user','active',now()),
               ('$MERGE_ORG','${P2ID[pro]}','read_only','active',now())
        on conflict do nothing;
        insert into public.contacts
          (id, organisation_id, owner_user_id, name, email, created_at)
        values ('$HM_W','$MERGE_ORG','${P2ID[pmanager]}','Ines Duarte',
                'INES@http.test', now() - interval '2 days'),
               ('$HM_L','$MERGE_ORG','${P2ID[pmanager]}','Ines Duarte',
                'ines@http.test', now()),
               ('$HM_N','$MERGE_ORG','${P2ID[pstd1]}','Ines Duart', null, now()),
               ('$HM_OW','$MERGE_ORG','${P2ID[powner]}','Bella Nkemelu',
                null, now() - interval '2 days'),
               ('$HM_OL','$MERGE_ORG','${P2ID[powner]}','Bella Nkemelu',
                null, now())
        on conflict (id) do nothing;"

# SCHEMA PLACEMENT. The unscoped probe is the function that would hand a
# record-scoped user every row in their organisation; it lives in `private` and
# has no grant, and this is the layer where that is visible.
probe "private helper duplicate_probe not an RPC"     404 "rpc/duplicate_probe"
probe "private helper duplicate_matches not an RPC"   404 "rpc/duplicate_matches"
probe "private helper record_merge not an RPC"        404 "rpc/record_merge"
probe "private helper dedup_entity_table not an RPC"  404 "rpc/dedup_entity_table"

# The two that ARE endpoints, and the no-overload rule: PostgREST resolves by
# argument name, so a call missing p_organisation_id must find NO function
# rather than an unscoped variant.
p2_code "screen_for_duplicates IS routable and screens"  200 POST "rpc/screen_for_duplicates" \
        "{\"p_organisation_id\":\"$MERGE_ORG\",\"p_entity_type\":\"contact\",\"p_entity_id\":\"$HM_L\"}" "$MGR"
p2_code "screen_for_duplicates without p_organisation_id finds NO function" 404 POST \
        "rpc/screen_for_duplicates" \
        "{\"p_entity_type\":\"contact\",\"p_entity_id\":\"$HM_L\"}" "$MGR"
p2_code "merge_records without p_organisation_id finds NO function" 404 POST \
        "rpc/merge_records" \
        "{\"p_entity_type\":\"contact\",\"p_winner_id\":\"$HM_W\",\"p_loser_id\":\"$HM_L\"}" "$MGR"

# The queue is readable over HTTP and NOT writable: no INSERT grant, no INSERT
# policy, one definer writer.
hm_q=$(curl -s "$API/rest/v1/merge_candidates?select=id,reason&organisation_id=eq.$MERGE_ORG" \
  -H "apikey: $ANON" -H "Authorization: Bearer $MGR" \
  | python -c "import sys,json;d=json.load(sys.stdin);print(len(d) if isinstance(d,list) else -1)")
if [ "$hm_q" = "2" ]; then
  printf '  PASS  %-58s %s\n' "screening flagged both pairs into the queue" "$hm_q"
else
  printf '  FAIL  %-58s got %s want 2\n' "screening flagged both pairs into the queue" "$hm_q"
  api_fails=$((api_fails+1))
fi
p2_code "manager POSTs a merge_candidates row (no INSERT grant)" 403 POST "merge_candidates" \
        "{\"organisation_id\":\"$MERGE_ORG\",\"entity_type\":\"contact\",\"keep_id\":\"$HM_W\",\"duplicate_id\":\"$HM_L\",\"label\":\"x\",\"reason\":\"fuzzy_name\"}" "$MGR"
p2_code "manager POSTs a merges row (no INSERT grant since Task 6)" 403 POST "merges" \
        "{\"organisation_id\":\"$MERGE_ORG\",\"entity_type\":\"contact\",\"winner_id\":\"$HM_W\",\"loser_id\":\"$HM_L\",\"merged_by\":\"${P2ID[pmanager]}\"}" "$MGR"

# A 204 IS NOT A SAVE. read_only holds no merge_records, so the UPDATE policy
# filters the row out and PostgREST answers 204 with a row count of ZERO -- the
# same status a real dismissal returns. Only Content-Range separates them, which
# is why lib/crm/write.ts sends Prefer: count=exact on every mutation.
hm_range() { # name want_range method path body token
  local name="$1" want="$2" method="$3" path="$4" body="$5" tok="$6" range
  range=$(curl -s -D - -o /dev/null -X "$method" "$API/rest/v1/$path" \
    -H "apikey: $ANON" -H "Authorization: Bearer $tok" \
    -H "Content-Type: application/json" -H "Prefer: count=exact" \
    ${body:+-d "$body"} | tr -d '\r' | awk 'tolower($1)=="content-range:"{print $2}')
  if [ "$range" = "$want" ]; then printf '  PASS  %-58s %s\n' "$name" "$range"
  else printf '  FAIL  %-58s got %s want %s\n' "$name" "${range:-none}" "$want"; api_fails=$((api_fails+1)); fi
}

HM_CAND=$(MSYS_NO_PATHCONV=1 docker exec "$CTR" psql -U postgres -d postgres -tAc \
  "select id from public.merge_candidates
    where organisation_id='$MERGE_ORG' and duplicate_id='$HM_N'" | tr -d '[:space:]')

hm_range "read_only dismisses a candidate: 204 carrying ZERO" "*/0" PATCH \
  "merge_candidates?id=eq.$HM_CAND" \
  "{\"deleted_at\":\"2026-08-29T00:00:00Z\",\"resolution\":\"dismissed\",\"resolved_by\":\"${P2ID[pro]}\"}" "$RO"
# `0-0/1`, not `*/1`: a PATCH reports a real range and a DELETE reports `*`.
# That asymmetry is recorded in lib/crm/write.ts's header as the trap in reading
# the range rather than the count, and this is it in the suite.
hm_range "manager dismisses the same candidate: 204 carrying ONE" "0-0/1" PATCH \
  "merge_candidates?id=eq.$HM_CAND" \
  "{\"deleted_at\":\"2026-08-29T00:00:00Z\",\"resolution\":\"dismissed\",\"resolved_by\":\"${P2ID[pmanager]}\"}" "$MGR"

# THE MERGE, over HTTP, by every role that matters.
p2_code "read_only merges (no merge_records)"           403 POST "rpc/merge_records" \
        "{\"p_organisation_id\":\"$MERGE_ORG\",\"p_entity_type\":\"contact\",\"p_winner_id\":\"$HM_W\",\"p_loser_id\":\"$HM_L\"}" "$RO"
p2_code "standard_user merges (no merge_records)"       403 POST "rpc/merge_records" \
        "{\"p_organisation_id\":\"$MERGE_ORG\",\"p_entity_type\":\"contact\",\"p_winner_id\":\"$HM_W\",\"p_loser_id\":\"$HM_L\"}" "$STD"
# ----------------------------------------------------------------------------
# THE OWNER, AT BOTH ASSURANCE LEVELS, ON THE SAME PAIR.
#
# Review finding I-2 was that this block carried the comment "$OWN2, NOT $OWN
# ... the check would pass for the wrong reason" above a check that then passed
# $OWN -- so the only Owner check in the whole Task 6 block was an aal1 refusal
# under a header describing an aal2 one, and nothing anywhere proved an Owner
# can merge at all. The rule the brief states is that Owner over HTTP uses
# $OWN2; the rule this file lives by is that a comment describes what the line
# under it does.
#
# So both are here, and they are a CONTROLLED PAIR: same user, same two records,
# same request body, and the only difference is the assurance level of the
# token. That is what makes the 403 attributable to the aal gate rather than to
# a merge that refuses everybody -- which is precisely what a lone refusal
# cannot establish.
#
# $OWN is aal1 by construction ("$OWN keeps its aal1 meaning; $OWN2 is the
# elevated session", :637) and $OWN2 is a REAL TOTP elevation, asserted to be
# aal2 at :732 before any of these run -- so if the elevation ever silently
# fails, that check goes red rather than these two quietly measuring the same
# session twice.
p2_code "aal1 OWNER merges -> 403, and this is the MFA gate refusing" 403 POST \
        "rpc/merge_records" \
        "{\"p_organisation_id\":\"$MERGE_ORG\",\"p_entity_type\":\"contact\",\"p_winner_id\":\"$HM_OW\",\"p_loser_id\":\"$HM_OL\"}" "$OWN"
p2_code "aal2 OWNER merges the SAME pair -> 200: an Owner CAN merge" 200 POST \
        "rpc/merge_records" \
        "{\"p_organisation_id\":\"$MERGE_ORG\",\"p_entity_type\":\"contact\",\"p_winner_id\":\"$HM_OW\",\"p_loser_id\":\"$HM_OL\"}" "$OWN2"
# A 200 from a PostgREST RPC is not proof that anything moved -- merge_records()
# returns a uuid, and a function that did nothing and returned one would look
# identical from here. So the outcome is read out of the database.
hm_owner=$(MSYS_NO_PATHCONV=1 docker exec "$CTR" psql -U postgres -d postgres -tAc \
  "select (select count(*) from public.contacts where id='$HM_OL' and deleted_at is not null)
        ||'/'|| (select count(*) from public.merges
                  where loser_id='$HM_OL' and merged_by='${P2ID[powner]}')" | tr -d '[:space:]')
if [ "$hm_owner" = "1/1" ]; then
  printf '  PASS  %-58s %s\n' "...the Owner's loser is soft-deleted and attributed" "$hm_owner"
else
  printf '  FAIL  %-58s got %s want 1/1\n' \
         "...the Owner's loser is soft-deleted and attributed" "$hm_owner"
  api_fails=$((api_fails+1))
fi
# THE SNAPSHOT THE TWO MERGE SCREENS READ, OVER HTTP (final review I-7).
#
# The merge above is a REAL merge_records() call, so its field_resolution is
# the real thing rather than a hand-written fixture -- which is exactly what
# this suite had no assertion on. `merges?select=field_resolution` returning a
# row proves the SELECT policy lets the Owner read it; only the value proves
# the snapshot lib/crm/dedup.ts snapshotName() and 20260829040000:246 both
# depend on is actually in there. The psql half is § Z of rls_phase2_crm.sql;
# this is the same claim through PostgREST, where the column is serialised to
# JSON and a shape change would show up differently.
p2_json "the REAL merge's loser.before.name survives to the API" \
        "Bella Nkemelu" \
        "merges?select=field_resolution&loser_id=eq.$HM_OL" "$OWN2" \
        "field_resolution.loser.before.name"
# THE SIDES HAVE TO BE TOLD APART BY SOMETHING THAT DIFFERS BETWEEN THEM, and
# the name is not it: this fixture pair is two records with the SAME name
# (:1523-1531, which is the point of a dedup fixture), so a probe expecting
# "Bella Nkemelu" on each side passes even if merge_records() swapped the two
# snapshots. The psql half catches that -- § Z's pairs are named
# "Real Merge Winner …"/"Real Merge Loser …" precisely so Z6 and Z7 cannot
# agree by accident -- but the assertion here has to stand on its own. The ids
# differ, so they are what pins the sides.
p2_json "...and it is the LOSER's row, not the winner's, under 'loser'" \
        "$HM_OL" \
        "merges?select=field_resolution&loser_id=eq.$HM_OL" "$OWN2" \
        "field_resolution.loser.before.id"
p2_json "...and the winner side, which the timeline reads, is the winner's" \
        "$HM_OW" \
        "merges?select=field_resolution&loser_id=eq.$HM_OL" "$OWN2" \
        "field_resolution.winner.before.id"
# THE PAIRED NEGATIVE. Without it every probe above is satisfied by a helper
# that prints its own `want`: this asks for a key that has never existed and
# must come back <null>.
p2_json "CONTROL: a path that does not exist reads <null>, not a value" \
        "<null>" \
        "merges?select=field_resolution&loser_id=eq.$HM_OL" "$OWN2" \
        "field_resolution.loser.prior.name"
# TENANT BREAKOUT, over HTTP: the request an attacker actually sends.
p2_code "TENANT BREAKOUT: merging an ALPHA record from org-http-merge" 403 POST \
        "rpc/merge_records" \
        "{\"p_organisation_id\":\"$MERGE_ORG\",\"p_entity_type\":\"contact\",\"p_winner_id\":\"$HM_W\",\"p_loser_id\":\"22220000-0000-0000-0000-000000000002\"}" "$MGR"
p2_code "TENANT BREAKOUT: ...and tagging it with the other org's id" 403 POST \
        "rpc/merge_records" \
        "{\"p_organisation_id\":\"$ALPHA_ORG\",\"p_entity_type\":\"contact\",\"p_winner_id\":\"$HM_W\",\"p_loser_id\":\"$HM_L\"}" "$MGR"

# A SUSPENDED WORKSPACE IS READ-ONLY (Q6). The queue stays readable; the merge
# and the screening do not. Asserted as the MECHANISM -- an RPC that raises is a
# loud 403, not the silent 204 an UPDATE gives.
p2_sub "update public.organisations set deleted_at = now() where id='$MERGE_ORG';"
p2_code "SUSPENDED: merge_records refused -> 403, not a silent 200" 403 POST \
        "rpc/merge_records" \
        "{\"p_organisation_id\":\"$MERGE_ORG\",\"p_entity_type\":\"contact\",\"p_winner_id\":\"$HM_W\",\"p_loser_id\":\"$HM_L\"}" "$MGR"
p2_code "SUSPENDED: screen_for_duplicates refused -> 403" 403 POST \
        "rpc/screen_for_duplicates" \
        "{\"p_organisation_id\":\"$MERGE_ORG\",\"p_entity_type\":\"contact\",\"p_entity_id\":\"$HM_L\"}" "$MGR"
hm_susp=$(curl -s "$API/rest/v1/merge_candidates?select=id&organisation_id=eq.$MERGE_ORG" \
  -H "apikey: $ANON" -H "Authorization: Bearer $MGR" \
  | python -c "import sys,json;d=json.load(sys.stdin);print(len(d) if isinstance(d,list) else -1)")
if [ "$hm_susp" -ge 1 ] 2>/dev/null; then
  printf '  PASS  %-58s %s\n' "SUSPENDED: the review queue is still READABLE" "$hm_susp"
else
  printf '  FAIL  %-58s got %s want >=1\n' "SUSPENDED: the review queue is still READABLE" "$hm_susp"
  api_fails=$((api_fails+1))
fi
p2_sub "update public.organisations set deleted_at = null where id='$MERGE_ORG';"

# THE POSITIVE CONTROL, last, because it destroys the fixture. Without it every
# 403 above is satisfied by a function that refuses everybody.
p2_code "REINSTATED: the manager's merge applies (positive control)" 200 POST \
        "rpc/merge_records" \
        "{\"p_organisation_id\":\"$MERGE_ORG\",\"p_entity_type\":\"contact\",\"p_winner_id\":\"$HM_W\",\"p_loser_id\":\"$HM_L\"}" "$MGR"
hm_after=$(MSYS_NO_PATHCONV=1 docker exec "$CTR" psql -U postgres -d postgres -tAc \
  "select (select count(*) from public.contacts where id='$HM_L' and deleted_at is not null)
        ||'/'|| (select count(*) from public.merges where loser_id='$HM_L')
        ||'/'|| (select count(*) from public.merge_candidates
                  where organisation_id='$MERGE_ORG' and deleted_at is null)" | tr -d '[:space:]')
if [ "$hm_after" = "1/1/0" ]; then
  printf '  PASS  %-58s %s\n' "...loser soft-deleted, merge recorded, queue cleared" "$hm_after"
else
  printf '  FAIL  %-58s got %s want 1/1/0\n' "...loser soft-deleted, merge recorded, queue cleared" "$hm_after"
  api_fails=$((api_fails+1))
fi

# ---------------------------------------------------------------------------
# THE ACTIVITY TIMELINE OVER POSTGREST (Task 7)
#
# The psql section X asserts what the view RETURNS. This block asserts that the
# request lib/list/query.ts actually builds reaches it -- which is a different
# claim, and the one that has caught things in this phase twice. Two parts of
# that request only exist at the transport:
#
#   * the keyset predicate is a REDUNDANT RANGE BOUND plus a LOGIC TREE
#     (`occurred_at=lte.X` and `or=(occurred_at.lt.X,and(occurred_at.eq.X,
#     id.lt.Y))`). PostgREST's logic-tree grammar is not SQL, the two halves
#     quote differently, and a view is not a table -- none of that is visible
#     from psql.
#   * `count=exact` on a view. `fetchListPage` renders the total from the
#     Content-Range header, and a view that could not be counted would render a
#     page with no total and log nothing.
#
# TL_* are section X's fixtures. TL_TIE is the instant the contact's own
# creation and its company link share -- the tie the ordering key exists for.
# ---------------------------------------------------------------------------
echo
echo "=== The activity timeline at the API surface (Task 7) ==="

# The Org Beta owner's token is fetched here rather than at the top: this is
# the only block that needs it, and a token nobody uses is a token nobody
# notices going stale.
BOWN=$(p2_token pbowner); [ -n "$BOWN" ] || { echo "no token for pbowner" >&2; exit 1; }

TL_REC='7a000000-0000-0000-0000-000000000001'   # T Timeline Winner (alpha)
TL_STD='7a000000-0000-0000-0000-000000000002'   # T Timeline Std1   (alpha)
TL_TIE='2026-03-01T10:00:00%2B00:00'            # %2B: a bare + in a query string is a space
TL_SCOPE="activity_events?organisation_id=eq.$ALPHA_ORG&subject_type=eq.contact"

p2_rows "a manager reads the whole timeline of one record" 4 \
  "$TL_SCOPE&subject_id=eq.$TL_REC&select=id,occurred_at,kind,actor_name,detail&order=occurred_at.desc,id.desc" "$MGR"

# THE COUNT ROUND TRIP. Same shape hm_range uses for the merge history: the
# total comes out of Content-Range, and `head=true` is how fetchListPage asks.
tl_total() { # name want path token
  local name="$1" want="$2" path="$3" tok="$4" range
  range=$(curl -s -o /dev/null -D - -X HEAD "$API/rest/v1/$3" \
    -H "apikey: $ANON" -H "Authorization: Bearer $tok" \
    -H "Prefer: count=exact" | tr -d '\r' | awk 'tolower($1)=="content-range:"{print $2}')
  if [ "${range##*/}" = "$want" ]; then
    printf '  PASS  %-58s %s\n' "$name" "$range"
  else
    printf '  FAIL  %-58s got %s want */%s\n' "$name" "${range:-<none>}" "$want"
    api_fails=$((api_fails+1))
  fi
}
tl_total "count=exact works on the view, so the total is real" 4 \
  "$TL_SCOPE&subject_id=eq.$TL_REC&select=id" "$MGR"

# THE CURSOR GRAMMAR, ISSUED EXACTLY AS applyCursor() BUILDS IT. A 200 with one
# row is the assertion; a 400 here is what a cursor that cannot be expressed
# against a view would look like, and no psql assertion can produce one.
p2_code "the keyset predicate is accepted against the view (200, not 400)" 200 GET \
  "$TL_SCOPE&subject_id=eq.$TL_REC&select=id,occurred_at,kind&occurred_at=lte.$TL_TIE&or=(occurred_at.lt.$TL_TIE,and(occurred_at.eq.$TL_TIE,id.lt.ffffffff-ffff-4fff-8fff-ffffffffffff))&order=occurred_at.desc,id.desc&limit=1" \
  "" "$MGR"

# PAGING THROUGH THE TIE, ONE ROW AT A TIME, over the real transport. Four
# single-row pages must yield the four events, each exactly once -- which is
# the property a tie breaks when the sort key is not total. Done in python
# because each page's cursor comes out of the previous page's last row, which
# is precisely what the application does.
tl_walk=$(TL_API="$API" TL_ANON="$ANON" TL_TOK="$MGR" \
          TL_PATH="$TL_SCOPE&subject_id=eq.$TL_REC" python - <<'PYEOF'
import json, os, urllib.parse, urllib.request

api, anon, tok, path = (os.environ[k] for k in
                        ("TL_API", "TL_ANON", "TL_TOK", "TL_PATH"))

def get(url):
    req = urllib.request.Request(url, headers={
        "apikey": anon, "Authorization": "Bearer " + tok})
    with urllib.request.urlopen(req) as r:
        return json.load(r)

seen, cursor = [], None
for _ in range(8):                      # bounded: 4 expected, 8 catches a loop
    url = "%s/rest/v1/%s&select=id,occurred_at,kind&order=occurred_at.desc,id.desc&limit=1" % (api, path)
    if cursor:
        ts, rid = cursor
        q = urllib.parse.quote(ts, safe="")
        url += "&occurred_at=lte.%s&or=(occurred_at.lt.%s,and(occurred_at.eq.%s,id.lt.%s))" % (q, q, q, rid)
    rows = get(url)
    if not rows:
        break
    row = rows[0]
    seen.append(row["id"])
    cursor = (row["occurred_at"], row["id"])

print("%d/%d" % (len(seen), len(set(seen))))
PYEOF
)
if [ "$tl_walk" = "4/4" ]; then
  printf '  PASS  %-58s %s\n' "one-row pages walk the tie, each event exactly once" "$tl_walk"
else
  printf '  FAIL  %-58s got %s want 4/4\n' "one-row pages walk the tie, each event exactly once" "$tl_walk"
  api_fails=$((api_fails+1))
fi

# VISIBILITY, AT THE TRANSPORT. The psql section asserts the same three facts
# through the policies directly; these assert that nothing about going through
# PostgREST -- which reads the view as `authenticated`, not as postgres --
# loosens them.
p2_rows "TENANT: the Beta owner reads none of it" 0 \
  "$TL_SCOPE&subject_id=eq.$TL_REC&select=id" "$BOWN"
p2_rows "RECORD SCOPE: a standard_user sees nothing on another's record" 0 \
  "$TL_SCOPE&subject_id=eq.$TL_REC&select=id" "$STD"
# ...and the SAME token on the SAME view sees their own record, so the 0 above
# is the policy and not a broken request.
#
# NARROWED TO ONE KIND, NOT COUNTED AS ROWS. The first draft asserted "1 row"
# and got 2: an earlier block in this file PATCHes contacts across org-alpha,
# which moves updated_at and gives every contact in the workspace a
# `record_updated` entry. A bare row count here is a hostage to every block
# above it, and the kind is what this assertion is actually about.
p2_rows "POSITIVE CONTROL: the same token sees their OWN record's creation" 1 \
  "$TL_SCOPE&subject_id=eq.$TL_STD&kind=eq.record_created&select=id" "$STD"
# THE ASYMMETRY, AT THE TRANSPORT. std1 owns this contact and NOT the record
# it absorbed, so merges_select_via_winner -- which wants both -- hides the
# merge while the contact itself stays readable. This is the entry the
# timeline's scope note exists to warn the reader about.
p2_rows "...but NOT the merge it survived, whose loser was another user's" 0 \
  "$TL_SCOPE&subject_id=eq.$TL_STD&kind=eq.merge_absorbed&select=id" "$STD"
p2_rows "CONTROL: a full-scope reader DOES see that same merge" 1 \
  "$TL_SCOPE&subject_id=eq.$TL_STD&kind=eq.merge_absorbed&select=id" "$MGR"
p2_rows "a read_only caller who owns nothing gets 0 rows, not an error" 0 \
  "$TL_SCOPE&subject_id=eq.$TL_REC&select=id" "$RO"

# NOT WRITABLE -- AND THE CODE IS A 500, MEASURED RATHER THAN WISHED FOR.
# Postgres rejects the statement at rewrite time ("Views containing UNION,
# INTERSECT, or EXCEPT are not automatically updatable", SQLSTATE 55000),
# which happens BEFORE any privilege check -- so the missing INSERT grant
# never gets the chance to produce the 403 this would otherwise return. The
# write is refused either way; what the status code cannot show is WHICH
# refusal fired, so the grant surface is asserted separately, in the
# database, at X1/X2.
#
# Recorded as a finding rather than smoothed over: a refused write that
# answers 500 looks like a server fault to anything watching error rates.
p2_code "the view refuses an INSERT over PostgREST (55000, not the grant)" 500 \
  POST "activity_events" "{\"kind\":\"planted\"}" "$MGR"
p2_code "...and a PATCH, refused the same way" 500 \
  PATCH "activity_events?kind=eq.record_created" "{\"kind\":\"planted\"}" "$MGR"

echo
echo "=== Phase 4 operations at the API surface (Task 2) ==="
# The psql suite proves the policies through set-by-hand claims. This proves the
# same tenant boundary and the note-visibility predicate through REAL password
# sessions and PostgREST -- the highest-value paths only.
#
# Fixture ids planted by rls_phase4_operations.sql (as postgres):
P4_NOTE_COMPANY='70000000-0000-0000-0000-000000000002'   # company, owner pmanager
P4_NOTE_PRIVATE='70000000-0000-0000-0000-000000000001'   # private, owner pstd1
P4_DOC_ALPHA='d0000000-0000-0000-0000-000000000001'      # clean, owner pmanager
P4_MGR_TASK='7a000000-0000-0000-0000-000000000002'       # Manager Task (ALPHA)
P4_BETA_TASK='7a00000b-0000-0000-0000-00000000000b'      # Beta Task (BETA)
P4_UNOWNED_CONTACT='22220000-0000-0000-0000-000000000003'
P4_BETA_CO='1111000b-0000-0000-0000-00000000000b'

# anon: the tables are not reachable logged out at all.
p2_code "anon GET tasks"      401 GET "tasks?select=id"
p2_code "anon GET notes"      401 GET "notes?select=id"
p2_code "anon GET documents"  401 GET "documents?select=id"

# Tenant boundary, aimed at the other tenant's org id -- notes and documents
# come back as [] for a member of the wrong tenant.
p2_rows "manager GET notes of org BETA (expect 0)"     0 \
        "notes?select=id&organisation_id=eq.$BETA_ORG" "$MGR"
p2_rows "manager GET documents of org BETA (expect 0)" 0 \
        "documents?select=id&organisation_id=eq.$BETA_ORG" "$MGR"
# POSITIVE CONTROL: the same token reads an ALPHA company note it may see.
p2_rows "CONTROL: manager GETs an ALPHA company note" 1 \
        "notes?select=id&id=eq.$P4_NOTE_COMPANY" "$MGR"

# NOTE VISIBILITY over HTTP. A 'private' note is absent for a non-author even a
# full-scope Admin, and present for its author -- the § OD predicate at the API.
p2_rows "a full-scope Admin does NOT see another user's PRIVATE note" 0 \
        "notes?select=id&id=eq.$P4_NOTE_PRIVATE" "$MGR"
p2_rows "CONTROL: the note's AUTHOR sees their own private note" 1 \
        "notes?select=id&id=eq.$P4_NOTE_PRIVATE" "$STD"

# DOCUMENT cross-tenant: BETA's owner cannot read an ALPHA document.
p2_rows "pbowner (BETA) GETs an ALPHA document (expect 0)" 0 \
        "documents?select=id&id=eq.$P4_DOC_ALPHA" "$BOWN"

# CROSS-TENANT LINK INSERT: a manager POSTing a task_link into BETA is refused
# (403, an INSERT policy has only WITH CHECK so PostgREST raises).
p2_code "manager POSTs a task_link into org BETA" 403 POST "task_links" \
        "{\"organisation_id\":\"$BETA_ORG\",\"parent_id\":\"$P4_BETA_TASK\",\"entity_type\":\"company\",\"entity_id\":\"$P4_BETA_CO\"}" "$MGR"
# POSITIVE CONTROL: the same manager links their OWN ALPHA task to a contact they
# can see -- 201, so the 403 above is the boundary and not a dead endpoint.
p2_code "CONTROL: manager links their own ALPHA task to a visible contact" 201 POST "task_links" \
        "{\"organisation_id\":\"$ALPHA_ORG\",\"parent_id\":\"$P4_MGR_TASK\",\"entity_type\":\"contact\",\"entity_id\":\"$P4_UNOWNED_CONTACT\"}" "$MGR"

echo
echo "=== Phase 5 finance at the API surface (Task 4) ==="
# The psql suite above proves the three gates through claims set by hand. This
# proves the ones an attacker can actually reach through the ANON KEY THAT SHIPS
# IN EVERY BROWSER BUNDLE plus a REAL password session -- a request that never
# touches the Next.js app, so no Server Action guard, no layout gate and no
# getFinanceWriteAccess() call is anywhere on its path (Constraint 12: hiding
# the panel and refusing the write are two separate jobs).
#
# Fixture ids planted by rls_phase5_finance.sql (as postgres):
P5_EVENT_A='ef110000-0000-0000-0000-000000000001'   # ALPHA, 4 finance lines
P5_LINE_A='fa110000-0000-0000-0000-000000000001'    # one of those four
P5_BETA_EVENT='ef11000b-0000-0000-0000-00000000000b'
# NOTE: Finance Event B (ef11...0002) does NOT exist here -- section FJ deletes
# it to prove the cascade -- so every write below targets Finance Event A, and
# the GET counts are stated as "of 4" against that event.

# anon: the table is not reachable logged out at all.
p2_code "anon GET financial_entries"  401 GET  "financial_entries?select=id"
p2_code "anon POST financial_entries" 401 POST "financial_entries" \
        "{\"organisation_id\":\"$ALPHA_ORG\",\"event_id\":\"$P5_EVENT_A\",\"category\":\"fee\",\"amount_minor\":1}"

# IDOR/BOLA, THE HEADLINE. A Booker is an active ALPHA member holding view_crm
# and manage_events. They hold no finance key, so the id in the URL buys them
# nothing: [] for the whole event, and [] for a line named directly.
p2_rows "a BOOKER GETs an ALPHA event's finance lines (0 of 4)" 0 \
        "financial_entries?select=id&event_id=eq.$P5_EVENT_A" "$BKR"
p2_rows "...nor by naming one line's id outright (IDOR)" 0 \
        "financial_entries?select=id&id=eq.$P5_LINE_A" "$BKR"
p2_rows "...nor through the event_finance_summary view (security_invoker)" 0 \
        "event_finance_summary?select=event_id&event_id=eq.$P5_EVENT_A" "$BKR"
# POSITIVE CONTROL: the SAME token, the SAME event, the parent row -- so the
# three zeros above are the finance policy and not a dead session.
p2_rows "CONTROL: the same BOOKER token reads that parent EVENT" 1 \
        "events?select=id&id=eq.$P5_EVENT_A" "$BKR"
p2_code "a BOOKER POSTs a finance line" 403 POST "financial_entries" \
        "{\"organisation_id\":\"$ALPHA_ORG\",\"event_id\":\"$P5_EVENT_A\",\"category\":\"fee\",\"amount_minor\":1}" "$BKR"
# ...and the tenant boundary from the other side, aimed at BETA's org id.
p2_rows "a BOOKER GETs org BETA's finance lines (expect 0)" 0 \
        "financial_entries?select=id&organisation_id=eq.$BETA_ORG" "$BKR"

# THE MFA GATE OVER REAL HTTP. A password grant yields aal1, always (measured in
# the MFA block near the top of this file), and role_requires_mfa('finance') is
# true -- so the Finance user's ORDINARY session holds neither finance key. This
# is the request the Layer-2 half of 20260827210000 exists for, aimed at money.
FIN=$(p2_token pfinance); [ -n "$FIN" ] || { echo "no token for pfinance" >&2; exit 1; }
fin_aal=$(p2_aal "$FIN")
if [ "$fin_aal" = "aal1" ]; then
  printf '  PASS  %-58s %s\n' "the FINANCE password session really is aal1" "$fin_aal"
else
  printf '  FAIL  %-58s got %s want aal1\n' "the FINANCE password session really is aal1" "$fin_aal"
  api_fails=$((api_fails+1))
fi
p2_rows "an aal1 FINANCE session reads 0 of the 4 lines (MFA gate)" 0 \
        "financial_entries?select=id&event_id=eq.$P5_EVENT_A" "$FIN"
p2_code "...and its POST is refused" 403 POST "financial_entries" \
        "{\"organisation_id\":\"$ALPHA_ORG\",\"event_id\":\"$P5_EVENT_A\",\"category\":\"fee\",\"amount_minor\":1}" "$FIN"

# THE ELEVATION. A real TOTP enrol + verify against this stack, the same journey
# p2_totp_elevate walks for the Owner above. It happens HERE, after the aal1
# checks, because verifying a user's first factor revokes their other sessions
# -- so $FIN is spent from this line on and $FIN2 is the Finance user's session.
FIN2=$(p2_totp_elevate "$FIN")
fin2_aal=$(p2_aal "$FIN2")
if [ "$fin2_aal" = "aal2" ]; then
  printf '  PASS  %-58s %s\n' "the FINANCE session elevates to aal2 (real TOTP)" "$fin2_aal"
else
  printf '  FAIL  %-58s got "%s" want aal2\n' \
         "the FINANCE session elevates to aal2 (real TOTP)" "$fin2_aal"
  api_fails=$((api_fails+1))
  echo "  (without an aal2 finance session the tier checks below would be" >&2
  echo "   measuring the MFA gate instead -- failing loudly rather than hollow)" >&2
fi
p2_rows "POSITIVE: the aal2 FINANCE session reads all 4 lines" 4 \
        "financial_entries?select=id&event_id=eq.$P5_EVENT_A" "$FIN2"
p2_rows "POSITIVE: ...and the summary view returns its one row" 1 \
        "event_finance_summary?select=event_id&event_id=eq.$P5_EVENT_A" "$FIN2"
p2_rows "TENANT: ...and still none of org BETA's" 0 \
        "financial_entries?select=id&organisation_id=eq.$BETA_ORG" "$FIN2"
p2_code "TENANT: ...and its POST into a BETA event is refused" 403 POST "financial_entries" \
        "{\"organisation_id\":\"$BETA_ORG\",\"event_id\":\"$P5_BETA_EVENT\",\"category\":\"fee\",\"amount_minor\":1}" "$FIN2"

# THE TIER GATE OVER REAL HTTP. organisation_subscriptions has no org-scoped
# write path at the API by design (Foundation design note (g): one would be a
# free upgrade to Pro), so the plan is moved with psql -- the same way the CRM
# entitlement block above does it.
p2_sub "insert into public.organisation_subscriptions
          (organisation_id, plan_id, billing_cycle, seat_count, status, current_period_end)
        values ('$ALPHA_ORG','pro','monthly',1,'active', now() + interval '30 days')
        on conflict (organisation_id) do update set plan_id='pro', status='active';"
p2_code "PRO: the aal2 FINANCE session POSTs a finance line" 201 POST "financial_entries" \
        "{\"organisation_id\":\"$ALPHA_ORG\",\"event_id\":\"$P5_EVENT_A\",\"category\":\"cost\",\"amount_minor\":4200}" "$FIN2"

p2_sub "update public.organisation_subscriptions set plan_id='starter'
        where organisation_id='$ALPHA_ORG';"
p2_code "STARTER: the SAME POST is refused 403 (finance_module=false)" 403 POST "financial_entries" \
        "{\"organisation_id\":\"$ALPHA_ORG\",\"event_id\":\"$P5_EVENT_A\",\"category\":\"cost\",\"amount_minor\":4200}" "$FIN2"
# Q67 AT THE TRANSPORT: the downgrade freezes the sheet, it does not hide it.
# Five now, not four: the Pro-tier POST above added one.
p2_rows "STARTER: ...while the READS still return all 5 lines (Q67)" 5 \
        "financial_entries?select=id&event_id=eq.$P5_EVENT_A" "$FIN2"
# ...and the refusal is the FINANCE MODULE, not the whole subscription: Starter
# carries crm_writes, so a CRM write by another role succeeds in the same state.
p2_code "STARTER CONTROL: a MANAGER's CRM write still succeeds (crm_writes=true)" 201 \
        POST "contacts" "{\"organisation_id\":\"$ALPHA_ORG\",\"name\":\"starter-era contact\"}" "$MGR"

p2_sub "update public.organisation_subscriptions set plan_id='pro'
        where organisation_id='$ALPHA_ORG';"
p2_code "PRO AGAIN: the POST comes back (the gate is the plan, not a one-way door)" 201 \
        POST "financial_entries" \
        "{\"organisation_id\":\"$ALPHA_ORG\",\"event_id\":\"$P5_EVENT_A\",\"category\":\"cost\",\"amount_minor\":4200}" "$FIN2"

# Leave the fixture in the state every other block found it in: no subscription
# row for ALPHA (the inert state the product actually ships in today).
p2_sub "delete from public.organisation_subscriptions where organisation_id='$ALPHA_ORG';"

if [ "$api_fails" != "0" ]; then
  echo "API SURFACE FAILED: $api_fails check(s)" >&2
  http_status=1
else
  echo "API surface: all checks passed."
fi

# NEW-5. Both halves have now run, so report both. Previously each psql suite
# exited immediately on failure under `set -e`, which meant a mutation run that
# reddened one psql assertion silently skipped ALL 39 HTTP checks -- including
# the "Subscription entitlement at the API surface" block, which reproduces
# IMP-1's original defect at the layer it was found. A red run looked like a
# smaller failure than it was, and an HTTP-only regression sitting behind a psql
# failure was invisible.
if [ "$psql_status" != "0" ] || [ "$http_status" != "0" ]; then
  echo >&2
  echo "SUITE FAILED (psql=$psql_status http=$http_status)" >&2
  exit 1
fi
echo
echo "All suites passed."
