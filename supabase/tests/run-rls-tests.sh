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
# run_suite -- THE ONE PLACE A PSQL SUITE IS RUN (census audit, findings 1, 8, 9)
# ============================================================================
# Until this existed, each of the nineteen suites was invoked by its own
# hand-written block and the runner's ONLY gate per suite was
#
#   select count(*) from <schema>.results where not pass
#
# which is a count of RECORDED FAILURES. An assertion that never records a row
# is invisible to it, and there are two ways for that to happen:
#
#  1. THE STATEMENT RAISES BEFORE ITS HELPER IS ENTERED. An error raised while
#     the CALLER's own statement is being built -- the shipped case was a
#     format() specifier, `%'` -- happens before val()/try()/record() runs, so
#     no row is inserted, the failure count stays zero and the suite reports
#     "all assertions passed". `psql -f` without ON_ERROR_STOP prints
#     `psql:<file>:<line>: ERROR: ...` and EXITS 0, so `set -euo pipefail`
#     never trips. ON_ERROR_STOP is deliberately NOT the answer: it would hide
#     every assertion after the first accident, and every DELIBERATE refusal in
#     these suites is caught inside plpgsql and never reaches psql. So any psql
#     ERROR line is red, and the output is kept in order to count them. This
#     guard existed twice (the DSR and export suites, commits acc83b3 and
#     b3de527) and nowhere else -- adding a twentieth suite silently opted out
#     of it, which is why it is here and not copy-pasted a third time.
#
#  2. THE record() ROW IS ROLLED BACK WITH ITS OWN TRANSACTION. That produces
#     no ERROR line at all and is invisible to (1) -- the DF11-DF13 class,
#     task-3-report.md:151-158. The ONLY thing that catches it is a PINNED
#     EXPECTED TOTAL, which no suite had. So run_suite takes one: the number of
#     rows the suite must have recorded, measured on a clean run and written
#     into the call. A suite that records 213 assertions where 214 are pinned
#     is RED, whether the missing one failed, raised or vanished.
#
# Pass `-` as the expected total to MEASURE instead of asserting (the run that
# establishes a new suite's number). That is deliberately visible in the call
# site rather than an environment variable, so an unpinned suite cannot sit
# unpinned quietly.
#
#   run_suite <LABEL> <file.sql> <results schema> <expected|-> [psql args...]
#
# Sets SUITE_FAILS to that suite's recorded-failure count, which each suite's
# own diagnostic block below still reads and explains section by section.
SUITE_FAILS=0
run_suite() {
  local label="$1" file="$2" schema="$3" expected="$4"
  shift 4
  docker cp "$HERE/$file" "$CTR:/tmp/$file" >/dev/null

  local out
  out=$(mktemp)
  MSYS_NO_PATHCONV=1 docker exec "$CTR" psql -U postgres -d postgres -q --pset=footer=off \
    "$@" -f "/tmp/$file" 2>&1 | tee "$out"

  local errors
  errors=$(grep -c '^psql:.*ERROR:' "$out" || true)
  rm -f "$out"
  if [ "$errors" != "0" ]; then
    echo "$label: $errors psql ERROR line(s) -- an assertion that raised before it was recorded has VANISHED from the report above, which is worse than failing." >&2
    psql_status=1
  fi

  local recorded
  recorded=$(MSYS_NO_PATHCONV=1 docker exec "$CTR" psql -U postgres -d postgres -tAc \
             "select count(*) from $schema.results" | tr -d '[:space:]')
  if [ "$expected" = "-" ]; then
    echo "$label: $recorded assertions recorded (NOT PINNED -- put this number in the run_suite call)."
  elif [ "$recorded" != "$expected" ]; then
    echo "$label: RECORDED $recorded ASSERTIONS, PINNED AT $expected." >&2
    echo "  Fewer means an assertion VANISHED rather than failed -- it raised before" >&2
    echo "  its helper, or its record() row was rolled back with its own transaction." >&2
    echo "  More means assertions were added: re-measure and update the run_suite call." >&2
    psql_status=1
  else
    echo "$label: $recorded assertions recorded, as pinned."
  fi

  SUITE_FAILS=$(MSYS_NO_PATHCONV=1 docker exec "$CTR" psql -U postgres -d postgres -tAc \
                "select count(*) from $schema.results where not pass" | tr -d '[:space:]')
}

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
run_suite "SCHEMA INVARIANTS" schema_invariants.sql invariants 82
inv_fails=$SUITE_FAILS
if [ "$inv_fails" != "0" ]; then
  echo "SCHEMA INVARIANT SUITE FAILED: $inv_fails failing assertion(s)" >&2
  echo "  A failure in section A is a REOPENED TENANT BOUNDARY -- treat as Sev1." >&2
  psql_status=1
else
  echo "Schema invariants: all assertions passed."
fi
echo


VARS=()
for u in alice bob carol dave super; do
  VARS+=( -v "$u=${ID[$u]}" )
  VARS+=( -v "${u}_c={\"sub\":\"${ID[$u]}\",\"role\":\"authenticated\",\"aal\":\"${AAL[$u]}\"}" )
  VARS+=( -v "${u}_c1={\"sub\":\"${ID[$u]}\",\"role\":\"authenticated\",\"aal\":\"aal1\"}" )
  VARS+=( -v "${u}_c0={\"sub\":\"${ID[$u]}\",\"role\":\"authenticated\"}" )
done

run_suite "RLS FOUNDATION" rls_foundation.sql harness 181 "${VARS[@]}"
fails=$SUITE_FAILS
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


P2VARS=()
for u in powner padmin pmanager pbooker pvenuemgr pfinance pmarketing \
         pstd1 pstd2 pro pbowner pmulti; do
  P2VARS+=( -v "$u=${P2ID[$u]}" )
  P2VARS+=( -v "${u}_c={\"sub\":\"${P2ID[$u]}\",\"role\":\"authenticated\",\"aal\":\"${P2AAL[$u]}\"}" )
  P2VARS+=( -v "${u}_c1={\"sub\":\"${P2ID[$u]}\",\"role\":\"authenticated\",\"aal\":\"aal1\"}" )
done

run_suite "PHASE 2 CRM" rls_phase2_crm.sql crm 694 "${P2VARS[@]}"
p2_fails=$SUITE_FAILS
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

run_suite "PHASE 3 EVENTS" rls_phase3_events.sql ev 187 "${P2VARS[@]}"
p3_fails=$SUITE_FAILS
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

run_suite "PHASE 4 OPERATIONS" rls_phase4_operations.sql op 91 "${P2VARS[@]}"
p4_fails=$SUITE_FAILS
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

run_suite "PHASE 4 FILE ACCESS" file_access_phase4.sql fa 11 "${P2VARS[@]}"
fa_fails=$SUITE_FAILS
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

run_suite "PHASE 5 FINANCE" rls_phase5_finance.sql fin 151 "${P2VARS[@]}"
p5_fails=$SUITE_FAILS
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
# PHASE 6 (NETWORK) RLS SUITE -- THE PRIVATE/NETWORK BOUNDARY PROOF (Task 1).
#
# Runs LAST of the psql suites and REUSES THE SAME FIXTURES WHOLE -- the twelve
# users, orgs org-alpha/org-beta, and the Phase 2 companies and venues the
# network profiles speak for. It creates only network_* rows plus the two ALPHA
# venues § NX5's insert-as-published fixture needs (20260907001000), so the
# contact, artist and event censuses the HTTP block below was written against
# are untouched -- and every downstream VENUE assertion is a floor or a
# foreign-tenant zero (LG0's `>= 50`, LC0's non-emptiness, the HTTP sweep's
# p2_rows 0 / p2_rows_min 1), so two extra ALPHA venues move none of them. It plants and then removes one organisation_subscriptions row (its
# § NT, the Free-tier gate) and asserts in § NZ that it left none behind, for
# the same reason rls_phase5_finance.sql asserts its own housekeeping: a leak
# would redden an assertion in the HTTP block whose text says nothing about the
# network.
#
# CLAUDE.md § The private/network split calls this "the highest-risk boundary"
# and § Testing gates calls network-leakage tests the ones that "matter most".
# This is that suite.
# ============================================================================

run_suite "PHASE 6 NETWORK" rls_phase6_network.sql nw 127 "${P2VARS[@]}"
p6_fails=$SUITE_FAILS
if [ "$p6_fails" != "0" ]; then
  echo "PHASE 6 NETWORK SUITE FAILED: $p6_fails failing assertion(s)" >&2
  echo "  A failure in ND is a PRIVATE TABLE IN A DISCOVERY PATH (N2) -- a view" >&2
  echo "  now reads something other than the network tables, which is the one" >&2
  echo "  thing the whole private/network split forbids." >&2
  echo "  In NC, a MASKING VIEW THAT PROJECTS TOO MUCH -- most likely" >&2
  echo "  organisation_id or entity_id, which turns a profile into a tenant." >&2
  echo "  In NM, A LEAK OF AN UNPUBLISHED FIELD across the tenant boundary, or" >&2
  echo "  a hidden field whose value is still stored (N3)." >&2
  echo "  In NG, a PUBLIC PROFILE: anon now holds something (N6/Q70)." >&2
  echo "  In NT, a BROKEN TIER GATE -- and note the gate is INERT today, so a" >&2
  echo "  green NT1 is expected until Phase 7 removes the escape, at which point" >&2
  echo "  that assertion must be RE-READ and its expectation flipped rather" >&2
  echo "  than re-run (FOLLOW-UPS.md: an inert gate makes a wrong test green)." >&2
  echo "  In NU, THE SENDER CAN ACCEPT ITS OWN REQUEST -- the two UPDATE" >&2
  echo "  policies have been merged into one with an \`or\`." >&2
  echo "  In NL/NS4, THE Q82 LEAK: network_links now has a counterparty read" >&2
  echo "  path, disclosing who has filed whom in their CRM." >&2
  echo "  In NF, THE FORWARD RATINGS GUARD (N5) -- something on the network" >&2
  echo "  surface now names a rating, which CLAUDE.md forbids permanently." >&2
  echo "  In NX, an audit payload now carries a published field's VALUE onto" >&2
  echo "  the superuser-readable surface." >&2
  echo "  Every one of those is Sev1." >&2
  psql_status=1
else
  echo "Phase 6 network suite: all assertions passed."
fi

# ============================================================================
# PHASE 6 NETWORK-LEAKAGE SUITE (Task 5) -- THE CONSOLIDATED ADVERSARIAL PROOF.
#
# The PRD exit criterion for this phase is "private/public boundaries proven by
# tests". This is that proof, and it is a SEPARATE FILE from
# rls_phase6_network.sql in the file_access_phase4.sql tradition: one boundary
# that must never move, in a file of its own, so a reviewer can read the whole
# of it without reading the surface that produced it.
#
# ===========================================================================
# IT NEEDS TWO FIXTURE USERS THE OTHER SUITES DO NOT HAVE, AND THAT IS THE
# POINT OF THE BLOCK BELOW
# ===========================================================================
# Every cross-tenant assertion in rls_phase6_network.sql runs as `pbowner`,
# BETA's owner -- and by the time that file ends ALPHA and BETA are CONNECTED
# (its NR9/NU4 accept a request between the two organisations, and the Task 3
# HTTP block below says so at length). So there was, until Task 5, no psql
# assertion anywhere in this repo run as an UNCONNECTED counterparty, and the
# "unconnected" column of the network-leakage matrix could not be driven at all.
#
#   pgmgr  a manager of a THIRD organisation (created by the suite itself),
#          which has never exchanged a connection request with anybody. THE
#          UNCONNECTED COUNTERPARTY.
#   pbmgr  a manager of org BETA. THE CONNECTED COUNTERPARTY -- and a manager
#          rather than reusing pbowner because `owner` is MFA-required, so an
#          aal1 owner session holds no network key and every 0 measured through
#          one would be the MFA gate rather than the tenant boundary.
#
# CREATED HERE AND NOT IN THE P2 LOOP AT THE TOP, for the reason that loop's
# own header gives: rls_phase2_crm.sql asserts over the whole of
# public.profiles (`string_agg(full_name)` and a bare `count(*)`), and two more
# auth.users rows -- each of which handle_new_user turns into a profile -- would
# be reasoning about a different database than the one it was written against.
# Creating them AFTER every suite that censuses profiles keeps those assertions
# meaning what they meant. Nothing downstream of this point counts profiles or
# organisations (grepped: the only membership count in the HTTP block is
# alice's own, `>= 1`).
#
# P6VARS = P2VARS + the two new users + `super_c`. The superuser claim is
# carried over from the top-of-file VARS because § LC's audit_events positive
# control needs it: audit_events is readable to NO tenant role at all -- not
# even ALPHA's owner, which that section MEASURES rather than assumes -- so the
# superuser is its only positive control, exactly as the Task 5 matrix says.
# ============================================================================
declare -A P6AAL=( [pgmgr]=aal2 [pbmgr]=aal2 )
declare -A P6ID
for u in pgmgr pbmgr; do
  resp=$(curl -s -X POST "$API/auth/v1/admin/users" \
    -H "apikey: $SRK" -H "Authorization: Bearer $SRK" -H "Content-Type: application/json" \
    -d "{\"email\":\"$u@test.local\",\"password\":\"Test-Passw0rd!\",\"email_confirm\":true}")
  id=$(printf '%s' "$resp" | python -c "import sys,json;print(json.load(sys.stdin).get('id') or '')")
  if [ -z "$id" ]; then
    id=$(MSYS_NO_PATHCONV=1 docker exec "$CTR" psql -U postgres -d postgres -tAc \
         "select id from auth.users where email='$u@test.local'" | tr -d '[:space:]')
  fi
  if [ -z "$id" ]; then echo "Could not create or find auth user $u: $resp" >&2; exit 1; fi
  P6ID[$u]=$id
done

P6VARS=( "${P2VARS[@]}" )
for u in pgmgr pbmgr; do
  P6VARS+=( -v "$u=${P6ID[$u]}" )
  P6VARS+=( -v "${u}_c={\"sub\":\"${P6ID[$u]}\",\"role\":\"authenticated\",\"aal\":\"${P6AAL[$u]}\"}" )
  P6VARS+=( -v "${u}_c1={\"sub\":\"${P6ID[$u]}\",\"role\":\"authenticated\",\"aal\":\"aal1\"}" )
done
P6VARS+=( -v "super=${ID[super]}" )
P6VARS+=( -v "super_c={\"sub\":\"${ID[super]}\",\"role\":\"authenticated\",\"aal\":\"aal2\"}" )


run_suite "PHASE 6 NETWORK LEAKAGE" network_leakage_phase6.sql leak 214 "${P6VARS[@]}"
lk_fails=$SUITE_FAILS
if [ "$lk_fails" != "0" ]; then
  echo "PHASE 6 NETWORK-LEAKAGE SUITE FAILED: $lk_fails failing assertion(s)" >&2
  echo "  In LA, THE FIXTURE ITSELF IS WRONG -- the counterparties are not the" >&2
  echo "  members this suite says they are, or the third organisation is no" >&2
  echo "  longer unconnected, and EVERY 0 below it then proves nothing." >&2
  echo "  In LB, A MASKING FAILURE ACROSS THE TENANT BOUNDARY: a connections-" >&2
  echo "  level field resolved for someone who is not connected, or a draft" >&2
  echo "  became discoverable." >&2
  echo "  In LC, THE HEADLINE FINDING -- A COUNTERPARTY CAN READ A TENANT-" >&2
  echo "  PRIVATE RELATION. Read the label: it names the relation and the" >&2
  echo "  denominator it read out of. This is the leak the whole phase exists" >&2
  echo "  to prevent." >&2
  echo "  In LD, THE Q82 LEAK: who has filed whom in their CRM is now" >&2
  echo "  disclosed to the profile's owner." >&2
  echo "  In LE, THE FORWARD RATINGS GUARD (N5/Q85) -- something on the network" >&2
  echo "  surface now names a rating, which CLAUDE.md forbids permanently." >&2
  echo "  In LF, A PRIVATE TABLE IS REACHABLE THROUGH A FUNCTION BODY a" >&2
  echo "  masking view calls -- N2 defeated at a depth pg_depend cannot see." >&2
  echo "  In LG/LH, AN IDENTIFIER DISCLOSURE: a discovery result now hands a" >&2
  echo "  counterparty a primary key of a private row." >&2
  echo "  In LI, A DOWNGRADE EITHER DELETED DATA OR STOPPED REFUSING WRITES." >&2
  echo "  In LJ, SUSPENSION BEHAVIOUR CHANGED -- these expectations are a" >&2
  echo "  RECORD of measured behaviour (see task-5-report.md), so a failure" >&2
  echo "  here means re-measure and re-record, not relax." >&2
  echo "  In LK, THE MFA GATE: an aal1 session now holds a network key." >&2
  echo "  In LW, A COUNTERPARTY CAN WRITE INTO ANOTHER TENANT." >&2
  echo "  In LZ, this suite left fixture state behind that the HTTP checks" >&2
  echo "  below were not written against -- discard the run and reset." >&2
  echo "  Treat as Sev1." >&2
  psql_status=1
else
  echo "Phase 6 network-leakage suite: all assertions passed."
fi

# ============================================================================
# PHASE 7 TASK 2 (IMPERSONATION) SUITE -- THE BREAK-GLASS PROOF.
#
# Runs LAST of the psql suites and reuses the SAME fixtures whole: the twelve
# Phase 2 users, orgs ALPHA and BETA, and their CRM rows. It creates only
# impersonation_sessions rows (plus the audit_events those produce) and its
# § IZ asserts it leaves NONE of the former behind -- which matters more here
# than for any other suite, because a live session row would hand `super`
# view_crm over ALPHA for the whole of the HTTP block below, and those checks
# were written against a superuser who can read audit_events and nothing else.
#
# P7VARS = P6VARS. It needs the Phase 2 users' claims (powner accepts,
# pbowner is the foreign admin, pmanager is the in-tenant non-admin) plus
# `super`/`super_c`/`super_c1` -- and P6VARS is already exactly that set,
# built for the leakage suite's own audit_events positive control. `super_c1`
# (the aal1 form) is added here because § IG18/IG19 measure that a stolen
# password with no second factor holds nothing even mid-session.
#
# CLAUDE.md § Superuser dashboard makes impersonation the ONLY sanctioned deep-
# access path in the product. Every other suite in this directory proves a
# boundary HOLDS; this is the one that proves a boundary OPENS, exactly as far
# as it was supposed to.
# ============================================================================
P7VARS=( "${P6VARS[@]}" )
P7VARS+=( -v "super_c1={\"sub\":\"${ID[super]}\",\"role\":\"authenticated\",\"aal\":\"aal1\"}" )


run_suite "PHASE 7 IMPERSONATION" rls_phase7_impersonation.sql imp 121 "${P7VARS[@]}"
p7_fails=$SUITE_FAILS
if [ "$p7_fails" != "0" ]; then
  echo "PHASE 7 IMPERSONATION SUITE FAILED: $p7_fails failing assertion(s)" >&2
  echo "  In IP, THE READ-ONLY ENVELOPE HAS WIDENED -- somebody granted a" >&2
  echo "  manage_/merge_ key to the read_only role, which widens what an" >&2
  echo "  impersonating superuser holds, in a migration whose diff says" >&2
  echo "  nothing about impersonation." >&2
  echo "  In IR, THE CONSENT GATE IS GONE -- a foreign admin can see or answer" >&2
  echo "  another tenant's request, or the superuser has a direct write path" >&2
  echo "  into the table and can grant themselves access unilaterally." >&2
  echo "  In IG1-IG5, ACCESS WITHOUT CONSENT: a merely REQUESTED or ACCEPTED" >&2
  echo "  session now grants tenant reads. This is the finding." >&2
  echo "  In IG18/IG19, THE MFA GATE: an aal1 session now holds the grant." >&2
  echo "  In IW, AN IMPERSONATOR CAN WRITE INTO A TENANT." >&2
  echo "  In IX, THE SCOPE BOUNDARY: one organisation's session now reaches" >&2
  echo "  another tenant." >&2
  echo "  In IM, THE TWO HALVES OF THE PERMISSION RULE HAVE DRIFTED -- the" >&2
  echo "  impersonation disjunct is in one function body and not the other." >&2
  echo "  In IE1-IE5, THE TIME-BOX IS NOT ENFORCED: an expired session still" >&2
  echo "  grants. Sev1." >&2
  echo "  In IA, THE AUDIT TRAIL is incomplete, unthreaded, misattributed, or" >&2
  echo "  has started carrying tenant record content." >&2
  echo "  In IS, SUSPENSION BEHAVIOUR CHANGED -- these expectations are a" >&2
  echo "  RECORD of measured behaviour (Q98), so a failure means re-measure" >&2
  echo "  and re-record, not relax." >&2
  echo "  In IZ, this suite left session rows behind and the HTTP checks below" >&2
  echo "  are now running with a superuser who can read a tenant -- discard" >&2
  echo "  the run and reset." >&2
  echo "  Every one of those is Sev1." >&2
  psql_status=1
else
  echo "Phase 7 impersonation suite: all assertions passed."
fi

# ============================================================================
# PHASE 7 TASK 3 (ORGANISATION LIFECYCLE) SUITE.
#
# Runs LAST of the psql suites, after impersonation, and reuses the SAME
# fixtures and the SAME variable set (P7VARS). It suspends, closes and
# reinstates ALPHA repeatedly -- the only suite in this directory that WRITES
# a lifecycle state through the product's own RPCs rather than through a
# postgres-role UPDATE -- and its § LZ asserts it leaves ALPHA active,
# unchanged, and with its original subscription period. That matters more here
# than anywhere else: a workspace left suspended would make every HTTP check
# below run against a read-only tenant, and those were written against a live
# one.
#
# It also DISABLES A TRIGGER for one assertion (§ LV4, the CHECK proved with
# the normaliser off) and re-enables it in the same DO block, which is why it
# runs after everything that depends on public.organisations behaving normally.
# ============================================================================

run_suite "PHASE 7 LIFECYCLE" rls_phase7_lifecycle.sql lc 89 "${P7VARS[@]}"
lc_fails=$SUITE_FAILS
if [ "$lc_fails" != "0" ]; then
  echo "PHASE 7 LIFECYCLE SUITE FAILED: $lc_fails failing assertion(s)" >&2
  echo "  In LV, THE INVARIANT IS BROKEN -- a row can now be 'active' with" >&2
  echo "  deleted_at set, or wound down without it. Thirty-odd permission" >&2
  echo "  gates read deleted_at alone on the strength of that invariant." >&2
  echo "  In LP, CONSEQUENCE P7 IS GONE -- an Owner, a foreign admin or an" >&2
  echo "  aal1 superuser can un-suspend a workspace. Sev1." >&2
  echo "  In LR, EITHER THE WAY BACK IS BROKEN (a one-way door: suspend with" >&2
  echo "  no reinstate) OR THE SANCTIONED-PATH MARKER IS GONE, which means a" >&2
  echo "  raw PATCH can now make an un-audited, un-reasoned lifecycle change." >&2
  echo "  In LA, THE AUDIT TRAIL is incomplete, unthreaded, misattributed, or" >&2
  echo "  has started carrying tenant record content." >&2
  echo "  In LN, THE Q88/Q92/Q101 CLOCKS have moved. These expectations are" >&2
  echo "  FOUNDER RULINGS, so a failure means the code changed, not that the" >&2
  echo "  expectation should." >&2
  echo "  In LZ, this suite left ALPHA wound down and every HTTP check below" >&2
  echo "  is now running against a read-only tenant -- discard the run and" >&2
  echo "  reset." >&2
  psql_status=1
else
  echo "Phase 7 lifecycle suite: all assertions passed."
fi

# ============================================================================
# PHASE 7 TASK 4 (BILLING + FEATURE OVERRIDES) SUITE.
#
# Runs LAST of the psql suites, after lifecycle, and reuses the SAME fixtures
# and the SAME variable set (P7VARS). ALPHA arrives here with no subscription
# row (the lifecycle suite's own § LZ leaves it that way) -- this suite plants
# its own Pro subscription for ALPHA and restores it to nothing at its own
# § OZ, the same save/plant/restore discipline every suite in this chain uses.
# ============================================================================

run_suite "PHASE 7 OVERRIDES" rls_phase7_overrides.sql ov 56 "${P7VARS[@]}"
ov_fails=$SUITE_FAILS
if [ "$ov_fails" != "0" ]; then
  echo "PHASE 7 OVERRIDES SUITE FAILED: $ov_fails failing assertion(s)" >&2
  echo "  In OB, THE EFFECTIVE-TIER RESOLUTION IS WRONG -- an active override" >&2
  echo "  is not being consulted, or a foreign organisation can now read" >&2
  echo "  another tenant's overrides." >&2
  echo "  In OC, THE SANCTIONED-PATH MARKER IS GONE -- an Owner or the" >&2
  echo "  superuser's own raw PATCH can now write an override directly," >&2
  echo "  un-audited." >&2
  echo "  In OD, READ-TIME EXPIRY IS BROKEN -- an expired override is still" >&2
  echo "  being applied, or a live one is being denied early." >&2
  echo "  In OG, DOWNGRADE SAFETY HAS REGRESSED -- an override that lowers" >&2
  echo "  the tier either failed to deny a new write, or deleted existing" >&2
  echo "  data. Sev1." >&2
  echo "  In OH/OI11, THE AUDIT TRAIL is incomplete or misattributed." >&2
  echo "  In OZ, this suite left ALPHA's subscription/override state changed" >&2
  echo "  and every HTTP check below is now running against a different" >&2
  echo "  tenant than the one it was written against -- discard the run and" >&2
  echo "  reset." >&2
  psql_status=1
else
  echo "Phase 7 overrides suite: all assertions passed."
fi

# ============================================================================
# PHASE 7 TASK 5 (RATE LIMITING + INCIDENT ALERTS + PLATFORM HEALTH) SUITE.
#
# Runs LAST of the psql suites, after overrides, and reuses the SAME fixtures
# and the SAME variable set (P7VARS). It is the only suite here that plants a
# row in a TENANT table (two documents, to fire the malware-quarantine
# trigger) -- its own § RZ deletes both, along with every counter and alert it
# created, so the HTTP block below runs against the state it was written
# against. It also takes an alert-table denominator at § RF rather than
# assuming zero, because an earlier suite could raise one.
# ============================================================================

run_suite "PHASE 7 RATE LIMITS" rls_phase7_rate_limits.sql rl 182 "${P7VARS[@]}"
rl_fails=$SUITE_FAILS
if [ "$rl_fails" != "0" ]; then
  echo "PHASE 7 RATE-LIMIT SUITE FAILED: $rl_fails failing assertion(s)" >&2
  echo "  In RV, A SHIPPED RATE LIMIT NO LONGER MATCHES SECURITY.md § 5." >&2
  echo "  The table in that document IS the requirement -- so a failure here" >&2
  echo "  means either the seed changed without the document, or a seventh" >&2
  echo "  category appeared with no § 5 row. Fix the drift, do not relax the" >&2
  echo "  assertion." >&2
  echo "  In RW, THE WINDOW ARITHMETIC MOVED -- windows are no longer" >&2
  echo "  epoch-aligned or no longer close at the boundary, which silently" >&2
  echo "  changes every budget in the product." >&2
  echo "  In RC, COUNTER INTEGRITY IS GONE: an increment is lost, a refusal" >&2
  echo "  is no longer counted (which breaks the exactly-once alert), or a" >&2
  echo "  client role can now write or read counters. Sev1 on the last one --" >&2
  echo "  a client that can UPDATE a counter can zero its own budget." >&2
  echo "  In RS, THE WRAPPER'S SCOPE BINDING BROKE -- a session can spend an" >&2
  echo "  account-scoped budget (locking a stranger out by user id), or a" >&2
  echo "  non-member can burn another tenant's export allowance. Sev1." >&2
  echo "  RS7d/RS7e/RS7g are fix round 1's I1: a user-scoped category must" >&2
  echo "  take NO organisation, so an incident alert can never be attributed" >&2
  echo "  to a workspace the caller merely named. A failure there means the" >&2
  echo "  operator's alert feed can be made to blame an innocent tenant. Sev1." >&2
  echo "  In RA, THE ALERT BOUNDARY: a non-superuser can read platform" >&2
  echo "  alerts, a client can forge or delete one, or the resolve guard now" >&2
  echo "  lets an operator rewrite alert content or stamp notified_at (which" >&2
  echo "  would let them silence Task 6's email without sending it)." >&2
  echo "  In RH, THE LOGIN LOCKOUT IS BROKEN. RH4 is the load-bearing one: a" >&2
  echo "  lockout that lifts for a correct password is not a lockout -- the" >&2
  echo "  brute force simply continues until it succeeds. Sev1." >&2
  echo "  In RQ, A MALWARE QUARANTINE NO LONGER RAISES AN ALERT, or the" >&2
  echo "  alert has started carrying the filename (user-entered content on a" >&2
  echo "  platform surface)." >&2
  echo "  In RP, THE HEALTH SNAPSHOT is reachable by a non-superuser or by" >&2
  echo "  an aal1 session, has stopped auditing itself, or RP10 failed --" >&2
  echo "  which means its projection has grown a field that is not a count," >&2
  echo "  a sum or an organisation name, i.e. the no-direct-tenant-data rule" >&2
  echo "  is broken on the operator's own dashboard. Sev1." >&2
  echo "  In RZ, this suite left counters, alerts or DOCUMENTS behind and" >&2
  echo "  every HTTP check below is now running against a tenant it was not" >&2
  echo "  written against -- discard the run and reset." >&2
  psql_status=1
else
  echo "Phase 7 rate-limit suite: all assertions passed."
fi

# ============================================================================
# PHASE 7 TASK 6 (IN-APP FEEDBACK) SUITE.
#
# Runs LAST of the psql suites, after rate limits, and reuses the SAME
# fixtures and the SAME variable set (P7VARS). It writes feedback rows as
# pstd1/pstd2 (spending pstd2's whole hourly budget on purpose), plants three
# rows as postgres (one three years old, one with a screenshot, one
# quarantined), and its own § FZ deletes every row, counter, alert and audit
# event it created, so the HTTP block below -- which spends CAROL's budget,
# not theirs -- runs against the state it was written against.
# ============================================================================

run_suite "PHASE 7 FEEDBACK" rls_phase7_feedback.sql fb 151 "${P7VARS[@]}"
fb_fails=$SUITE_FAILS
if [ "$fb_fails" != "0" ]; then
  echo "PHASE 7 FEEDBACK SUITE FAILED: $fb_fails failing assertion(s)" >&2
  echo "  In FP, THE COLUMN-NARROW GRANTS HAVE WIDENED -- a submitter can now" >&2
  echo "  name user_id/role/status, or a client can DELETE, or the sender can" >&2
  echo "  rewrite content." >&2
  echo "  In FI, ATTRIBUTION IS FORGEABLE (FI6-FI11: Task 5 finding I1's class," >&2
  echo "  on a second platform table) or a refused forgery now spends budget" >&2
  echo "  (FI12) or the submission is no longer audited (FI13). Sev1 on FI9." >&2
  echo "  In FR, A NON-SUPERUSER READS FEEDBACK (the submitter, a colleague, a" >&2
  echo "  foreign Owner or an aal1 superuser), or RETENTION HAS STOPPED" >&2
  echo "  EXPIRING AT READ TIME (FR6)." >&2
  echo "  In FU, THE STATUS-ONLY GATE IS GONE (FU3/FU4/FU10) or the status" >&2
  echo "  change is no longer audited (FU2)." >&2
  echo "  In FM, THE 10/HOUR BUDGET NO LONGER BINDS THE WRITE (Task 5 finding" >&2
  echo "  I2's class): a direct PostgREST INSERT is unmetered, or refusals are" >&2
  echo "  being counted, or the crossing alert is missing/attributed." >&2
  echo "  In FA, A SCREENSHOT VIEW CAN GO UNAUDITED -- a non-superuser or an" >&2
  echo "  aal1 session can mint the audit row, or a quarantine files no alert." >&2
  echo "  In FZ, this suite left rows behind and the HTTP block below is now" >&2
  echo "  running against state it was not written against -- discard the run." >&2
  psql_status=1
else
  echo "Phase 7 feedback suite: all assertions passed."
fi

# ============================================================================
# PHASE 7 TASK 6b (FULL CRM WRITE AUDITING) SUITE.
#
# Runs LAST of the psql suites, after feedback, on the SAME fixtures and the
# SAME variable set (P7VARS). It plants its own CRM rows in ALPHA as postgres
# (sessionless, so un-audited), writes to them as pmanager/padmin, and its own
# § CZ deletes every row and audit event it created, so the HTTP block below
# runs against the state it was written against.
# ============================================================================

run_suite "PHASE 7 CRM AUDIT" rls_phase7_crm_audit.sql ca 128 "${P7VARS[@]}"
ca_fails=$SUITE_FAILS
if [ "$ca_fails" != "0" ]; then
  echo "PHASE 7 CRM AUDIT SUITE FAILED: $ca_fails failing assertion(s)" >&2
  echo "  In CA, THE TRIGGER CENSUS OR THE ALLOWLIST MOVED -- a table lost its" >&2
  echo "  audit pair, or private.audit_crm_value_columns() now names a CONTENT" >&2
  echo "  column (CA5), which is a superuser-readable channel for tenant data." >&2
  echo "  In CU, THE NO-CONTENT-LEAK PROPERTY IS BROKEN: an UPDATE's audit row" >&2
  echo "  carries a user-entered value. Sev1 -- CLAUDE.md § Superuser dashboard." >&2
  echo "  In CD, soft-delete/restore are no longer distinguishable actions." >&2
  echo "  In CX, THE EXEMPTION IS WRONG: a definer-context write is un-audited" >&2
  echo "  (Task 5 I4's class), or a sessionless/no-op write now emits rows." >&2
  echo "  In CB, A BULK PATH SPRAYS UN-CORRELATED ROWS, or the thread is left" >&2
  echo "  open past the wrapper, or an *_unthreaded body became reachable." >&2
  echo "  In CZ, this suite left rows behind -- discard the run and reset." >&2
  psql_status=1
else
  echo "Phase 7 CRM audit suite: all assertions passed."
fi

# ============================================================================
# PHASE 8 TASK 1 (VERSIONED LEGAL DOCUMENTS) SUITE.
#
# Runs LAST of the psql suites, on the SAME fixtures and the SAME variable set
# (P7VARS). It drafts, publishes and reviews real versions, then its own § LZ
# puts the fifteen seeded rows back byte for byte (under
# session_replication_role = replica, because the immutability guard refuses
# the undo for every role -- which is the point) and deletes its audit rows,
# so the HTTP block below reads exactly the seed.
# ============================================================================

run_suite "PHASE 8 LEGAL" rls_phase8_legal.sql lg 168 "${P7VARS[@]}"
lg_fails=$SUITE_FAILS
if [ "$lg_fails" != "0" ]; then
  echo "PHASE 8 LEGAL DOCUMENTS SUITE FAILED: $lg_fails failing assertion(s)" >&2
  echo "  In LA/LD/LP, THE PUBLIC READ WIDENED -- a signed-out visitor can see a" >&2
  echo "  draft, a superseded version, or a column outside the grant (the" >&2
  echo "  reviewer name). Sev1: it is the one table anon can read." >&2
  echo "  In LW/LG, A CLIENT ROLE CAN WRITE the store directly, around the" >&2
  echo "  audited RPCs." >&2
  echo "  In LI, A PUBLISHED TEXT IS NO LONGER IMMUTABLE -- the thing a consent" >&2
  echo "  will point at can be edited after the fact." >&2
  echo "  In LD/LP/LR/LO, A NON-SUPERUSER (or an aal1 superuser) can draft," >&2
  echo "  publish, review or read drafts." >&2
  echo "  In LV, THE GRAMMAR'S DATABASE HALF IS GONE -- a javascript:/data: link," >&2
  echo "  a tag or an unknown placeholder can be stored." >&2
  echo "  In LH, a write went unaudited, or an audit row carries document text or" >&2
  echo "  the reviewer's name." >&2
  echo "  In LZ, the seed was not restored -- discard the run and reset." >&2
  psql_status=1
else
  echo "Phase 8 legal documents suite: all assertions passed."
fi

# ============================================================================
# PHASE 8 TASK 2 (THE CONSENT LEDGER) SUITE.
#
# Runs LAST of the psql suites, after the legal suite has put the legal store
# back, on the SAME fixtures (P7VARS). It records real consents as the Phase 2
# users, publishes (and then removes) a version 3 of the marketing page, and
# its own § CZ deletes every consent, counter, alert and audit row it made and
# proves the legal store is byte-for-byte what it found, so the HTTP block
# below reads the migrated rows.
# ============================================================================

run_suite "PHASE 8 CONSENTS" rls_phase8_consents.sql cs 143 "${P7VARS[@]}"
cs_fails=$SUITE_FAILS
if [ "$cs_fails" != "0" ]; then
  echo "PHASE 8 CONSENT LEDGER SUITE FAILED: $cs_fails failing assertion(s)" >&2
  echo "  In CW, ATTRIBUTION IS FORGEABLE -- a consent landed for somebody other" >&2
  echo "  than the session, a sessionless write landed, or a forged column" >&2
  echo "  survived the trigger. Sev1: a consent record is evidence." >&2
  echo "  In CR, A USER CAN READ SOMEBODY ELSE'S CONSENTS, or the oversight read" >&2
  echo "  is no longer aal2-gated." >&2
  echo "  In CH, HISTORY CAN BE REWRITTEN -- an update, delete or truncate got" >&2
  echo "  past the guard." >&2
  echo "  In CV, a consent can be recorded against a version the person was not" >&2
  echo "  shown, or a withdrawal can be blocked by a stale page." >&2
  echo "  In CC, the sender's check answers wrongly or is callable by a user." >&2
  echo "  In CM, the grant meter moved, or a WITHDRAWAL is now metered." >&2
  echo "  In CA, an event went unaudited or an audit row carries more than ids." >&2
  echo "  In CZ, this suite left rows behind -- discard the run and reset." >&2
  psql_status=1
else
  echo "Phase 8 consent ledger suite: all assertions passed."
fi

# ============================================================================
# PHASE 8 TASK 3 (DATA SUBJECT REQUESTS) SUITE.
#
# Runs after the consent suite, on the same P7VARS fixtures, and its own
# section DZ removes every request, note, counter, alert and audit row it
# made -- so the HTTP block below and the race above still meet the database
# they were written against.
# ============================================================================

run_suite "PHASE 8 DATA SUBJECT REQUESTS" rls_phase8_data_subject_requests.sql dsr 225 "${P7VARS[@]}"
dsr_fails=$SUITE_FAILS
if [ "$dsr_fails" != "0" ]; then
  echo "PHASE 8 DATA SUBJECT REQUEST SUITE FAILED: $dsr_fails failing assertion(s)" >&2
  echo "  In DF, THE 30-DAY CLOCK OR THE TASK 4/5 SEAM HAS MOVED -- a deadline" >&2
  echo "  that can be written, or a fulfilment a client can declare." >&2
  echo "  In DW, ATTRIBUTION IS FORGEABLE, or a request can be rewritten after" >&2
  echo "  the fact. Sev1: a request and its deadline are the evidence." >&2
  echo "  In DR, SOMEBODY CAN READ ANOTHER PERSON'S REQUEST, or the operator's" >&2
  echo "  oversight read is no longer aal2-gated." >&2
  echo "  In DT, THE STATE MACHINE IS GONE -- an illegal transition landed, the" >&2
  echo "  operator withdrew for the requester, or the requester progressed one." >&2
  echo "  In DN, THE REQUESTER CAN READ OPERATOR NOTES (Q103)." >&2
  echo "  In DM, the submission meter moved, or a WITHDRAWAL is now metered." >&2
  echo "  In DA, a transition went unaudited or an audit row carries free text." >&2
  echo "  In DD, AN OVERDUE REQUEST RAISES NO ALERT -- the deadline can now be" >&2
  echo "  missed silently -- or a closed one raises one, or a tick duplicates." >&2
  echo "  In DZ, this suite left rows behind -- discard the run and reset." >&2
  psql_status=1
else
  echo "Phase 8 data subject request suite: all assertions passed."
fi

# ============================================================================
# PHASE 8 TASK 4 (DATA EXPORTS) SUITE.
#
# Runs after the data subject request suite, on the same P7VARS fixtures,
# and its own section XZ removes every job, note, counter, request and audit
# row it made -- so the HTTP block below still meets the database it was
# written against.
#
# It is the suite that finally gives the data subject register's fulfilment
# seam a POSITIVE CONTROL: until this task `service_role` held no grant at
# all on public.data_subject_requests, so § DF of the suite above could not
# tell a working guard from a missing privilege and had to open the grant
# inside its own rolled-back transaction. § XS asks the same question through
# the real catalogue.
# ============================================================================

run_suite "PHASE 8 EXPORTS" rls_phase8_exports.sql xp 137 "${P7VARS[@]}"
exp_fails=$SUITE_FAILS
if [ "$exp_fails" != "0" ]; then
  echo "PHASE 8 EXPORT SUITE FAILED: $exp_fails failing assertion(s)" >&2
  echo "  In XG, a client role gained a write on the register, the bucket lost" >&2
  echo "  its fence, or a runner RPC became reachable from a browser." >&2
  echo "  In XC, THE EXPORT IS NO LONGER COMPLETE -- a table with a row ->" >&2
  echo "  organisation or row -> user path is in neither disposition." >&2
  echo "  In XW, ATTRIBUTION IS FORGEABLE, a Manager can export a workspace," >&2
  echo "  or a meter moved. Sev1." >&2
  echo "  In XR, SOMEBODY CAN SEE ANOTHER PERSON'S EXPORT JOB." >&2
  echo "  In XJ, a person's session can write a job's outcome, or a finished" >&2
  echo "  job became rewritable." >&2
  echo "  In XP, THE READ ENGINE LEAKS: a colleague's PRIVATE note or another" >&2
  echo "  tenant's row reached an archive, or -- read XP2-XP4 first -- the" >&2
  echo "  engine returned nothing at all and the absences mean nothing. Sev1." >&2
  echo "  In XD, THE IDOR OR EXPIRY GATE ON DOWNLOADS IS GONE, or a download" >&2
  echo "  stopped being audited." >&2
  echo "  In XS, the fulfilment seam: the export half went back to sleep, the" >&2
  echo "  service_role grant widened past its two columns, or the guard's" >&2
  echo "  role leg went back to naming the CLIENT roles." >&2
  echo "  In XZ, this suite left rows behind -- discard the run and reset." >&2
  psql_status=1
else
  echo "Phase 8 data export suite: all assertions passed."
fi

# ============================================================================
# PHASE 8 TASK 5 (ERASURE) SUITE.
#
# Runs after the export suite, on the same P7VARS fixtures. It is the only
# suite in this directory that DELETES auth accounts -- and every account it
# deletes is one it created itself in its own section EF, with its own
# throwaway workspaces. Its section EX counts organisation ALPHA's rows before
# and after the erasure, and its section EZ removes every row it made, so the
# HTTP block below still meets the database it was written against.
#
# It is also where the Q130 TOMBSTONE's three enforced properties are asserted
# (it cannot sign in, cannot be a member of anything, cannot be deleted), and
# where the thirteen no-ON-DELETE foreign keys to auth.users are PINNED BY
# NAME -- the erasure derives them from pg_constraint rather than listing
# them, so this is the only place a fourteenth arrives as a red assertion
# instead of as an account that silently cannot be deleted.
# ============================================================================

run_suite "PHASE 8 ERASURE" rls_phase8_erasure.sql er 143 "${P7VARS[@]}"
era_fails=$SUITE_FAILS
if [ "$era_fails" != "0" ]; then
  echo "PHASE 8 ERASURE SUITE FAILED: $era_fails failing assertion(s)" >&2
  echo "  In ET, THE TOMBSTONE IS NOT SAFE -- it can be given a password, have" >&2
  echo "  its ban lifted, hold a membership, or be deleted. Every pseudonymised" >&2
  echo "  audit row in the product hangs from that one identity. Sev1." >&2
  echo "  In EB, THE BLOCKER LIST MOVED. A fourteenth no-ON-DELETE foreign key" >&2
  echo "  to auth.users, or a COMPOSITE one the re-point walk cannot see." >&2
  echo "  Re-measure, update EB1/EB2, and check erase_account still passes." >&2
  echo "  In EG, a client role gained a write on the register, or a runner RPC" >&2
  echo "  became reachable from a browser." >&2
  echo "  In EW, ATTRIBUTION IS FORGEABLE -- somebody can ask for SOMEBODY" >&2
  echo "  ELSE'S account to be deleted. Sev1." >&2
  echo "  In EL, THE Q131 LAST-OWNER GUARD IS GONE, or it has stopped saying" >&2
  echo "  what the person must do first." >&2
  echo "  In EE, THE ERASURE ITSELF. Read EE1-EE10 FIRST: they are the" >&2
  echo "  denominators, and if one of them is red then every absence below it" >&2
  echo "  proves nothing. A red EE22 means a PRIVATE note was left" >&2
  echo "  unreadable-but-stored; a red EE31 means the register row that is the" >&2
  echo "  evidence of the deadline was destroyed by the deletion it recorded." >&2
  echo "  In EJ, a finished job became rewritable or re-pointable." >&2
  echo "  In EX, THE ERASURE REACHED ANOTHER TENANT. Sev1." >&2
  echo "  In ER, THE ERASURE IS NOT ALL-OR-NOTHING -- a mid-sequence failure" >&2
  echo "  left part of an account deleted. Sev1." >&2
  echo "  In EO, the workspace purge: an entity type went unswept, the" >&2
  echo "  discarded record's values survived, or the \`replica\` refusal is gone" >&2
  echo "  -- which is what would leave a routed request pointing at nothing." >&2
  echo "  In ES, the fulfilment seam. ES4 is the POSITIVE CONTROL: if it is" >&2
  echo "  red, every refusal beside it may be a constraint refusing everything." >&2
  echo "  In EZ, this suite left rows behind -- discard the run and reset." >&2
  psql_status=1
else
  echo "Phase 8 erasure suite: all assertions passed."
fi

# ============================================================================
# ONE WITHDRAWAL PER GRANT UNDER A REAL RACE (review finding M2).
#
# The trigger's alternation rule serialises events per (user, purpose), but
# under REPEATABLE READ two sessions that took their snapshots before either
# inserted both read the same grant as "newest" -- the review committed two
# withdrawals of one grant that way. 20260923004000 makes withdraws_id unique.
# This drives the race for real: two sessions, each REPEATABLE READ, each
# takes its snapshot, sleeps, then withdraws. Exactly one may land.
# ============================================================================
race_user=$(MSYS_NO_PATHCONV=1 docker exec "$CTR" psql -U postgres -d postgres -tAc \
  "insert into auth.users (id, instance_id, aud, role, email)
   values (gen_random_uuid(), '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
           'consent-race-' || gen_random_uuid() || '@test.local') returning id" | head -1 | tr -d '[:space:]')
race_claims="{\"sub\":\"$race_user\",\"role\":\"authenticated\"}"
race_ver=$(MSYS_NO_PATHCONV=1 docker exec "$CTR" psql -U postgres -d postgres -tAc \
  "select version from public.legal_documents where slug='marketing-preferences' and status='published'" \
  | tr -d '[:space:]')
MSYS_NO_PATHCONV=1 docker exec "$CTR" psql -U postgres -d postgres -q -tA -c \
  "set role authenticated; set request.jwt.claims = '$race_claims';
   select count(*) from public.record_consent('marketing_email','granted',$race_ver,'marketing-email-1');" > /dev/null
race_sql="begin isolation level repeatable read;
  set local role authenticated;
  set local request.jwt.claims = '$race_claims';
  select count(*) from public.consents;
  select pg_sleep(2);
  select count(*) from public.record_consent('marketing_email','withdrawn',null,null);
  commit;"
race_dir=$(mktemp -d)
MSYS_NO_PATHCONV=1 docker exec "$CTR" psql -U postgres -d postgres -q -tA -c "$race_sql" > "$race_dir/a" 2>&1 &
race_a=$!
sleep 0.5
MSYS_NO_PATHCONV=1 docker exec "$CTR" psql -U postgres -d postgres -q -tA -c "$race_sql" > "$race_dir/b" 2>&1 &
race_b=$!
wait "$race_a" || true
wait "$race_b" || true
race_rows=$(MSYS_NO_PATHCONV=1 docker exec "$CTR" psql -U postgres -d postgres -tAc \
  "select count(*) || '/' || count(distinct withdraws_id) from public.consents
    where user_id = '$race_user' and action = 'withdrawn'" | tr -d '[:space:]')
race_errors=$(cat "$race_dir/a" "$race_dir/b" | grep -cE 'ERROR: .*(consents_withdraws_id_key|could not serialize)' || true)
race_overlap=$(cat "$race_dir/a" "$race_dir/b" | grep -c 'ERROR' || true)
MSYS_NO_PATHCONV=1 docker exec "$CTR" psql -U postgres -d postgres -q -c \
  "delete from public.audit_events where actor_user_id = '$race_user';
   delete from auth.users where id = '$race_user';
   delete from public.rate_limit_counters where category = 'consent_grant' and subject_id = '$race_user';" > /dev/null
if [ "$race_rows" != "1/1" ] || [ "$race_errors" != "1" ] || [ "$race_overlap" != "1" ]; then
  echo "CONSENT WITHDRAWAL RACE FAILED: withdrawals/distinct-grants=$race_rows (want 1/1)," >&2
  echo "  refusals by the unique index or a serialization failure=$race_errors (want 1)," >&2
  echo "  errors of any kind=$race_overlap (want 1). Session output:" >&2
  sed 's/^/    A: /' "$race_dir/a" >&2
  sed 's/^/    B: /' "$race_dir/b" >&2
  echo "  A GRANT CAN BE WITHDRAWN TWICE -- the ledger no longer alternates." >&2
  psql_status=1
else
  echo "Consent withdrawal race (2 x REPEATABLE READ): one landed, the other was refused."
fi
rm -rf "$race_dir"

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
# Task 6b: the four multi-row CRM RPCs were MOVED to private.*_unthreaded and
# wrapped under their own names so every call opens one audit thread. The
# moved bodies must not be routable, or a caller could skip the thread.
probe "private merge_records_unthreaded not an RPC"              404 "rpc/merge_records_unthreaded"
probe "private set_contact_primary_company_unthreaded not an RPC" 404 "rpc/set_contact_primary_company_unthreaded"
probe "private set_artist_primary_representation_unthreaded not an RPC" 404 "rpc/set_artist_primary_representation_unthreaded"
probe "private set_custom_field_values_unthreaded not an RPC"    404 "rpc/set_custom_field_values_unthreaded"
probe "private begin_crm_bulk_audit not an RPC"                  404 "rpc/begin_crm_bulk_audit"
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

# PHASE 7 TASK A: the psql suites above (specifically network_leakage_phase6.sql's
# LZ2/LI, the last thing to touch it) deliberately leave ALPHA row-less when
# they finish -- that is the state their OWN assertions are about, and it is
# unrelated to this section. Before Task A that was harmless here too, because
# private.crm_write_organisations()'s "no subscription row" escape meant a
# row-less ALPHA still accepted every CRM write below (e.g. "booker POSTs an
# artist"). That escape is gone, so a row-less ALPHA now REFUSES those writes,
# for a reason this section's own text says nothing about. Give both fixture
# organisations a real, working row before any write assertion below runs --
# `on conflict` because BETA already carries the Starter row
# public.create_organisation() writes at birth, and this section's writers act
# as ALPHA members only, so BETA only needs enough to not be row-less should a
# future assertion here name it.
MSYS_NO_PATHCONV=1 docker exec "$CTR" psql -U postgres -d postgres -q -c \
  "insert into public.organisation_subscriptions
     (organisation_id, plan_id, billing_cycle, seat_count, status, current_period_end)
   values ('$ALPHA_ORG','pro','monthly',1,'active', now() + interval '30 days'),
          ('$BETA_ORG','pro','monthly',1,'active', now() + interval '30 days')
   on conflict (organisation_id) do update set plan_id='pro', status='active';" > /dev/null

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

# STRIP the row entirely -- PHASE 7 TASK A FLIPPED THIS. It used to prove "no
# subscription row = the escape = writes allowed again"; the escape is gone,
# so the same statement now proves the opposite: a row-less organisation is
# DENIED, not returned to some inert default. Matches rls_phase2_crm.sql
# § N's N1/N16 at this same layer.
p2_sub "delete from public.organisation_subscriptions where organisation_id='$ALPHA_ORG';"
p2_code "STRIPPED: no subscription row, writes are now DENIED (escape removed)" 403 POST "artists" \
        "{\"organisation_id\":\"$ALPHA_ORG\",\"name\":\"stripped artist\"}" "$BKR"

# ...and leave ALPHA on a REAL, working row. There is no more inert state to
# rest on between sections -- "Phase 3 events at the API surface" immediately
# below needs ALPHA's CRM writes to keep working, and so does every HTTP
# section after it.
p2_sub "insert into public.organisation_subscriptions
          (organisation_id, plan_id, billing_cycle, seat_count, status, current_period_end)
        values ('$ALPHA_ORG','pro','monthly',1,'active', now() + interval '30 days');"

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
# is LIVE and SUBSCRIBED (the block above restores a real Pro row on its last
# line -- PHASE 7 TASK A removed private.crm_write_organisations()'s "no
# subscription row" escape, so a 201 below is meaningful only with a real,
# working row behind it, not despite the absence of one), and BEFORE the
# suspension block further down soft-deletes the organisation. Between those
# two is the only window where a 201 means "the policy allowed it" and not
# "the entitlement gate happened to be open" (or, pre-Task-A, "closed").
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

# PHASE 7 TASK A: there is no more "no subscription row = inert" state to
# restore ALPHA to -- private.crm_write_organisations()'s escape is gone, and
# the "Custom field VALUES at the API surface" section immediately below
# writes through set_custom_field_values(), which is itself a CRM write
# gated by that same function (20260829011000). Deleting the row here would
# deny that section's own LIVE CONTROL. Restore to STARTER instead -- a real,
# working tier, same as ALPHA already carries above this block.
p2_sub "update public.organisation_subscriptions set plan_id='starter', status='active'
        where organisation_id='$ALPHA_ORG';"

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
#
# IT NEEDS A REAL SUBSCRIPTION ROW (PHASE 7 TASK A), planted below alongside
# it. screen_for_duplicates() and merge_records() are CRM writes, gated by
# private.crm_write_organisations() (rls_phase2_crm.sql's § W header names it
# explicitly), and that function's "no subscription row" escape is gone --
# without a row of its own this organisation would refuse every merge in this
# section before its own logic was ever reached.
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
        insert into public.organisation_subscriptions
          (organisation_id, plan_id, billing_cycle, seat_count, status, current_period_end)
        values ('$MERGE_ORG','starter','monthly',1,'active', now() + interval '30 days')
        on conflict (organisation_id) do nothing;
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

# ============================================================================
# PHASE 6 NETWORK AT THE API SURFACE (Task 1).
#
# N6 / Q70 -- "No public, logged-out profiles at MVP" -- is enforced by the
# GRANT, not by the absence of a route, and the psql § NG proves the ACL. THIS
# proves the consequence at the layer it applies to: the anon key that ships in
# every browser bundle, pointed straight at PostgREST, with no Next.js app on
# its path. The psql assertion and this one fail for different reasons, which
# is why both exist -- a grant could be right while the view was published to
# the wrong schema, and vice versa.
#
# EVERY CHECK IS PAIRED. A 401 on its own is satisfied by a URL that does not
# resolve, so each anon refusal is followed by the SAME URL with a real
# member's JWT returning rows.
# ============================================================================
echo
echo "=== Phase 6 network at the API surface (Task 1) ==="

p2_code "anon GET network_directory"                 401 GET "network_directory?select=id"
p2_code "anon GET network_connected_profiles"        401 GET "network_connected_profiles?select=id"
p2_code "anon GET network_profiles"                  401 GET "network_profiles?select=id"
p2_code "anon GET network_connection_requests"       401 GET "network_connection_requests?select=id"
p2_code "anon GET network_links"                     401 GET "network_links?select=id"

# THE POSITIVE CONTROL FOR ALL FIVE: the same directory URL, with a member's
# token, returns the two published profiles the psql suite left behind.
# FOUR published live profiles survive the psql suite: ALPHA's one and BETA's
# three (one for section NR's withdraw-and-retry pair, one for section NU5's
# pending-row recipient-withdraw probe, added in fix round 1).
p2_rows "CONTROL: a member's JWT GETs all four published profiles"  4 \
        "network_directory?select=id" "$MGR"

# THE MASK, OVER REAL HTTP. ALPHA's contact_email is `connections`-level and
# BETA has not connected to ALPHA through any request the HTTP block made -- the
# psql suite's accepted connection is between ALPHA and BETA, so read it as a
# THIRD party would... except there is no third org in the fixtures. So this is
# read as ALPHA's own manager, for whom the DIRECTORY view still masks it: the
# view is column-masking, not caller-privileging, and that is the point.
p2_json "the directory masks a connections-level field over HTTP" "<null>" \
        "network_directory?select=contact_email&id=eq.e0110000-0000-0000-0000-00000000000a" \
        "$MGR" "contact_email"
p2_json "CONTROL: ...while a network-level field on the same row resolves" "Bristol" \
        "network_directory?select=city&id=eq.e0110000-0000-0000-0000-00000000000a" \
        "$MGR" "city"

# organisation_id IS NOT A COLUMN, so PostgREST cannot be asked for it -- 400,
# not an empty string. This is the transport-level form of the NC4 assertion.
p2_code "the directory has no organisation_id to select (400, not a value)" 400 GET \
        "network_directory?select=organisation_id" "" "$MGR"
p2_code "...nor entity_id"                                                 400 GET \
        "network_directory?select=entity_id" "" "$MGR"
p2_code "CONTROL: selecting a real column of the same view works"          200 GET \
        "network_directory?select=display_name" "" "$MGR"

# ===========================================================================
# TASK 3 LEAKAGE ASSERTION #1 -- THE BASE TABLE IS READABLE BY DESIGN, AND
# THAT IS EXPECTED AND CORRECT.
#
# Paired with the source-shape assertion in
# tests/unit/network/discovery-source-shape.test.ts that no application code
# path (lib/network/discovery.ts, the directory page, the profile page) ever
# selects from network_profiles for a foreign organisation. This half proves
# the OTHER fact the pairing depends on: that the base table itself would
# happily hand over the unmasked row if something did.
# `network_profiles_select_published_directory`'s own comment: "the base
# table is deliberately readable and the VIEW is the masking control;
# organisation_id, entity_id and every field the publisher marked hidden are
# reachable HERE and are absent from the view."
#
# ---------------------------------------------------------------------------
# FIX ROUND 1, I1: ALPHA AND BETA ARE CONNECTED BY THIS POINT, AND THAT IS
# THE TRUE STATE -- STATED, NOT PAPERED OVER.
# ---------------------------------------------------------------------------
# The psql suites run BEFORE this HTTP section, on the SAME database, with no
# reset between them (this script's own header, "the fixtures are
# deliberately left standing for the HTTP sections to read"). rls_phase6_
# network.sql's NR9/NU4 (:887-894, :930-933) accept a request FROM alpha_org
# (profile '...000a') TO beta_org (profile '...000c', "Beta Second Room"),
# and NU12 (:1115-1117) then asserts that $MGR -- ALPHA's own manager, the
# EXACT token this block uses -- reads BETA's UNRELATED profile '...000b'
# ("Beta Bookings") through public.network_connected_profiles. That works
# ONLY because the connected view's `exists` clause is ORGANISATION TO
# ORGANISATION, not profile to profile (20260904004000's own header): once
# ANY accepted request stands between alpha_org and beta_org, every one of
# BETA's published profiles becomes connections-visible to ALPHA, regardless
# of which specific profile the request named. So ALPHA and BETA, as
# organisations, ARE connected when this block runs -- an earlier version of
# this comment said the opposite, which was false at HEAD (Constraint 13).
#
# THAT CONNECTION DOES NOT WEAKEN WHAT THIS PARTICULAR ASSERTION PROVES.
# organisation_id and entity_id are structurally ABSENT from BOTH masking
# views under every condition -- connected or not, `network` or
# `connections` -- so reading them straight off network_profiles is a
# leak regardless of the connection state; nothing about being connected
# changes whether a column exists in a view's SELECT list. What connection
# status DOES change is a `connections`-level VALUE's visibility through
# `network_connected_profiles` specifically -- and this block never queries
# that view, only the base table and, in the paired control below,
# `network_directory`, whose `= 'network'` test does not vary with
# connection status either (`network_directory` never resolves a
# `connections`-level field for anyone, connected or not).
#
# ---------------------------------------------------------------------------
# FIX ROUND 1, I2: A POPULATED MASKED VALUE, NOT JUST TWO ABSENT COLUMNS.
# ---------------------------------------------------------------------------
# The brief's own wording: "a hand-crafted GET ... returns rows WITH EVERY
# MASKED COLUMN POPULATED". organisation_id/entity_id are masked by being
# OMITTED FROM THE VIEW ENTIRELY -- they prove the view's column list is
# narrower than the base table's, which is real but not what the brief asks
# for. What it asks for is a `field_visibility`-masked VALUE: a `hidden`
# field is NULL in the base column too (N3, `network_profiles_hidden_
# fields_are_null`), so there is nothing to leak there by construction --
# the only column that can be BOTH populated AND masked is one at
# `connections`. BETA's `...000b` carries none (`field_visibility =
# '{"city":"network"}'`, `rls_phase6_network.sql:149-155`), so it is given
# one here, narrowly, for this block alone -- nothing later in this script
# reads `...000b`'s `contact_email` or `field_visibility` (grepped).
p2_sub "update public.network_profiles
          set contact_email = 'leak-check@beta.test',
              field_visibility = field_visibility || '{\"contact_email\":\"connections\"}'::jsonb
        where id = 'e0110000-0000-0000-0000-00000000000b';"

p2_json "LEAKAGE #1a (documented, by design): a connections-level VALUE is readable straight off network_profiles" \
        "leak-check@beta.test" \
        "network_profiles?select=contact_email&id=eq.e0110000-0000-0000-0000-00000000000b" \
        "$MGR" "contact_email"
p2_json "PAIRED CONTROL: the SAME field, through network_directory, is still masked to null (the view's \`= 'network'\` test does not vary with connection status)" \
        "<null>" \
        "network_directory?select=contact_email&id=eq.e0110000-0000-0000-0000-00000000000b" \
        "$MGR" "contact_email"

p2_json "LEAKAGE #1b: the same non-owning manager reads BETA's organisation_id straight off network_profiles" \
        "$BETA_ORG" \
        "network_profiles?select=organisation_id&id=eq.e0110000-0000-0000-0000-00000000000b" \
        "$MGR" "organisation_id"
p2_json "...and BETA's entity_id, also unmasked (the view projects neither, ever, regardless of connection status)" \
        "1111000b-0000-0000-0000-00000000000b" \
        "network_profiles?select=entity_id&id=eq.e0110000-0000-0000-0000-00000000000b" \
        "$MGR" "entity_id"
p2_json "CONTROL: the same row's display_name, so this is a real row and not an empty result" \
        "Beta Bookings" \
        "network_profiles?select=display_name&id=eq.e0110000-0000-0000-0000-00000000000b" \
        "$MGR" "display_name"

# NO WRITE PATH THROUGH EITHER VIEW. Both project computed CASE expressions, so
# they are not auto-updatable and Postgres itself refuses -- belt and braces
# over the absent grant.
# 403, not 405: the view carries a SELECT grant and nothing else, so PostgREST
# is refused at the PRIVILEGE layer before it ever reaches the question of
# whether the view is auto-updatable. Both refusals are real; this is the one
# that happens first, and asserting the other would be asserting a mechanism
# that never runs.
p2_code "a POST into the directory view is refused (no INSERT grant)"  403 POST "network_directory" \
        '{"display_name":"planted"}' "$MGR"

# THE TIER GATE AT THE TRANSPORT. The psql § NT proves it in-database; this is
# the same gate through PostgREST, which is where a Free-tier customer's browser
# actually meets it.
p2_sub "insert into public.organisation_subscriptions
          (organisation_id, plan_id, billing_cycle, seat_count, status, current_period_end)
        values ('$ALPHA_ORG','free','monthly',1,'active', now() + interval '30 days')
        on conflict (organisation_id) do update set plan_id='free', status='active';"
p2_code "FREE: a network profile POST is refused 403 (network_publish=false)" 403 POST \
        "network_profiles" \
        "{\"organisation_id\":\"$ALPHA_ORG\",\"entity_kind\":\"artist\",\"entity_id\":\"44440000-0000-0000-0000-000000000001\",\"display_name\":\"Free HTTP Profile\"}" "$MGR"
p2_rows "FREE: ...while browsing the directory still returns all 4 rows (view-only tier)" 4 \
        "network_directory?select=id" "$MGR"
p2_sub "update public.organisation_subscriptions set plan_id='starter'
        where organisation_id='$ALPHA_ORG';"
p2_code "STARTER: the SAME POST is allowed (the gate is the plan, not a door)" 201 POST \
        "network_profiles" \
        "{\"organisation_id\":\"$ALPHA_ORG\",\"entity_kind\":\"artist\",\"entity_id\":\"44440000-0000-0000-0000-000000000001\",\"display_name\":\"Starter HTTP Profile\"}" "$MGR"
p2_sub "delete from public.organisation_subscriptions where organisation_id='$ALPHA_ORG';"

# TENANT BOUNDARY, aimed at the other tenant's org id -- the request an attacker
# sends, since the org id is in every URL.
p2_rows "manager GET network_links of org BETA (expect 0)"  0 \
        "network_links?select=id&organisation_id=eq.$BETA_ORG" "$MGR"
p2_code "manager POSTs a network profile into org BETA"   403 POST "network_profiles" \
        "{\"organisation_id\":\"$BETA_ORG\",\"entity_kind\":\"company\",\"entity_id\":\"1111000b-0000-0000-0000-00000000000b\",\"display_name\":\"planted\"}" "$MGR"
p2_code "manager DELETEs a network profile (no DELETE grant)" 403 DELETE \
        "network_profiles?id=eq.e0110000-0000-0000-0000-00000000000a" "" "$MGR"

# ============================================================================
# PHASE 6 NETWORK AT THE API SURFACE, TASK 4: THE SENDER-CANNOT-ACCEPT PROOF,
# OVER REAL HTTP.
#
# The psql suite's NU1/NU3/NU4 already prove this at the policy layer. This is
# the same finding through PostgREST, with the public anon key and no Next.js
# app on the path -- the request an attacker (or a stray client) actually
# sends, which never meets acceptConnectionRequestAction's own authorisation.
#
# A FRESH PAIR OF PROFILES AND A FRESH REQUEST, not a reuse of an earlier
# section's rows: every request planted earlier in this script (by the psql
# suites, which ran before this HTTP block on the same database) is already
# terminal (accepted/declined/withdrawn) or belongs to a different pair, and
# reusing one risks the transition guard pre-empting the POLICY this block is
# about -- exactly the NU5 finding's own header warns against ("the expected
# value was itself the tell").
#
# A BETA-SIDE ACTOR IS NEEDED THAT DOES NOT REQUIRE aal2. pbowner (BETA's
# owner) and pmulti (admin in both orgs) both need MFA for manage_network_
# connections, and a password grant over HTTP yields aal1 only (measured
# earlier in this script's "MFA enforcement" block) -- so neither could ACCEPT
# here even correctly. pstd2 already exists as an auth user (standard_user in
# ALPHA) and gains a SECOND membership, as 'manager' in BETA, which is an
# ordinary multi-org-membership shape (CLAUDE.md: "supported from MVP") and
# does not disturb pstd2's existing ALPHA role or any earlier assertion that
# used it -- this is the LAST HTTP block in the script.
# ============================================================================
echo
echo "=== Phase 6 network at the API surface (Task 4): sender cannot accept ==="

p2_sub "insert into public.organisation_memberships
          (organisation_id, user_id, role, status, joined_at)
        values ('$BETA_ORG', '${P2ID[pstd2]}', 'manager', 'active', now())
        on conflict (organisation_id, user_id)
        do update set role = 'manager', status = 'active';"

ALPHA_H4_CO=$(MSYS_NO_PATHCONV=1 docker exec "$CTR" psql -U postgres -d postgres -tAc \
  "insert into public.companies (organisation_id, name) values ('$ALPHA_ORG','Task4 HTTP Alpha Co') returning id" | head -n1 | tr -d '[:space:]')
BETA_H4_CO=$(MSYS_NO_PATHCONV=1 docker exec "$CTR" psql -U postgres -d postgres -tAc \
  "insert into public.companies (organisation_id, name) values ('$BETA_ORG','Task4 HTTP Beta Co') returning id" | head -n1 | tr -d '[:space:]')
ALPHA_H4_PROFILE=$(MSYS_NO_PATHCONV=1 docker exec "$CTR" psql -U postgres -d postgres -tAc \
  "insert into public.network_profiles
     (organisation_id, entity_kind, entity_id, status, display_name, field_visibility, published_at)
   values ('$ALPHA_ORG','company','$ALPHA_H4_CO','published','Task4 HTTP Alpha Co','{}'::jsonb, now())
   returning id" | head -n1 | tr -d '[:space:]')
BETA_H4_PROFILE=$(MSYS_NO_PATHCONV=1 docker exec "$CTR" psql -U postgres -d postgres -tAc \
  "insert into public.network_profiles
     (organisation_id, entity_kind, entity_id, status, display_name, field_visibility, published_at)
   values ('$BETA_ORG','company','$BETA_H4_CO','published','Task4 HTTP Beta Co','{}'::jsonb, now())
   returning id" | head -n1 | tr -d '[:space:]')
H4_REQUEST=$(MSYS_NO_PATHCONV=1 docker exec "$CTR" psql -U postgres -d postgres -tAc \
  "insert into public.network_connection_requests
     (from_organisation_id, from_network_profile_id, to_organisation_id, to_network_profile_id)
   values ('$ALPHA_ORG','$ALPHA_H4_PROFILE','$BETA_ORG','$BETA_H4_PROFILE')
   returning id" | head -n1 | tr -d '[:space:]')

BETA_MGR=$(p2_token pstd2); [ -n "$BETA_MGR" ] || { echo "no token for pstd2 (BETA manager)" >&2; exit 1; }

# THE FINDING: ALPHA (the SENDER, via its manager token) cannot accept its own
# request. 403, not 204/0 -- the row IS visible to the sender through the
# sender-withdraws policy's USING clause, so this is a WITH CHECK violation
# (both matching policies' WITH CHECK fail: recipient-responds because
# to_organisation_id is not ALPHA's, sender-withdraws because the landing
# value is not 'withdrawn'), the same 42501 shape NU1 measures in psql.
p2_code "SENDER (ALPHA) cannot PATCH its own request to accepted" 403 PATCH \
        "network_connection_requests?id=eq.$H4_REQUEST" \
        '{"status":"accepted","responded_at":"2026-09-05T00:00:00Z"}' "$MGR"

# CONTROL: the request is still pending -- the refusal above changed nothing.
p2_json "CONTROL: the request is still pending after the refused PATCH" "pending" \
        "network_connection_requests?select=status&id=eq.$H4_REQUEST" "$MGR" "status"

# THE POSITIVE CONTROL: the RECIPIENT (BETA), the identical statement, a
# different actor -- 204, no body, PostgREST's ordinary successful-PATCH
# response with no Prefer header.
p2_code "POSITIVE CONTROL: the RECIPIENT (BETA) can PATCH the same request to accepted" 204 PATCH \
        "network_connection_requests?id=eq.$H4_REQUEST" \
        '{"status":"accepted","responded_at":"2026-09-05T00:00:01Z"}' "$BETA_MGR"

p2_json "CONTROL: the request really is accepted now" "accepted" \
        "network_connection_requests?select=status&id=eq.$H4_REQUEST" "$BETA_MGR" "status"

# ============================================================================
# PHASE 6 NETWORK-LEAKAGE AT THE API SURFACE (Task 5).
#
# The psql suite proves the policies hold against a real counterparty. THIS
# proves the same claims through the request an attacker actually sends: the
# public anon key that ships in every browser bundle, a real access token from
# a real password sign-in, pointed straight at PostgREST, with no Next.js app
# on the path and therefore no Server Action guard, no layout gate and no
# masking-view discipline in the client code.
#
# TWO CALLERS, AND THE DIFFERENCE BETWEEN THEM IS THE POINT:
#   $UNCON  the manager of the third organisation network_leakage_phase6.sql
#           § LA created -- never connected to anybody.
#   $CONN   a manager of org BETA, which IS connected to ALPHA (accepted in
#           rls_phase6_network.sql NR9/NU4 and again in the Task 4 block above).
# Both are managers, so a password grant's aal1 session really does hold
# view_network -- an owner or admin counterparty would hold nothing at aal1 and
# every 0 below would be the MFA gate wearing the tenant boundary's clothes.
#
# PLACED LAST, deliberately: it is the only block that signs in as these two,
# and the Task 4 block above already claims the "last block" slot for its own
# BETA membership grant. Nothing here writes.
# ============================================================================
echo
echo "=== Phase 6 network leakage at the API surface (Task 5) ==="

# The ">= N" variant of p2_rows. A positive control's job is "this URL returns
# SOMETHING for the tenant that owns the rows", and pinning it to an exact
# count would hardcode a fixture size that four earlier suites all write into.
p2_rows_min() { # name min_count path token
  local name="$1" want="$2" path="$3" tok="$4" n
  n=$(curl -s "$API/rest/v1/$path" -H "apikey: $ANON" -H "Authorization: Bearer $tok" \
      | python -c "import sys,json;d=json.load(sys.stdin);print(len(d) if isinstance(d,list) else -1)")
  if [ "${n:-x}" -ge "$want" ] 2>/dev/null; then
    printf '  PASS  %-58s %s\n' "$name" "$n rows (>= $want)"
  else
    printf '  FAIL  %-58s got %s want >= %s\n' "$name" "$n" "$want"; api_fails=$((api_fails+1))
  fi
}

UNCON=$(p2_token pgmgr); [ -n "$UNCON" ] || { echo "no token for pgmgr (unconnected counterparty)" >&2; exit 1; }
CONN=$(p2_token pbmgr);  [ -n "$CONN" ]  || { echo "no token for pbmgr (connected counterparty)" >&2; exit 1; }

ALPHA_PROFILE='e0110000-0000-0000-0000-00000000000a'
ALPHA_DRAFT='e0110000-0000-0000-0000-00000000000d'

# THE FIXTURE, RE-ASSERTED AT THIS LAYER. § LA pins it in psql; if the two
# tokens below were minted for users who are not the members this block says
# they are, every 0 that follows is meaningless -- and over HTTP the membership
# is exactly what a token does NOT show you.
p2_rows "FIXTURE: the unconnected counterparty reads exactly 1 organisation"  1 \
        "organisations?select=slug" "$UNCON"
p2_json "FIXTURE: ...and it is the third organisation, not ALPHA or BETA" "org-gamma-leak" \
        "organisations?select=slug" "$UNCON" "slug"
p2_rows "FIXTURE: the connected counterparty reads exactly 1 organisation"    1 \
        "organisations?select=slug" "$CONN"
p2_json "FIXTURE: ...and it is BETA" "org-beta" \
        "organisations?select=slug" "$CONN" "slug"

# ---- THE VIEW MATRIX, OVER HTTP -------------------------------------------
p2_json "UNCONNECTED: ALPHA's published profile IS in the directory" "Alpha Promotions" \
        "network_directory?select=display_name&id=eq.$ALPHA_PROFILE" "$UNCON" "display_name"
p2_json "UNCONNECTED: a \`network\` field resolves (city)" "Bristol" \
        "network_directory?select=city&id=eq.$ALPHA_PROFILE" "$UNCON" "city"
p2_json "UNCONNECTED: a \`connections\` field is masked to null" "<null>" \
        "network_directory?select=contact_email&id=eq.$ALPHA_PROFILE" "$UNCON" "contact_email"
p2_rows "UNCONNECTED: the CONNECTED view returns 0 rows in total"             0 \
        "network_connected_profiles?select=id" "$UNCON"

p2_json "CONNECTED: the directory STILL masks it (the view's test does not vary)" "<null>" \
        "network_directory?select=contact_email&id=eq.$ALPHA_PROFILE" "$CONN" "contact_email"
p2_json "CONNECTED: the CONNECTED view resolves it -- the ONE thing accept changes" \
        "bookings@alpha.test" \
        "network_connected_profiles?select=contact_email&id=eq.$ALPHA_PROFILE" "$CONN" "contact_email"
p2_rows_min "CONNECTED: ...and that view returns rows at all (the 0 above is a boundary)" 1 \
        "network_connected_profiles?select=id" "$CONN"

# ---- THE IDOR PROBE, AT THE TRANSPORT -------------------------------------
# A draft profile id, guessed. It must come back as an EMPTY LIST -- the same
# answer a nonexistent id gives -- from both distances, with the published id
# as the paired control so "0 rows" is not "this URL never returns anything".
p2_rows "IDOR: UNCONNECTED GET of ALPHA's DRAFT profile id"                  0 \
        "network_directory?select=id&id=eq.$ALPHA_DRAFT" "$UNCON"
p2_rows "IDOR: ...and off the BASE TABLE too (no existence leak)"            0 \
        "network_profiles?select=id&id=eq.$ALPHA_DRAFT" "$UNCON"
p2_rows "IDOR: CONNECTED GET of the same draft -- accept unlocks no draft"   0 \
        "network_connected_profiles?select=id&id=eq.$ALPHA_DRAFT" "$CONN"
p2_rows "IDOR: ...and the base table, connected"                             0 \
        "network_profiles?select=id&id=eq.$ALPHA_DRAFT" "$CONN"
p2_rows "IDOR CONTROL: the PUBLISHED id returns exactly 1 row for both"      1 \
        "network_directory?select=id&id=eq.$ALPHA_PROFILE" "$UNCON"
p2_rows "IDOR CONTROL: ...and for the connected caller"                      1 \
        "network_directory?select=id&id=eq.$ALPHA_PROFILE" "$CONN"

# ---- THE EMBED ATTACKS ----------------------------------------------------
# SECURITY.md § 10's contact_companies lesson, applied to the new boundary: an
# embed is the query shape a reviewer forgets and an attacker tries first.
# PostgREST resolves an embed through a foreign key, and there is no foreign
# key from a VIEW to anything -- so each of these is a 400, not an empty 200,
# and the positive control below proves 400 means "no such relationship" rather
# than "embeds are switched off".
p2_code "EMBED: network_directory + network_profiles(*)"        400 GET \
        "network_directory?select=*,network_profiles(*)" "" "$UNCON"
p2_code "EMBED: network_directory + companies(*)"               400 GET \
        "network_directory?select=*,companies(*)" "" "$UNCON"
p2_code "EMBED: network_directory + network_profiles(organisation_id)" 400 GET \
        "network_directory?select=*,network_profiles(organisation_id)" "" "$UNCON"
p2_code "EMBED: the connected view + notes(*), from the connected caller" 400 GET \
        "network_connected_profiles?select=*,notes(*)" "" "$CONN"
p2_code "EMBED CONTROL: a REAL embed over a REAL FK works (events+event_lineup)" 200 GET \
        "events?select=id,event_lineup(id)&limit=1" "" "$MGR"

# ---- THE COLUMN LIST, ON THE CONNECTED VIEW -------------------------------
# The Task 1 block above asserts this for network_directory. The connected view
# had no equivalent, and it is the one an accepted connection actually widens.
p2_code "the CONNECTED view has no organisation_id to select (400, not a value)" 400 GET \
        "network_connected_profiles?select=organisation_id" "" "$CONN"
p2_code "...nor entity_id"                                                      400 GET \
        "network_connected_profiles?select=entity_id" "" "$CONN"
p2_code "CONTROL: a real column of the same view selects fine"                  200 GET \
        "network_connected_profiles?select=display_name" "" "$CONN"

# ---- THE PRIVATE-RELATION SWEEP, OVER HTTP --------------------------------
# Sixteen tenant-private relations, filtered by ALPHA's organisation id -- the
# request an attacker sends, since the org id is in every URL and § LB proves a
# counterparty can read it straight off network_profiles. Each is asserted 0
# from BOTH distances and >= 1 for the tenant that owns it.
#
# TWO OF THE SIXTEEN GET THEIR POSITIVE CONTROL IN psql AND NOT HERE, and the
# reason is measured rather than assumed:
#   financial_entries  needs view_finance, which is aal2-gated; $OWN2 is the
#                      one elevated session in this script and is used below.
#   audit_events       is readable to NO tenant role at all -- not even ALPHA's
#                      owner. network_leakage_phase6.sql LC5 measures that and
#                      LC5b pairs it with the superuser, who can. So the
#                      control here is the $OWN2 line asserting 0, labelled as
#                      the measurement it is.
for rel in contacts companies artists venues agencies events event_lineup \
           tasks meetings notes documents custom_field_values \
           activity_events network_links; do
  p2_rows "UNCONNECTED reads 0 ALPHA $rel"  0 "$rel?select=id&organisation_id=eq.$ALPHA_ORG" "$UNCON"
  p2_rows "CONNECTED reads 0 ALPHA $rel"    0 "$rel?select=id&organisation_id=eq.$ALPHA_ORG" "$CONN"
  p2_rows_min "CONTROL: ALPHA's owner reads $rel"  1 \
          "$rel?select=id&organisation_id=eq.$ALPHA_ORG" "$OWN2"
done
p2_rows "UNCONNECTED reads 0 ALPHA financial_entries"  0 \
        "financial_entries?select=id&organisation_id=eq.$ALPHA_ORG" "$UNCON"
p2_rows "CONNECTED reads 0 ALPHA financial_entries"    0 \
        "financial_entries?select=id&organisation_id=eq.$ALPHA_ORG" "$CONN"
p2_rows_min "CONTROL: ALPHA's aal2 owner reads financial_entries" 1 \
        "financial_entries?select=id&organisation_id=eq.$ALPHA_ORG" "$OWN2"
p2_rows "UNCONNECTED reads 0 ALPHA audit_events"       0 \
        "audit_events?select=id&organisation_id=eq.$ALPHA_ORG" "$UNCON"
p2_rows "CONNECTED reads 0 ALPHA audit_events"         0 \
        "audit_events?select=id&organisation_id=eq.$ALPHA_ORG" "$CONN"
p2_rows "MEASURED: ALPHA's own owner reads 0 audit_events too (superuser-only)" 0 \
        "audit_events?select=id&organisation_id=eq.$ALPHA_ORG" "$OWN2"

# THE UNFILTERED FORM, for the caller who does not know ALPHA's org id: the
# tables are simply empty for them, so the filter above is not what produced
# the zeros.
p2_rows "UNCONNECTED reads 0 contacts with NO filter at all"   0 "contacts?select=id" "$UNCON"
p2_rows "UNCONNECTED reads 0 events with NO filter at all"     0 "events?select=id" "$UNCON"
p2_rows "UNCONNECTED reads 0 notes with NO filter at all"      0 "notes?select=id" "$UNCON"
p2_rows "UNCONNECTED reads 0 network_links with NO filter"     0 "network_links?select=id" "$UNCON"
p2_rows "CONNECTED reads 0 network_links with NO filter (Q82)" 0 "network_links?select=id" "$CONN"
p2_rows_min "CONTROL: the CONNECTED caller DOES read its own BETA contacts" 1 \
        "contacts?select=id&organisation_id=eq.$BETA_ORG" "$CONN"

# ============================================================================
# PHASE 7 TASK 6: IN-APP FEEDBACK OVER REAL HTTP -- THE DIRECT-POSTGREST PATH.
#
# The psql suite above proves the trigger from `set role authenticated`. This
# is the request a script actually sends: the anon key plus a real password-
# grant token, POSTed straight at PostgREST with no Next.js in the way. Task
# 5's finding I2 was precisely a budget this path skipped; here it must not.
#
# carol is org A's ACTIVE standard_user (rls_foundation.sql) with a fresh
# feedback budget -- the psql suite spent pstd1/pstd2's, not hers.
# ============================================================================
echo
echo "=== Phase 7 feedback at the API surface ==="

CAROL_ORG=$(curl -s "$API/rest/v1/organisations?select=id" \
  -H "apikey: $ANON" -H "Authorization: Bearer $TOKEN" \
  | python -c "import sys,json;d=json.load(sys.stdin);print(d[0]['id'] if d else '')")
[ -n "$CAROL_ORG" ] || { echo "carol could not read her own org over HTTP" >&2; exit 1; }

fb_post() { # name want_http body
  local name="$1" want="$2" body="$3" code
  code=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$API/rest/v1/feedback" \
    -H "apikey: $ANON" -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" -H "Prefer: return=minimal" -d "$body")
  if [ "$code" = "$want" ]; then printf '  PASS  %-58s %s\n' "$name" "$code"
  else printf '  FAIL  %-58s got %s want %s\n' "$name" "$code" "$want"; api_fails=$((api_fails+1)); fi
}

fb_post "carol POSTs feedback naming her own workspace -> 201" 201 \
  "{\"organisation_id\":\"$CAROL_ORG\",\"category\":\"bug\",\"message\":\"http one\",\"route\":\"/org-a\"}"
fb_post "FORGERY: naming user_id is refused at the column grant -> 403" 403 \
  "{\"user_id\":\"${ID[super]}\",\"organisation_id\":\"$CAROL_ORG\",\"category\":\"bug\",\"message\":\"x\",\"route\":\"/\"}"
fb_post "FORGERY: naming a workspace she is not a member of -> 403" 403 \
  "{\"organisation_id\":\"$BETA_ORG\",\"category\":\"bug\",\"message\":\"x\",\"route\":\"/\"}"
fb_post "FORGERY: naming status is refused at the column grant -> 403" 403 \
  "{\"status\":\"actioned\",\"organisation_id\":\"$CAROL_ORG\",\"category\":\"bug\",\"message\":\"x\",\"route\":\"/\"}"
p2_rows "carol reads 0 feedback rows -- not even her own"  0 "feedback?select=id" "$TOKEN"
probe "private helper feedback_before_insert not an RPC"          404 "rpc/feedback_before_insert"
probe "private helper feedback_update_guard not an RPC"           404 "rpc/feedback_update_guard"
probe "audit_feedback_screenshot_view IS routable and refuses carol (403)" 403 \
      "rpc/audit_feedback_screenshot_view" '{"p_feedback_id":"00000000-0000-4000-8000-0000000000cc"}'
# THE BUDGET, ON THE RAW PATH: nine more accepted (ten in all), the eleventh a
# real HTTP 429 -- the PT429 SQLSTATE escape, through PostgREST.
for i in 2 3 4 5 6 7 8 9 10; do
  fb_post "carol's submission #$i -> 201" 201 \
    "{\"organisation_id\":\"$CAROL_ORG\",\"category\":\"idea\",\"message\":\"http $i\",\"route\":\"/org-a\"}"
done
fb_post "carol's ELEVENTH direct-PostgREST submission in the hour -> 429" 429 \
  "{\"organisation_id\":\"$CAROL_ORG\",\"category\":\"idea\",\"message\":\"http 11\",\"route\":\"/org-a\"}"
# FIX ROUND 1 (I1): the pre-check the app runs BEFORE any Storage I/O, over
# the same session -- carol's budget is spent, so it must read 0 (and reading
# it must not change the ten-row count asserted next).
fb_budget=$(curl -s -X POST "$API/rest/v1/rpc/feedback_budget_remaining" \
  -H "apikey: $ANON" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{}' \
  | python -c "import sys,json;r=json.load(sys.stdin);r=r[0] if isinstance(r,list) else r;print(r.get('remaining'))")
if [ "$fb_budget" = "0" ]; then printf '  PASS  %-58s %s\n' "feedback_budget_remaining reads 0 for carol over HTTP" "$fb_budget"
else printf '  FAIL  %-58s got %s want 0\n' "feedback_budget_remaining reads 0 for carol over HTTP" "$fb_budget"; api_fails=$((api_fails+1)); fi
fb_n=$(MSYS_NO_PATHCONV=1 docker exec "$CTR" psql -U postgres -d postgres -tAc \
       "select count(*) from public.feedback where user_id='${ID[carol]}'" | tr -d '[:space:]')
if [ "$fb_n" = "10" ]; then printf '  PASS  %-58s %s\n' "exactly ten rows landed for carol (the 429 wrote nothing)" "$fb_n"
else printf '  FAIL  %-58s got %s want 10\n' "exactly ten rows landed for carol" "$fb_n"; api_fails=$((api_fails+1)); fi
fb_role=$(MSYS_NO_PATHCONV=1 docker exec "$CTR" psql -U postgres -d postgres -tAc \
       "select string_agg(distinct coalesce(organisation_role,'null'), ',') from public.feedback where user_id='${ID[carol]}'" | tr -d '[:space:]')
if [ "$fb_role" = "standard_user" ]; then printf '  PASS  %-58s %s\n' "every row's role was stamped from carol's membership" "$fb_role"
else printf '  FAIL  %-58s got %s want standard_user\n' "every row's role was stamped from carol's membership" "$fb_role"; api_fails=$((api_fails+1)); fi
# Housekeeping: carol's rows, counters, the crossing alert and the audit rows.
MSYS_NO_PATHCONV=1 docker exec "$CTR" psql -U postgres -d postgres -q -c \
  "delete from public.incident_alerts where details->>'category'='feedback' and details->>'subject_id'='${ID[carol]}';
   delete from public.audit_events where target_type='feedback' and actor_user_id='${ID[carol]}';
   delete from public.feedback where user_id='${ID[carol]}';
   delete from public.rate_limit_counters where category='feedback' and subject_id='${ID[carol]}';"

# ============================================================================
# PHASE 8 TASK 1: THE LEGAL DOCUMENT STORE OVER REAL HTTP.
#
# The one table a signed-out caller can read, driven with nothing but the
# public anon key -- the request any visitor's browser (or a scraper) sends.
# § LZ of rls_phase8_legal.sql left exactly the migrated rows: fifteen
# current documents (four at a later version since fix round 1, three more
# since fix round 2).
# ============================================================================
echo
echo "=== Phase 8 legal documents at the API surface ==="
p2_rows "anon (key only) reads the 15 current legal documents"     15         "legal_documents?select=slug,version,title,counsel_reviewed_at" "$ANON"
p2_rows "carol reads the same 15"                                   15         "legal_documents?select=slug,version" "$TOKEN"
p2_code "anon select=* is refused (column-level grant) -> 401"      401 GET         "legal_documents?select=*" "" "$ANON"
p2_code "anon cannot select the reviewer name -> 401"               401 GET         "legal_documents?select=counsel_reviewer" "" "$ANON"
p2_code "carol cannot select the reviewer name -> 403"              403 GET         "legal_documents?select=counsel_reviewer" "" "$TOKEN"
p2_code "carol cannot select status (drafts are not a filter away) -> 403" 403 GET         "legal_documents?select=slug&status=eq.draft" "" "$TOKEN"
p2_code "anon PATCH of a legal document -> 401"                     401 PATCH         "legal_documents?slug=eq.terms" '{"title":"x"}' "$ANON"
p2_code "carol PATCH of a legal document -> 403"                    403 PATCH         "legal_documents?slug=eq.terms" '{"title":"x"}' "$TOKEN"
p2_code "carol DELETE of a legal document -> 403"                   403 DELETE         "legal_documents?slug=eq.terms" "" "$TOKEN"
p2_code "carol POST of a legal document -> 403"                     403 POST         "legal_documents" '{"slug":"terms","version":9,"title":"x","body":"y","effective_date":"2026-01-01"}' "$TOKEN"
p2_code "carol cannot create a draft through the RPC -> 403"        403 POST         "rpc/create_legal_document_draft" '{"p_slug":"terms"}' "$TOKEN"
p2_code "anon cannot call the operator read -> 401"                 401 POST         "rpc/operator_legal_document_versions" '{}' "$ANON"
p2_code "the immutability guard is not an RPC -> 404"               404 POST         "rpc/legal_documents_guard" '{}' "$TOKEN"
lg_same=$(MSYS_NO_PATHCONV=1 docker exec "$CTR" psql -U postgres -d postgres -tAc   "select count(*) from public.legal_documents where status = 'published' and title <> 'x' and version = case when slug = 'data-subject-rights' then 5 when slug in ('data-processing-addendum','data-retention') then 4 when slug = 'privacy' then 3 when slug in ('security','subprocessors','marketing-preferences') then 2 else 1 end" | tr -d '[:space:]')
if [ "$lg_same" = "15" ]; then printf '  PASS  %-58s %s
' "the refused writes changed nothing (15 current rows intact)" "$lg_same"
else printf '  FAIL  %-58s got %s want 15
' "the refused writes changed nothing" "$lg_same"; api_fails=$((api_fails+1)); fi

# ============================================================================
# PHASE 8 TASK 2: THE CONSENT LEDGER OVER REAL HTTP.
#
# carol records and withdraws her own marketing consent through the one RPC,
# reads back only her own rows, and cannot write the table, forge a user, or
# call the sender's check. § CZ of rls_phase8_consents.sql left the ledger
# empty, so every count below is carol's alone.
# ============================================================================
echo
echo "=== Phase 8 consent ledger at the API surface ==="
p2_code "anon cannot record a consent -> 401"                        401 POST "rpc/record_consent" '{"p_purpose":"marketing_email","p_action":"granted","p_policy_version":2}' "$ANON"
p2_code "carol records a grant through the RPC -> 200"               200 POST "rpc/record_consent" '{"p_purpose":"marketing_email","p_action":"granted","p_policy_version":2,"p_statement":"marketing-email-1"}' "$TOKEN"
p2_code "carol's grant against a stale version -> 400"               400 POST "rpc/record_consent" '{"p_purpose":"marketing_email","p_action":"granted","p_policy_version":1}' "$TOKEN"
p2_code "carol withdraws in one call, no version -> 200"             200 POST "rpc/record_consent" '{"p_purpose":"marketing_email","p_action":"withdrawn"}' "$TOKEN"
p2_code "carol cannot name a user: no such parameter -> 404"         404 POST "rpc/record_consent" '{"p_purpose":"marketing_email","p_action":"granted","p_policy_version":2,"p_user_id":"${ID[alice]}"}' "$TOKEN"
p2_code "carol cannot POST the table directly -> 403"                403 POST "consents" '{"purpose":"marketing_email","action":"granted","policy_slug":"marketing-preferences","policy_version":2,"mechanism":"account_settings"}' "$TOKEN"
p2_code "carol cannot PATCH her own consent -> 403"                  403 PATCH "consents?purpose=eq.marketing_email" '{"action":"granted"}' "$TOKEN"
p2_code "carol cannot DELETE her own consent -> 403"                 403 DELETE "consents?purpose=eq.marketing_email" "" "$TOKEN"
p2_code "anon cannot read the ledger -> 401"                         401 GET "consents?select=id" "" "$ANON"
p2_code "carol cannot call the sender's check -> 404/403"            403 POST "rpc/consent_is_granted" '{"p_user_id":"00000000-0000-0000-0000-000000000000","p_purpose":"marketing_email"}' "$TOKEN"
p2_rows "carol reads exactly her two events"                          2 "consents?select=id,action" "$TOKEN"
cs_http=$(MSYS_NO_PATHCONV=1 docker exec "$CTR" psql -U postgres -d postgres -tAc   "select string_agg(action || ':' || (user_id = '${ID[carol]}')::text, ',' order by seq) from public.consents" | tr -d '[:space:]')
if [ "$cs_http" = "granted:true,withdrawn:true" ]; then printf '  PASS  %-58s %s
' "the ledger holds carol's grant then withdrawal, both hers" "$cs_http"
else printf '  FAIL  %-58s got %s want granted:true,withdrawn:true
' "the ledger holds carol's grant then withdrawal" "$cs_http"; api_fails=$((api_fails+1)); fi
MSYS_NO_PATHCONV=1 docker exec "$CTR" psql -U postgres -d postgres -q -c   "set session_replication_role = replica;
   delete from public.audit_events where target_type='consent' and actor_user_id='${ID[carol]}';
   delete from public.consents where user_id='${ID[carol]}';
   set session_replication_role = default;
   delete from public.rate_limit_counters where category='consent_grant' and subject_id='${ID[carol]}';"

# ============================================================================
# PHASE 8 TASK 3: DATA SUBJECT REQUESTS OVER REAL HTTP.
#
# The psql suite proves the policies and the triggers. This proves which of
# them PostgREST actually exposes: carol makes and withdraws her own request
# through the two RPCs, reads back only her own row, cannot write either table,
# cannot progress her own request, and cannot read the operator's notes.
# rls_phase8_data_subject_requests.sql's DZ left both tables empty, so every
# count below is carol's alone.
# ============================================================================
echo
echo "=== Phase 8 data subject requests at the API surface ==="
p2_code "anon cannot make a request -> 401"                          401 POST "rpc/submit_data_subject_request" '{"p_right_type":"access","p_subject_scope":"account","p_detail":"x"}' "$ANON"
p2_code "carol makes a request through the RPC -> 200"               200 POST "rpc/submit_data_subject_request" '{"p_right_type":"access","p_subject_scope":"account","p_detail":"HTTP probe request"}' "$TOKEN"
p2_code "carol cannot name a user: no such parameter -> 404"         404 POST "rpc/submit_data_subject_request" '{"p_right_type":"access","p_subject_scope":"account","p_detail":"x","p_user_id":"'"${ID[alice]}"'"}' "$TOKEN"
p2_code "an unknown right -> 400"                                    400 POST "rpc/submit_data_subject_request" '{"p_right_type":"compensation","p_subject_scope":"account","p_detail":"x"}' "$TOKEN"
p2_code "carol cannot POST the register directly -> 403"             403 POST "data_subject_requests" '{"user_id":"'"${ID[carol]}"'","user_email":"c@t.l","right_type":"access","subject_scope":"account","detail":"direct"}' "$TOKEN"
p2_code "carol cannot PATCH her own request -> 403"                  403 PATCH "data_subject_requests?right_type=eq.access" '{"status":"fulfilled"}' "$TOKEN"
p2_code "carol cannot DELETE her own request -> 403"                 403 DELETE "data_subject_requests?right_type=eq.access" "" "$TOKEN"
p2_code "carol cannot progress her own request -> 403"               403 POST "rpc/transition_data_subject_request" '{"p_request_id":"00000000-0000-0000-0000-000000000000","p_status":"fulfilled"}' "$TOKEN"
p2_code "carol cannot add an operator note -> 403"                   403 POST "rpc/add_data_subject_request_note" '{"p_request_id":"00000000-0000-0000-0000-000000000000","p_body":"x"}' "$TOKEN"
p2_code "anon cannot read the register -> 401"                       401 GET "data_subject_requests?select=id" "" "$ANON"
p2_rows "carol reads exactly her one request"                         1 "data_subject_requests?select=id,status" "$TOKEN"
# M2 (Task 3 review): "carol reads ZERO operator notes" used to run against an
# EMPTY notes table -- nobody in this block holds an aal2 operator token, and
# the psql suite's DZ had emptied it -- so it would have passed with the notes
# policy replaced by `using (true)`. A note is planted on CAROL'S OWN request
# through the real RPC under the operator's aal2 session, the operator is shown
# to read it back through the same policy, and only then is carol asked: by the
# table, by a resource embed on the row she CAN read, and by both bounded reads.
dsr_req=$(MSYS_NO_PATHCONV=1 docker exec "$CTR" psql -U postgres -d postgres -tAc "select id from public.data_subject_requests where user_id='${ID[carol]}' limit 1" | tr -d '[:space:]')
DSR_OP_CLAIMS="{\"sub\":\"${ID[super]}\",\"role\":\"authenticated\",\"aal\":\"aal2\"}"
MSYS_NO_PATHCONV=1 docker exec "$CTR" psql -U postgres -d postgres -q -tAc "set request.jwt.claims = '$DSR_OP_CLAIMS'; set role authenticated; select public.add_data_subject_request_note('$dsr_req', 'HTTP probe note: not for carol');" >/dev/null
dsr_note_op=$(MSYS_NO_PATHCONV=1 docker exec "$CTR" psql -U postgres -d postgres -q -tAc "set request.jwt.claims = '$DSR_OP_CLAIMS'; set role authenticated; select count(*) from public.data_subject_request_notes where request_id = '$dsr_req' and body like 'HTTP probe note%';" | tr -d '[:space:]')
if [ "$dsr_note_op" = "1" ]; then printf '  PASS  %-58s %s
' "DENOMINATOR: the operator reads the planted note" "$dsr_note_op"
else printf '  FAIL  %-58s got %s want 1
' "DENOMINATOR: the operator reads the planted note" "$dsr_note_op"; api_fails=$((api_fails+1)); fi
p2_rows "carol reads ZERO operator notes, with one on HER request"    0 "data_subject_request_notes?select=id" "$TOKEN"
dsr_embed=$(curl -s "$API/rest/v1/data_subject_requests?select=id,data_subject_request_notes(id,body)" -H "apikey: $ANON" -H "Authorization: Bearer $TOKEN"   | python -c "import sys,json;d=json.load(sys.stdin);print(str(len(d))+':'+str(sum(len(r.get('data_subject_request_notes') or []) for r in d)) if isinstance(d,list) else 'error')")
if [ "$dsr_embed" = "1:0" ]; then printf '  PASS  %-58s %s
' "...not through an embed on her own readable row either" "$dsr_embed"
else printf '  FAIL  %-58s got %s want 1:0
' "...not through an embed on her own readable row either" "$dsr_embed"; api_fails=$((api_fails+1)); fi
p2_rows "...nor through the bounded COUNT read"                        0 "rpc/data_subject_request_note_counts?p_request_ids=%7B$dsr_req%7D" "$TOKEN"
p2_rows "...nor through the bounded RECENT read"                       0 "rpc/data_subject_request_recent_notes?p_request_ids=%7B$dsr_req%7D&p_per_request=20" "$TOKEN"
p2_code "carol cannot route her own request -> 403"                  403 POST "rpc/route_data_subject_request" '{"p_request_id":"'"$dsr_req"'","p_organisation_id":"00000000-0000-0000-0000-000000000000","p_handover_note":"x"}' "$TOKEN"
dsr_http=$(MSYS_NO_PATHCONV=1 docker exec "$CTR" psql -U postgres -d postgres -tAc   "select status || ':' || (user_id = '${ID[carol]}')::text || ':' || (due_by - requested_at)::text from public.data_subject_requests" | tr -d '[:space:]')
if [ "$dsr_http" = "open:true:30days" ]; then printf '  PASS  %-58s %s
' "the request is carol's, open, and due in 30 days" "$dsr_http"
else printf '  FAIL  %-58s got %s want open:true:30days
' "the request is carol's, open, due in 30 days" "$dsr_http"; api_fails=$((api_fails+1)); fi
p2_code "carol withdraws her own request -> 200"                     200 POST "rpc/withdraw_data_subject_request" '{"p_request_id":"'"$(MSYS_NO_PATHCONV=1 docker exec "$CTR" psql -U postgres -d postgres -tAc "select id from public.data_subject_requests limit 1" | tr -d '[:space:]')"'"}' "$TOKEN"
MSYS_NO_PATHCONV=1 docker exec "$CTR" psql -U postgres -d postgres -q -c   "set session_replication_role = replica;
   delete from public.audit_events where target_type='data_subject_request';
   delete from public.data_subject_request_notes;
   delete from public.data_subject_requests;
   set session_replication_role = default;
   delete from public.rate_limit_counters where category='data_subject_request';"

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
