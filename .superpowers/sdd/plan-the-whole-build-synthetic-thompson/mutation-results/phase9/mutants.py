"""Phase 9 Task 5: the 12-mutant run against supabase/tests/rls_phase9_integrations.sql.

Each mutant is applied to the LIVE database (latest pg_get_functiondef with one
change, or one DDL statement), the ig suite is run, the named red assertions are
recorded, and the original definition is restored in a finally block. Usage:
  python mutants.py [M01 M02 ...]   (default: all, control first and last)
Local stack only. Run from anywhere; paths resolve from this file.
"""
import os, subprocess, sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, *[".."] * 5))
SUITE = os.path.join(ROOT, "supabase", "tests", "rls_phase9_integrations.sql")
CTR = "supabase_db_getsetpaid"
ENV = dict(os.environ, MSYS_NO_PATHCONV="1")


def psql(sql):
    r = subprocess.run(["docker", "exec", "-i", CTR, "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-tA"],
                       input=sql, capture_output=True, text=True, env=ENV, encoding="utf-8")
    if r.returncode != 0:
        raise RuntimeError(r.stderr)
    return r.stdout


def fdef(sig):
    return psql(f"select pg_get_functiondef('{sig}'::regprocedure)").rstrip("\n") + ";"


CLEAN = open(os.path.join(HERE, "clean.sql"), encoding="utf-8").read()


def run_suite():
    psql(CLEAN)
    subprocess.run(["docker", "cp", SUITE, f"{CTR}:/tmp/ig.sql"], check=True, capture_output=True, env=ENV)
    r = subprocess.run(["docker", "exec", CTR, "psql", "-U", "postgres", "-d", "postgres", "-q", "--pset=footer=off", "-f", "/tmp/ig.sql"],
                       capture_output=True, text=True, env=ENV, encoding="utf-8")
    errs = [l for l in (r.stdout + r.stderr).splitlines() if l.startswith("psql:") and "ERROR" in l]
    total, red = psql("select count(*) || '|' || count(*) filter (where not pass) from ig.results").strip().split("|")
    labels = psql("select label from ig.results where not pass order by seq").strip().splitlines()
    return int(total), int(red), labels, errs


def rep(t, old, new):
    assert t.count(old) == 1, (old, t.count(old))
    return t.replace(old, new)


def cut(t, a, b):
    i = t.index(a); j = t.index(b, i)
    return t[:i] + t[j:]


SIG = {
    "connect": "public.connect_integration(uuid,text,uuid)",
    "row": "private.revoke_integration_row(uuid,uuid,text)",
    "erase": "private.erase_account(uuid,uuid)",
    "cat": "private.export_catalogue()",
    "guard": "private.integration_connections_guard()",
}
ORIG = {k: fdef(v) for k, v in SIG.items()}
TRIG = psql("select pg_get_triggerdef(oid) from pg_trigger where tgname='integration_connections_follow_membership'").strip() + ";"
POL = "create policy integration_connections_select on public.integration_connections for select to authenticated using ("
POLQ = psql("select qual from pg_policies where policyname='integration_connections_select'").strip()
assert TRIG.startswith("CREATE") and POLQ

# name -> (apply-sql builder, restore-sql)
def fn(key, f):
    return (lambda: f(ORIG[key]) , ORIG[key])

M = {
 "M01 grant insert on connections to authenticated": (lambda: "grant insert on public.integration_connections to authenticated;", "revoke insert on public.integration_connections from authenticated;"),
 "M02 select policy dropped and recreated as using (true)": (lambda: "drop policy integration_connections_select on public.integration_connections;" + POL + "true);",
        "drop policy integration_connections_select on public.integration_connections;" + POL + POLQ + ");"),
 "M03 connect: has_permission check removed": fn("connect", lambda d: rep(d, "if not (public.has_permission(p_org, 'manage_integrations')\n          or (v_live", "if not (true\n          or (v_live")),
 "M04 connect: plan check removed": fn("connect", lambda d: rep(d, "if not exists (select 1 from private.crm_write_organisations() w where w = p_org)\n     and not (v_live", "if false\n     and not (v_live")),
 "M05 connect: live check removed": fn("connect", lambda d: rep(d, "if not exists (select 1 from private.integration_providers() p\n                  where p.provider = p_provider and p.live) then", "if false then")),
 "M06 revoke_integration_row: Vault delete removed": fn("row", lambda d: rep(d, "  delete from vault.secrets s\n   where s.id = v_c.token_secret_id\n      or s.name = 'integration:' || v_c.id::text;\n", "")),
 "M07 grant execute on read_integration_token to authenticated": (lambda: "grant execute on function public.read_integration_token(uuid) to authenticated;", "revoke execute on function public.read_integration_token(uuid) from authenticated;"),
 "M08 membership trigger removed": (lambda: "drop trigger integration_connections_follow_membership on public.organisation_memberships;", TRIG),
 "M09 erase_account: integration step removed": fn("erase", lambda d: cut(d, "  -- (5c) THE PERSON'S OWN INTEGRATIONS", "  -- (6) THE IDENTIFIERS NO FOREIGN KEY PROTECTS")),
 "M10 export: token_secret_id in the workspace projection": fn("cat", lambda d: d.replace("array['id','organisation_id','provider','owner_user_id','status','scopes','token_expires_at'", "array['id','organisation_id','provider','owner_user_id','status','scopes','token_secret_id','token_expires_at'", 1)),
 "M11 guard: revoked_is_terminal removed": fn("guard", lambda d: rep(d, "  if tg_op = 'UPDATE' and old.status = 'revoked' then", "  if false then")),
 "M12 control: no mutation": (lambda: "select 1;", "select 1;"),
}

only = sys.argv[1:]
out = []
def report(name, res):
    total, red, labels, errs = res
    line = f"{name} -> {total} assertions, {red} red" + (f" ({'; '.join(labels)})" if labels else "") + (f" ERRORS={errs}" if errs else "")
    print(line, flush=True); out.append(line)

report("CONTROL (before)", run_suite())
for name, (apply, restore) in M.items():
    if only and name.split()[0] not in only:
        continue
    sql = apply()
    if name.startswith(("M03", "M04", "M05", "M06", "M09", "M10", "M11")) and sql == restore:
        out.append(name + " -> MUTATION DID NOT APPLY"); print(out[-1]); continue
    try:
        psql(sql)
        report(name, run_suite())
    finally:
        psql(restore)
report("CONTROL (restored)", run_suite())
# A full run writes results.txt; a subset (arguments) writes its own file, so it never clobbers the full record.
name_out = "results.txt" if not only else "results-" + "-".join(only) + ".txt"
open(os.path.join(HERE, name_out), "w", encoding="utf-8").write("\n".join(out) + "\n")
