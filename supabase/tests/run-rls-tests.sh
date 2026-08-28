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
[ "$inv_fails" = "0" ] || {
  echo "SCHEMA INVARIANT SUITE FAILED: $inv_fails failing assertion(s)" >&2
  echo "  A failure in section A is a REOPENED TENANT BOUNDARY -- treat as Sev1." >&2
  echo "  A failure in D4/D5 is expected once Task 2 lands; update the expectation." >&2
  exit 1
}
echo "Schema invariants: all assertions passed."
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
[ "$fails" = "0" ] || { echo "RLS SUITE FAILED: $fails failing assertion(s)" >&2; exit 1; }
echo "RLS suite: all assertions passed."

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

[ "$api_fails" = "0" ] || { echo "API SURFACE FAILED: $api_fails check(s)" >&2; exit 1; }
echo "API surface: all checks passed."
