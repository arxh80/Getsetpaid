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
     union all select count(*) from public.merges) s" | tr -d '[:space:]')
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

MGR=$(p2_token pmanager);   [ -n "$MGR" ] || { echo "no token for pmanager" >&2; exit 1; }
BKR=$(p2_token pbooker);    [ -n "$BKR" ] || { echo "no token for pbooker" >&2; exit 1; }
STD=$(p2_token pstd1);      [ -n "$STD" ] || { echo "no token for pstd1" >&2; exit 1; }
OWN=$(p2_token powner);     [ -n "$OWN" ] || { echo "no token for powner" >&2; exit 1; }
# Task 4: the read_only role, for the RPC refusal checks at the bottom.
RO=$(p2_token pro);         [ -n "$RO" ]  || { echo "no token for pro" >&2; exit 1; }

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
