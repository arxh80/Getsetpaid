"""Second pass of every psql suite on the database run-rls-tests.sh just passed on (no reset between).

run-rls-tests.sh itself refuses (and cannot) run twice: schema_invariants, rls_foundation and
rls_phase2_crm build the shared fixtures and never tear them down, by design (its preflight comment).
So this replays every OTHER run_suite call from the runner, in the runner's order and with the
runner's variable sets (P2VARS/P6VARS/P7VARS rebuilt from the fixture users by email), and reports
each suite's recorded total against its pin, its red labels and any psql ERROR line.
Usage: python second_pass.py <worktree> <out.txt>
"""
import re, subprocess, sys

W, OUT = sys.argv[1], sys.argv[2]
TESTS = W + "/supabase/tests"
CTR = "supabase_db_getsetpaid"
import os
ENV = dict(os.environ, MSYS_NO_PATHCONV="1")
SKIP = {"schema_invariants.sql", "rls_foundation.sql", "rls_phase2_crm.sql"}


def psql(sql):
    r = subprocess.run(["docker", "exec", "-i", CTR, "psql", "-U", "postgres", "-d", "postgres", "-tA"],
                       input=sql, capture_output=True, text=True, env=ENV, encoding="utf-8")
    if r.returncode != 0:
        raise RuntimeError(r.stderr)
    return r.stdout


def uid(u):
    v = psql(f"select id from auth.users where email = '{u}@test.local'").strip()
    assert v, u
    return v


def c(i, aal):
    return '{"sub":"%s","role":"authenticated","aal":"%s"}' % (i, aal)


P2 = dict(powner="aal2", padmin="aal2", pmanager="aal1", pbooker="aal1", pvenuemgr="aal1", pfinance="aal2",
          pmarketing="aal1", pstd1="aal1", pstd2="aal1", pro="aal1", pbowner="aal2", pmulti="aal2")
P2VARS = []
for u, a in P2.items():
    i = uid(u)
    P2VARS += ["-v", f"{u}={i}", "-v", f"{u}_c={c(i, a)}", "-v", f"{u}_c1={c(i, 'aal1')}"]
P6VARS = list(P2VARS)
for u in ("pgmgr", "pbmgr"):
    i = uid(u)
    P6VARS += ["-v", f"{u}={i}", "-v", f"{u}_c={c(i, 'aal2')}", "-v", f"{u}_c1={c(i, 'aal1')}"]
s = uid("super")
P6VARS += ["-v", f"super={s}", "-v", f"super_c={c(s, 'aal2')}"]
P7VARS = P6VARS + ["-v", f"super_c1={c(s, 'aal1')}"]
SETS = {"": [], "P2VARS": P2VARS, "P6VARS": P6VARS, "P7VARS": P7VARS}

runner = open(TESTS + "/run-rls-tests.sh", encoding="utf-8").read()
calls = re.findall(r'^run_suite "([^"]+)" (\S+) (\S+) (\S+)(?: "\$\{(\w+)\[@\]\}")?\s*$', runner, re.M)
out = open(OUT, "w", encoding="utf-8")
bad = 0
for label, f, schema, pin, vs in calls:
    if f in SKIP:
        out.write(f"SKIP  {label} ({f}): builds the shared fixtures, not re-runnable by design\n")
        continue
    subprocess.run(["docker", "cp", f"{TESTS}/{f}", f"{CTR}:/tmp/{f}"], check=True, capture_output=True, env=ENV)
    r = subprocess.run(["docker", "exec", CTR, "psql", "-U", "postgres", "-d", "postgres", "-q", "--pset=footer=off",
                        *SETS[vs or ""], "-f", f"/tmp/{f}"], capture_output=True, text=True, env=ENV, encoding="utf-8")
    errs = [l for l in (r.stdout + r.stderr).splitlines() if re.match(r"^psql:.*ERROR:", l)]
    total, red = psql(f"select count(*) || '|' || count(*) filter (where not pass) from {schema}.results").strip().split("|")
    labels = psql(f"select label from {schema}.results where not pass order by seq").strip().splitlines()
    ok = total == pin and red == "0" and not errs
    bad += 0 if ok else 1
    out.write(f"{'PASS' if ok else 'FAIL'}  {label}: {total} recorded (pin {pin}), {red} red, {len(errs)} ERROR line(s)\n")
    for l in labels:
        out.write(f"        RED  {l}\n")
    for e in errs:
        out.write(f"        ERR  {e}\n")
    out.flush()
out.write(f"\n{len(calls)} run_suite calls; {len(SKIP)} skipped; {bad} not clean on the second run\n")
out.close()
print(open(OUT, encoding="utf-8").read())
