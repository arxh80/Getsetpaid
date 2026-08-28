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
