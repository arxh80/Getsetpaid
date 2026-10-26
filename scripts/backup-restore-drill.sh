#!/usr/bin/env bash
# ============================================================================
# THE LOCAL BACKUP-RESTORE DRILL (Phase 10 Task 10, G28). LOCAL STACK ONLY.
#
#   bash scripts/backup-restore-drill.sh            # the drill
#   bash scripts/backup-restore-drill.sh --skip-roles-dump   # the mutant: must FAIL
#
# Run it on a FRESHLY RESET database (`npx supabase db reset --local`): its
# third check runs the psql runner, which refuses a database that already holds
# fixtures. It takes the backup a restore would need -- `pg_dumpall
# --roles-only` and a `pg_dump --create` of the database -- and then:
#
#   0. ROLES, in a FRESH cluster: a throwaway container of the stack's own
#      Postgres image loads the roles dump, and `export_reader` (the export
#      runner's RLS identity, a CLUSTER role a database dump does not carry)
#      must exist there with the source's memberships.
#   1. RESTORE IN PLACE, the way production is restored: the service containers
#      are paused, the live `postgres` database is renamed aside to
#      `drill_source`, and the dump is restored as `postgres`.
#   2. CATALOGUE: pg_policies, relacl and proacl of the restore equal the
#      source's; so do cron.job and the Vault secret NAMES.
#   3. ROWS: every table in public, private, auth, storage, cron and vault has
#      the source's row count.
#   4. SUITES: the services restart against the restore and
#      `supabase/tests/run-rls-tests.sh` must print "All suites passed".
#
# It ALWAYS swaps the original database back (trap), and exits 0 only when all
# checks hold. Storage OBJECTS are not in any database backup (G30): this
# drill proves the metadata only. It never touches a hosted project: every
# command is `docker exec` into this stack's local container.
# ============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SKIP_ROLES=0
[ "${1:-}" = "--skip-roles-dump" ] && SKIP_ROLES=1

WORKDIR="${SUPABASE_WORKDIR:-}"
if [ -z "$WORKDIR" ]; then
  if [ -d "$ROOT/.supabase-slot" ]; then WORKDIR="$ROOT/.supabase-slot"; else WORKDIR="$ROOT"; fi
fi
PROJECT="$(grep -E '^project_id' "$WORKDIR/supabase/config.toml" | cut -d'"' -f2)"
CTR="supabase_db_$PROJECT"
FRESH="${PROJECT}_drill_roles"
# Git Bash would rewrite the container paths below (/tmp/...); only dx gets the opt-out,
# because the runner's Windows supabase.exe NEEDS its --workdir translated.
dx() { MSYS_NO_PATHCONV=1 docker exec "$@"; }

docker inspect "$CTR" >/dev/null 2>&1 || { echo "drill: no local container $CTR -- is the stack up?" >&2; exit 1; }
IMAGE="$(docker inspect -f '{{.Config.Image}}' "$CTR")"

q()  { dx -i "$CTR" psql -U supabase_admin -X -v ON_ERROR_STOP=1 -At "$@"; }
qf() { dx -i "$FRESH" psql -U supabase_admin -X -v ON_ERROR_STOP=1 -At "$@"; }

if [ "$(q -d template1 -c "select count(*) from pg_database where datname = 'drill_source'")" != "0" ]; then
  echo "drill: database drill_source already exists -- a previous drill did not swap back. Inspect it before deleting anything." >&2
  exit 1
fi

START=$(date +%s)
FAIL=0
fail() { echo "  FAIL  $*"; FAIL=1; }
pass() { echo "  PASS  $*"; }

# The services that hold connections to the database (kong and mailpit do not).
SERVICES="$(docker ps --format '{{.Names}}' | grep -E "^supabase_(rest|auth|storage|realtime|pg_meta|studio|edge_runtime|pooler|analytics|vector)_${PROJECT}\$" || true)"
SWAPPED=0

swap_back() {
  [ "$SWAPPED" = "1" ] || return 0
  echo "== swapping the original database back"
  [ -n "$SERVICES" ] && docker stop $SERVICES >/dev/null
  q -d template1 >/dev/null <<SQL
alter database postgres allow_connections false;
select pg_terminate_backend(pid) from pg_stat_activity where datname = 'postgres' and pid <> pg_backend_pid();
drop database postgres;
alter database drill_source rename to postgres;
alter database postgres allow_connections true;
SQL
  [ -n "$SERVICES" ] && docker start $SERVICES >/dev/null
  SWAPPED=0
  echo "   original database restored"
}
cleanup() {
  docker rm -f "$FRESH" >/dev/null 2>&1 || true
  swap_back
}
trap cleanup EXIT

# ---------------------------------------------------------------------------
echo "== backup: roles and database"
dx "$CTR" pg_dumpall -U supabase_admin --roles-only -f /tmp/drill-roles.sql
dx "$CTR" pg_dump -U supabase_admin -d postgres --create -Fc -f /tmp/drill.dump
echo "   $(dx "$CTR" du -h /tmp/drill.dump | cut -f1) database dump"

# ---------------------------------------------------------------------------
echo "== 0. roles in a fresh cluster ($IMAGE)"
docker run -d --rm --name "$FRESH" -e POSTGRES_PASSWORD=drill "$IMAGE" >/dev/null
for _ in $(seq 1 60); do
  dx "$FRESH" pg_isready -U postgres -q 2>/dev/null && qf -d postgres -c "select 1" >/dev/null 2>&1 && break
  sleep 2
done
if [ "$SKIP_ROLES" = "0" ]; then
  dx "$CTR" cat /tmp/drill-roles.sql | dx -i "$FRESH" psql -U supabase_admin -X -q -d postgres >/dev/null 2>&1 || true
else
  echo "   MUTANT: the roles dump is NOT loaded"
fi
MEMBERS_SQL="select r.rolname || '>' || g.rolname from pg_auth_members m join pg_roles r on r.oid = m.member join pg_roles g on g.oid = m.roleid where 'export_reader' in (r.rolname, g.rolname) order by 1"
SRC_MEMBERS="$(q -d postgres -c "$MEMBERS_SQL")"
NEW_MEMBERS="$(qf -d postgres -c "$MEMBERS_SQL")"
if [ "$(qf -d postgres -c "select count(*) from pg_roles where rolname = 'export_reader'")" != "1" ]; then
  fail "export_reader does not exist in the fresh cluster -- a database dump alone cannot restore the export runner"
elif [ "$SRC_MEMBERS" != "$NEW_MEMBERS" ]; then
  fail "export_reader's memberships differ: source [$SRC_MEMBERS] restore [$NEW_MEMBERS]"
else
  pass "export_reader recreated with its memberships [$SRC_MEMBERS]"
fi
docker rm -f "$FRESH" >/dev/null

# ---------------------------------------------------------------------------
echo "== 1. restore in place"
# `postgres` must never be missing: pg_net's background worker (0.20.4)
# reconnects about a second after it is terminated, and finding no `postgres`
# it SEGFAULTS, which crashes the whole server into recovery (measured twice,
# 2026-10-26). So the empty replacement is created in the same breath as the
# rename -- not by pg_restore --create -- with the source's own definition,
# settings and grants, and the dump is restored into it.
DB_CREATE="$(q -d template1 -c "select format('create database postgres with owner = %I template = template0 encoding = %L lc_collate = %L lc_ctype = %L;', pg_get_userbyid(datdba), pg_encoding_to_char(encoding), datcollate, datctype) from pg_database where datname = 'postgres'")"
DB_PROPS="$(q -d template1 -c "select format('alter database postgres set %s = %L;', split_part(c, '=', 1), substr(c, strpos(c, '=') + 1)) from pg_db_role_setting s, unnest(s.setconfig) c where s.setrole = 0 and s.setdatabase = (select oid from pg_database where datname = 'postgres') union all select format('grant %s on database postgres to %s;', a.privilege_type, case when a.grantee = 0 then 'public' else quote_ident(pg_get_userbyid(a.grantee)) end) from pg_database d, aclexplode(d.datacl) a where d.datname = 'postgres' and a.grantee <> d.datdba")"
[ -n "$SERVICES" ] && docker stop $SERVICES >/dev/null
q -d template1 >/dev/null <<SQL
alter database postgres allow_connections false;
select pg_terminate_backend(pid) from pg_stat_activity where datname = 'postgres' and pid <> pg_backend_pid();
alter database postgres rename to drill_source;
$DB_CREATE
SQL
SWAPPED=1
printf '%s\n' "$DB_PROPS" | q -d template1 >/dev/null
q -d template1 -c "alter database drill_source allow_connections true" >/dev/null
# pg_net's extension and grants go in a second pass, after everything else.
PGNET='^[0-9]+; [0-9]+ [0-9]+ (EXTENSION - pg_net |COMMENT - EXTENSION pg_net |ACL - SCHEMA net |ACL net )'
dx "$CTR" sh -c "pg_restore -l /tmp/drill.dump > /tmp/drill.list && grep -vE '$PGNET' /tmp/drill.list > /tmp/drill-main.list && grep -E '$PGNET' /tmp/drill.list > /tmp/drill-pgnet.list"
{ dx "$CTR" pg_restore -U supabase_admin -d postgres -L /tmp/drill-main.list /tmp/drill.dump
  dx "$CTR" pg_restore -U supabase_admin -d postgres -L /tmp/drill-pgnet.list /tmp/drill.dump
} >/tmp/drill-restore.log 2>&1 || true
RESTORE_ERRORS=$(grep -c "error:" /tmp/drill-restore.log || true)
echo "   pg_restore reported $RESTORE_ERRORS error line(s)"
[ "$RESTORE_ERRORS" = "0" ] || { grep "error:" /tmp/drill-restore.log | head -10; }

# ---------------------------------------------------------------------------
echo "== 2. catalogue"
SCHEMAS="'public','private','auth','storage','cron','vault','extensions','graphql','graphql_public','realtime','supabase_functions','api_hooks'"
declare -A CAT=(
  [policies]="select schemaname, tablename, policyname, permissive, roles::text, cmd, coalesce(qual, ''), coalesce(with_check, '') from pg_policies order by 1, 2, 3"
  [relacl]="select n.nspname, c.relname, c.relkind, coalesce((select string_agg(a::text, ',' order by a::text) from unnest(coalesce(c.relacl, acldefault((case when c.relkind = 'S' then 's' else 'r' end)::\"char\", c.relowner))) a), '') from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname in ($SCHEMAS) order by 1, 2, 3"
  [proacl]="select n.nspname, p.proname, pg_get_function_identity_arguments(p.oid), coalesce((select string_agg(a::text, ',' order by a::text) from unnest(coalesce(p.proacl, acldefault('f'::\"char\", p.proowner))) a), ''), p.prosecdef from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname in ($SCHEMAS) order by 1, 2, 3"
  [cron_jobs]="select jobname, schedule, command, database, username, active from cron.job order by 1"
  [vault_names]="select name from vault.secrets order by 1"
  [db_settings]="select coalesce(r.rolname, '*') || ' ' || s.setconfig::text from pg_db_role_setting s left join pg_roles r on r.oid = s.setrole where s.setdatabase = (select oid from pg_database where datname = current_database()) order by 1"
)
for k in policies relacl proacl cron_jobs vault_names db_settings; do
  a="$(q -d drill_source -c "${CAT[$k]}")"; b="$(q -d postgres -c "${CAT[$k]}")"
  n=$(printf '%s' "$a" | grep -c '' || true)
  if [ "$a" = "$b" ]; then pass "$k identical ($n rows)"; else
    fail "$k differs"; { diff <(printf '%s\n' "$a") <(printf '%s\n' "$b") || true; } | head -10
  fi
done

# ---------------------------------------------------------------------------
echo "== 3. rows"
# cron.job_run_details is excluded: pg_cron's scheduler runs in the restored database
# during the drill and logs its own runs there (measured: 0 -> 1 in one run).
COUNT_SQL="select format('select %L || '' '' || count(*) from %I.%I', n.nspname || '.' || c.relname, n.nspname, c.relname) from pg_class c join pg_namespace n on n.oid = c.relnamespace where c.relkind in ('r', 'p') and n.nspname in ('public', 'private', 'auth', 'storage', 'cron', 'vault') and (n.nspname, c.relname) <> ('cron', 'job_run_details') order by 1"
counts() { { echo "$COUNT_SQL \\gexec"; } | q -d "$1"; }
a="$(counts drill_source)"; b="$(counts postgres)"
n=$(printf '%s' "$a" | grep -c '' || true)
if [ "$a" = "$b" ]; then pass "row counts identical across $n tables"; else
  fail "row counts differ"; { diff <(printf '%s\n' "$a") <(printf '%s\n' "$b") || true; } | head -10
fi

# ---------------------------------------------------------------------------
echo "== 4. the psql runner against the restore"
[ -n "$SERVICES" ] && docker start $SERVICES >/dev/null
for _ in $(seq 1 60); do
  curl -sf -o /dev/null "http://127.0.0.1:$(grep -A3 '^\[api\]' "$WORKDIR/supabase/config.toml" | grep -E '^port' | head -1 | tr -dc 0-9)/auth/v1/health" && break
  sleep 2
done
if bash "$ROOT/supabase/tests/run-rls-tests.sh" > /tmp/drill-suites.log 2>&1 && grep -q "^All suites passed." /tmp/drill-suites.log; then
  pass "run-rls-tests.sh: All suites passed against the restored database"
else
  fail "run-rls-tests.sh did not pass against the restore (log: /tmp/drill-suites.log)"
  grep -E "SUITE FAILED|psql: ERROR" /tmp/drill-suites.log | head -10 || true
fi

swap_back
ELAPSED=$(( $(date +%s) - START ))
echo
if [ "$FAIL" = "0" ]; then
  echo "DRILL PASSED in ${ELAPSED}s ($(date -u +%Y-%m-%dT%H:%MZ))."
else
  echo "DRILL FAILED after ${ELAPSED}s."
  exit 1
fi
