"""Q189 mutation run: 6 mutants of private.audit_organisation_update() (20261031000000)
plus the M00 control, against supabase/tests/rls_phase8_crm_audit_p3_6.sql.

Each mutant is applied to the LIVE database (the latest pg_get_functiondef with one
change, or one DDL statement), the c7 suite is run standalone with the runner's P7
variables rebuilt from auth.users, the red assertions are recorded, and the original
definition is restored in a finally block. Run AFTER a full run-rls-tests.sh on a fresh
reset (the suite needs the runner's fixtures; its own § PZ cleans up after itself).
Usage: python mutants.py [M01 M02 ...]   (default: all, control first and last)
"""
import os, subprocess, sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, *[".."] * 5))
SUITE = os.path.join(ROOT, "supabase", "tests", "rls_phase8_crm_audit_p3_6.sql")
CTR = "supabase_db_getsetpaid"
ENV = dict(os.environ, MSYS_NO_PATHCONV="1")


def psql(sql):
    r = subprocess.run(["docker", "exec", "-i", CTR, "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-tA"],
                       input=sql, capture_output=True, text=True, env=ENV, encoding="utf-8")
    if r.returncode != 0:
        raise RuntimeError(r.stderr)
    return r.stdout


AAL = {"padmin": "aal2", "pmanager": "aal1", "pbowner": "aal2", "pstd1": "aal1", "super": "aal2"}
VARS = []
for u, aal in AAL.items():
    uid = psql(f"select id from auth.users where email like '{u}@%' order by created_at limit 1").strip()
    assert uid, u
    VARS += ["-v", f"{u}={uid}", "-v", f'{u}_c={{"sub":"{uid}","role":"authenticated","aal":"{aal}"}}']


def run_suite():
    subprocess.run(["docker", "cp", SUITE, f"{CTR}:/tmp/c7.sql"], check=True, capture_output=True, env=ENV)
    r = subprocess.run(["docker", "exec", CTR, "psql", "-U", "postgres", "-d", "postgres", "-q", "--pset=footer=off",
                        *VARS, "-f", "/tmp/c7.sql"], capture_output=True, text=True, env=ENV, encoding="utf-8")
    errs = [l for l in (r.stdout + r.stderr).splitlines() if l.startswith("psql:") and "ERROR" in l]
    total, red = psql("select count(*) || '|' || count(*) filter (where not pass) from c7.results").strip().split("|")
    labels = psql("select label from c7.results where not pass order by seq").strip().splitlines()
    return int(total), int(red), labels, errs


def rep(t, old, new):
    assert t.count(old) == 1, (old, t.count(old))
    return t.replace(old, new)


SIG = "private.audit_organisation_update()"
ORIG = psql(f"select pg_get_functiondef('{SIG}'::regprocedure)").rstrip("\n") + ";"


def fn(f):
    return (lambda: f(ORIG), ORIG)


M = {
 "M01 sessionless exemption removed": fn(lambda d: rep(d, "if (select auth.uid()) is null then\n    return null;", "if false then\n    return null;")),
 "M02 no-op exemption removed": fn(lambda d: rep(d, "if pg_catalog.cardinality(v_changed) = 0 then\n    return null;", "if false then\n    return null;")),
 "M03 lifecycle columns back in the changed set": fn(lambda d: rep(d, "'updated_at', 'deleted_at', 'lifecycle_state', 'lifecycle_changed_at',\n                       'lifecycle_reason', 'retention_expires_at'", "'updated_at'")),
 "M04 every changed column valued, not only name/slug": fn(lambda d: rep(d, "where c in ('name', 'slug');", "where true;")),
 "M06 updated_at back in the changed set": fn(lambda d: rep(d, "where n.key not in ('updated_at', 'deleted_at',", "where n.key not in ('deleted_at',")),
 "M05 trigger dropped": (lambda: "drop trigger organisations_audit_update on public.organisations;",
                         "create trigger organisations_audit_update after update on public.organisations for each row execute function private.audit_organisation_update();"),
}

OUT = os.path.join(HERE, "results.txt" if len(sys.argv) == 1 else "results-" + "-".join(a for a in sys.argv[1:]) + ".txt")
out = open(OUT, "w", encoding="utf-8")


def report(name, res):
    total, red, labels, errs = res
    out.write(f"== {name}: {total} assertions, {red} red\n")
    for l in labels:
        out.write(f"   RED  {l}\n")
    for e in errs:
        out.write(f"   ERR  {e}\n")
    out.flush()


report("M00 CONTROL (before)", run_suite())
want = sys.argv[1:]
for name, (apply_sql, restore_sql) in M.items():
    if want and name.split()[0] not in want:
        continue
    try:
        psql(apply_sql())
        report(name, run_suite())
    finally:
        psql(restore_sql)
report("M00 CONTROL (restored)", run_suite())
out.close()
print(open(OUT, encoding="utf-8").read())
