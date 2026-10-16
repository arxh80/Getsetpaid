"""Q228 Task 5: the whole mutation run for the closure-backup-parts branch.

SQL mutants M01-M18 (plus Task 1's split/extra mutants M08a, M08b, M08c, M11b), each applied to
the LIVE local database and restored in a finally block:
  - M01-M11b: the latest pg_get_functiondef with one change, or one DDL statement (Task 1's
    driver, unchanged in substance);
  - M12-M17: the committed static mutants supabase/tests/mutations/21a-21f, applied as they are;
  - M18: the committed supabase/tests/mutations/10-export-download-authorisation.sql.
  For the file-based ones the driver first diffs the file's function against the live
  pg_get_functiondef and records the changed lines, so a stale file (a later migration rebuilt the
  function) shows up as more than one change instead of silently mutating the wrong text.
  The restore is CREATE OR REPLACE from the definition captured before any mutant was applied.

Every SQL mutant runs the qp suite (supabase/tests/rls_q228_closure_backup_parts.sql); M12 and M13
also run the closure suite (cw, rls_phase8_workspace_closure.sql); M18 also runs the exports
suite (xp, rls_phase8_exports.sql) and the permission matrix's "cannot audit-and-download a job
that is not theirs". cw and xp read the runner's fixtures, so the database must be one the full
run-rls-tests.sh has just passed on (fresh reset first). The control (no mutation) runs every one
of those layers before, and the SQL suites again after: equal totals with the same red set is the
evidence the restores were exact.

TypeScript mutants T1-T6: the source edited in place, the named Vitest file run (the -t filter
where the brief names a case), then `git checkout -- <file>` in a finally block. Each file must be
clean in git before it is edited. T7 is not re-run here: it is e2e-only and was measured in
Task 4 (task-4-report.md), EQUIVALENT in e2e and killed by the service-client census.

Each mutant lists the assertions the plan says it must redden; a missing one is reported as
EXPECTED-RED MISSING. Usage:
  python mutants.py                 all SQL mutants then all T mutants (control first and last)
  python mutants.py M12 M13 T3      a subset; writes results-<args>.txt and leaves results.txt alone
Local stack only. Run from anywhere; paths resolve from this file.
"""
import difflib, os, re, subprocess, sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, *[".."] * 5))
TESTS = os.path.join(ROOT, "supabase", "tests")
MUTDIR = os.path.join(TESTS, "mutations")
CTR = "supabase_db_getsetpaid"
ENV = dict(os.environ, MSYS_NO_PATHCONV="1")
ANSI = re.compile(r"\x1b\[[0-9;]*m")


def psql(sql):
    r = subprocess.run(["docker", "exec", "-i", CTR, "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-tA"],
                       input=sql, capture_output=True, text=True, env=ENV, encoding="utf-8")
    if r.returncode != 0:
        raise RuntimeError(r.stderr)
    return r.stdout


def fndef(sig):
    return psql(f"select pg_get_functiondef('{sig}'::regprocedure)").rstrip("\n") + ";"


# ---------------------------------------------------------------------------
# psql variables for cw and xp: run-rls-tests.sh's P7VARS, rebuilt from the
# fixture users the runner created (found by email, as the runner itself does
# on a second run).
# ---------------------------------------------------------------------------
def uid(u):
    v = psql(f"select id from auth.users where email = '{u}@test.local'").strip()
    if not v:
        raise RuntimeError(f"fixture user {u}@test.local is missing: run run-rls-tests.sh on a fresh reset first")
    return v


def claims(i, aal=None):
    return '{"sub":"%s","role":"authenticated"%s}' % (i, f',"aal":"{aal}"' if aal else "")


def p7vars():
    p2aal = dict(powner="aal2", padmin="aal2", pmanager="aal1", pbooker="aal1", pvenuemgr="aal1", pfinance="aal2",
                 pmarketing="aal1", pstd1="aal1", pstd2="aal1", pro="aal1", pbowner="aal2", pmulti="aal2",
                 pgmgr="aal2", pbmgr="aal2")
    out = []
    for u, aal in p2aal.items():
        i = uid(u)
        out += ["-v", f"{u}={i}", "-v", f"{u}_c={claims(i, aal)}", "-v", f"{u}_c1={claims(i, 'aal1')}"]
    s = uid("super")
    out += ["-v", f"super={s}", "-v", f"super_c={claims(s, 'aal2')}", "-v", f"super_c1={claims(s, 'aal1')}"]
    return out


CLEAN = open(os.path.join(HERE, "clean.sql"), encoding="utf-8").read()
SUITES = {"qp": "rls_q228_closure_backup_parts.sql", "cw": "rls_phase8_workspace_closure.sql", "xp": "rls_phase8_exports.sql"}
_VARS = None


def run_suite(schema):
    global _VARS
    args = []
    if schema == "qp":
        psql(CLEAN)
    else:
        if _VARS is None:
            _VARS = p7vars()
        args = _VARS
    f = SUITES[schema]
    subprocess.run(["docker", "cp", os.path.join(TESTS, f), f"{CTR}:/tmp/{f}"], check=True, capture_output=True, env=ENV)
    r = subprocess.run(["docker", "exec", CTR, "psql", "-U", "postgres", "-d", "postgres", "-q", "--pset=footer=off", *args,
                        "-f", f"/tmp/{f}"], capture_output=True, text=True, env=ENV, encoding="utf-8")
    errs = [l for l in (r.stdout + r.stderr).splitlines() if l.startswith("psql:") and "ERROR" in l]
    total, red = psql(f"select count(*) || '|' || count(*) filter (where not pass) from {schema}.results").strip().split("|")
    labels = psql(f"select label || '  [expected ' || coalesce(expected, '<null>') || ', got ' || coalesce(actual, '<null>') || ']' "
                  f"from {schema}.results where not pass order by seq").strip().splitlines()
    return dict(kind="psql", name=schema, total=int(total), red=int(red), labels=labels, errs=errs)


def run_vitest(path, grep=None):
    cmd = f'pnpm exec vitest run {path}' + (f' -t "{grep}"' if grep else "")
    r = subprocess.run(cmd, shell=True, cwd=ROOT, capture_output=True, text=True, encoding="utf-8", errors="replace")
    text = ANSI.sub("", r.stdout + r.stderr)
    fails = sorted({l.strip() for l in text.splitlines() if re.match(r"^\s*(FAIL|×)\s", l) and ">" in l})
    summary = [l.strip() for l in text.splitlines() if re.match(r"^\s*Tests\s+", l)]
    return dict(kind="vitest", name=path + (f' -t "{grep}"' if grep else ""), exit=r.returncode, labels=fails,
                summary=summary[-1] if summary else "<no summary line>", red=len(fails))


# ---------------------------------------------------------------------------
# M01-M11b: Task 1's mutants (20261101000000), unchanged in substance.
# ---------------------------------------------------------------------------
def rep(t, old, new):
    assert t.count(old) == 1, (old, t.count(old))
    return t.replace(old, new)


GUARD = fndef("private.export_job_parts_guard()")
UPD = fndef("private.export_jobs_before_update()")
CLAIM = fndef("public.claim_export_job()")
OWED = fndef("private.closure_backup_owed(uuid)")
MANIFEST = fndef("public.retention_object_manifest(uuid,integer)")
AUDIT = fndef("public.audit_export_download(uuid,integer)")

POLICY = ("create policy export_job_parts_select_own on public.export_job_parts for select to authenticated "
          "using (exists (select 1 from public.export_jobs j where j.id = export_job_parts.job_id));")
KEY_SHAPE = ("alter table public.export_job_parts add constraint export_job_parts_storage_key_shape check (storage_key = "
             "case when part_no = 1 then 'exports/' || job_id::text || '.zip' "
             "else 'exports/' || job_id::text || '-part-' "
             "|| pg_catalog.lpad(part_no::text, greatest(4, pg_catalog.length(part_no::text)), '0') || '.zip' end);")
COUNT_SHAPE = ("alter table public.export_jobs add constraint export_jobs_part_count_shape check ("
               "part_count >= 0 and (closure_backup or part_count = 0) "
               "and (resume_cursor is null or (closure_backup and status in ('queued', 'running'))));")
REQUEUE_CMP = ("    if new.part_count <> (select pg_catalog.count(*) from public.export_job_parts p where p.job_id = old.id) then\n"
               "      raise exception 'export_jobs: part_count does not match the stored parts'")
SUCCESS_CMP = ("  if new.status = 'succeeded'\n"
               "     and new.part_count <> (select pg_catalog.count(*) from public.export_job_parts p where p.job_id = old.id) then")


def fn(orig, f):
    return (lambda: f(orig), orig)


def from_file(fname, live):
    text = open(os.path.join(MUTDIR, fname), encoding="utf-8").read()
    return (lambda: text, live, fname)


def file_vs_live(fname, live):
    text = open(os.path.join(MUTDIR, fname), encoding="utf-8").read()
    body = text[text.index("CREATE OR REPLACE FUNCTION"):].rstrip().splitlines()
    want = live.rstrip().splitlines()
    d = [l for l in difflib.unified_diff(want, body, lineterm="", n=0) if not l.startswith(("---", "+++", "@@"))]
    return (sum(1 for l in d if l.startswith("-")), sum(1 for l in d if l.startswith("+")), d)


MATRIX = ("tests/integration/security/phase7-permission-matrix.test.ts", "cannot audit-and-download a job that is not theirs")

# name -> (apply, restore, file-or-None, extra suites, plan's expected red codes; a trailing * admits a letter suffix)
SQL = {
 "M01 parts policy using (true)": (
     lambda: "drop policy export_job_parts_select_own on public.export_job_parts;\n"
             "create policy export_job_parts_select_own on public.export_job_parts for select to authenticated using (true);",
     "drop policy export_job_parts_select_own on public.export_job_parts;\n" + POLICY, None, [], ["QR2", "QR3"]),
 "M02 insert+delete granted to authenticated": (
     lambda: "grant insert, delete on public.export_job_parts to authenticated;",
     "revoke insert, delete on public.export_job_parts from authenticated;", None, [], ["QT3", "QR5a", "QR5c"]),
 "M03 guard: server-session check dropped": (*fn(GUARD, lambda d: rep(d, "  if not v_server_session then", "  if false then")), None, [], ["QG1"]),
 "M04 guard: part_count + 1 order check dropped": (*fn(GUARD, lambda d: rep(d, "if new.part_no <> v_part_count + 1 then", "if false then")), None, [], ["QG4"]),
 "M05 guard: running check dropped": (*fn(GUARD, lambda d: rep(d, "if v_status <> 'running' then", "if false then")), None, [], ["QG3"]),
 "M06 guard: delete admits any status": (*fn(GUARD, lambda d: rep(d, "if v_status <> 'failed' then", "if false then")), None, [], ["QG6"]),
 "M07 re-queue clause without old.closure_backup": (*fn(UPD, lambda d: rep(d, "if not (old.closure_backup and new.resume_cursor is not null", "if not (true and new.resume_cursor is not null")), None, [], ["QJ2"]),
 "M08 both part-count comparisons dropped": (*fn(UPD, lambda d: rep(rep(d, REQUEUE_CMP, REQUEUE_CMP.replace("if new.part_count <> (", "if false and new.part_count <> (")),
                                                                    SUCCESS_CMP, SUCCESS_CMP.replace("if new.status = 'succeeded'", "if false"))), None, [], ["QJ3", "QJ5"]),
 "M08a re-queue part-count comparison dropped": (*fn(UPD, lambda d: rep(d, REQUEUE_CMP, REQUEUE_CMP.replace("if new.part_count <> (", "if false and new.part_count <> ("))), None, [], ["QJ3"]),
 "M08c success part-count comparison dropped": (*fn(UPD, lambda d: rep(d, SUCCESS_CMP, SUCCESS_CMP.replace("if new.status = 'succeeded'", "if false"))), None, [], ["QJ5"]),
 "M08b success comparison extended to failed": (*fn(UPD, lambda d: rep(d, SUCCESS_CMP, SUCCESS_CMP.replace("if new.status = 'succeeded'", "if new.status in ('succeeded', 'failed')"))), None, [], ["QJ7"]),
 "M09 claim ordered by requested_at again": (*fn(CLAIM, lambda d: rep(d, "order by coalesce(j.started_at, j.requested_at), j.seq", "order by j.requested_at, j.seq")), None, [], ["QJ6"]),
 "M10 export_job_parts_storage_key_shape dropped": (
     lambda: "alter table public.export_job_parts drop constraint export_job_parts_storage_key_shape;", KEY_SHAPE, None, [], ["QT6*", "QT7*"]),
 "M11 export_jobs_part_count_shape dropped": (
     lambda: "alter table public.export_jobs drop constraint export_jobs_part_count_shape;", COUNT_SHAPE, None, [], ["QT8*", "QJ5b"]),
 "M11b failure no longer clears resume_cursor": (*fn(UPD, lambda d: rep(d, "  if new.status = 'failed' then\n    new.resume_cursor := null;", "  if false then\n    new.resume_cursor := null;")), None, [], ["QJ7c", "QK3"]),
 "M12 closure_backup_owed: the pre-Q228 predicate (any one download releases)": (*from_file("21a-closure-hold-any-part-releases.sql", OWED), ["cw"], ["QO2"]),
 "M13 closure_backup_owed: actor_user_id = requested_by dropped": (*from_file("21b-closure-hold-any-actor.sql", OWED), ["cw"], ["QO5"]),
 "M14 manifest: parts term dropped from orphans": (*from_file("21c-manifest-orphans-ignore-parts.sql", MANIFEST), [], ["QM2", "QM3"]),
 "M15 manifest: expired-parts union dropped": (*from_file("21d-manifest-parts-never-expire.sql", MANIFEST), [], ["QM1"]),
 "M16 manifest: the orphan exemption also keeps failed jobs' parts": (*from_file("21e-manifest-keeps-failed-parts.sql", MANIFEST), [], ["QM4"]),
 "M17 audit_export_download: part-exists check dropped": (*from_file("21f-download-audit-no-part-check.sql", AUDIT), [], ["QD4*"]),
 "M18 audit_export_download: requested_by = auth.uid() dropped": (*from_file("10-export-download-authorisation.sql", AUDIT), ["xp", "matrix"], ["QD5", "matrix"]),
}


# ---------------------------------------------------------------------------
# T1-T6: the TypeScript mutants (task-2-report.md), re-run.
# ---------------------------------------------------------------------------
T5_OLD_READ = "    const page = await readPage(supabase, jobId, table, after, pageLimit);\n    if (page.length === 0) {\n      exhausted = true;\n      break;\n    }\n"
T5_NEW_READ = T5_OLD_READ + "    pageLastKey = keyOf(page[page.length - 1], keyColumn) ?? pageLastKey;\n"
TS = {
 "T1 wouldFit ignores directoryBytes": (
     "lib/export/zip.ts", [("      this.directoryBytes +\n      46 +", "      46 +")],
     "tests/unit/export/zip.test.ts", None, ["counts the central directory"]),
 "T2 the builder ignores max_rows_per_table (page size and cut)": (
     "lib/export/parts.ts", [("const leftInTable = limits.max_rows_per_table - rows;", "const leftInTable = Number.MAX_SAFE_INTEGER - rows;")],
     "tests/integration/export/closure-parts.test.ts", "C1", ["C1"]),
 "T3 the failure path skips removeClosureParts": (
     "lib/export/runner.ts", [("          await removeClosureParts(supabase, job.id);", "          void removeClosureParts;")],
     "tests/integration/export/closure-parts.test.ts", "C7", ["C7"]),
 "T4 effectiveLimits takes the max": (
     "lib/export/runner.ts", [("out[field] = Math.min(out[field], value);", "out[field] = Math.max(out[field], value);")],
     "tests/unit/export/parts-contract.test.ts", None, ["an override cannot loosen"]),
 "T5 on a cut, cursor.after = the page's last key": (
     "lib/export/parts.ts", [("  let after = cursor.after;\n  let reason", "  let after = cursor.after;\n  let pageLastKey = \"\";\n  let reason"),
                             (T5_OLD_READ, T5_NEW_READ),
                             ("  if (exhausted) return null;\n  cursor.after = lastKey;", "  if (exhausted) return null;\n  cursor.after = pageLastKey;")],
     "tests/integration/export/closure-parts.test.ts", "C3", ["C3"]),
 "T6 the re-queue omits resume_cursor": (
     "lib/export/runner.ts", [("              resume_cursor: built.cursor as unknown as Record<string, unknown>,\n", "")],
     "tests/integration/export/closure-parts.test.ts", "C6", ["C6"]),
}


def git(*a):
    return subprocess.run(["git", *a], cwd=ROOT, capture_output=True, text=True)


OUT = os.path.join(HERE, "results.txt" if len(sys.argv) == 1 else "results-" + "-".join(sys.argv[1:]) + ".txt")
out = open(OUT, "w", encoding="utf-8")


def report(name, results, expect=None):
    out.write(f"== {name}\n")
    reds = []
    for res in results:
        if res["kind"] == "psql":
            out.write(f"   [{res['name']}] {res['total']} assertions, {res['red']} red\n")
            reds += [(res["name"], l) for l in res["labels"]]
            for e in res["errs"]:
                out.write(f"   [{res['name']}] ERR  {e}\n")
        else:
            out.write(f"   [vitest] {res['name']}: exit {res['exit']}; {res['summary']}\n")
            reds += [("vitest", l) for l in res["labels"]]
        for l in res["labels"]:
            out.write(f"   [{res['name'] if res['kind'] == 'psql' else 'vitest'}] RED  {l}\n")
    if expect:
        missing = []
        for code in expect:
            if code == "matrix":
                ok = any(s == "vitest" and MATRIX[1] in l for s, l in reds)
            elif code.endswith("*"):
                c = code[:-1]
                ok = any(l.split()[0] == c or (l.split()[0].startswith(c) and l.split()[0][len(c):].isalpha()) for _, l in reds)
            elif code.startswith(("Q",)):
                ok = any(l.split()[0] == code for _, l in reds)
            else:
                ok = any(code in l for s, l in reds if s == "vitest")
            if not ok:
                missing.append(code)
        out.write(f"   EXPECTED-RED {'MISSING: ' + ', '.join(missing) if missing else 'all present: ' + ', '.join(expect)}\n")
    out.flush()


want = sys.argv[1:]
run_sql = not want or any(w.startswith("M") for w in want)
run_ts = not want or any(w.startswith("T") for w in want)

if run_sql:
    ctl = [run_suite("qp"), run_suite("cw"), run_suite("xp")]
    if not want or "M18" in want:
        ctl.append(run_vitest(*MATRIX))
    report("M00 CONTROL (before)", ctl)
    for name, (apply_sql, restore_sql, fname, extra, expect) in SQL.items():
        if want and name.split()[0] not in want:
            continue
        if fname:
            rm, add, d = file_vs_live(fname, restore_sql)
            out.write(f"-- {name.split()[0]} file {fname} vs live: {rm} line(s) removed, {add} added\n")
            for l in d:
                out.write(f"--    {l}\n")
        try:
            psql(apply_sql())
            res = [run_suite("qp")]
            for s in extra:
                res.append(run_vitest(*MATRIX) if s == "matrix" else run_suite(s))
            report(name, res, expect)
        finally:
            psql(restore_sql)
    report("M00 CONTROL (restored)", [run_suite("qp"), run_suite("cw"), run_suite("xp")])

if run_ts:
    for name, (path, edits, test, grep, expect) in TS.items():
        if want and name.split()[0] not in want:
            continue
        if git("diff", "--quiet", "--", path).returncode != 0:
            raise RuntimeError(f"{path} has uncommitted changes; refusing to mutate it")
        full = os.path.join(ROOT, path)
        try:
            src = open(full, encoding="utf-8", newline="").read()
            eol = "\r\n" if "\r\n" in src else "\n"  # core.autocrlf: some checkouts are CRLF
            for old, new in edits:
                src = rep(src, old.replace("\n", eol), new.replace("\n", eol))
            open(full, "w", encoding="utf-8", newline="").write(src)
            out.write(f"-- {name.split()[0]}: {path}, {len(edits)} edit(s); git diff --stat: {git('diff', '--stat', '--', path).stdout.strip().splitlines()[-1]}\n")
            report(name, [run_vitest(test, grep)], expect)
        finally:
            git("checkout", "--", path)
        if git("diff", "--quiet", "--", path).returncode != 0:
            raise RuntimeError(f"{path} was not restored")
    out.write(f"-- after the T mutants: git status --porcelain lib/ = {git('status', '--porcelain', 'lib').stdout.strip() or '(clean)'}\n")

out.close()
print(open(OUT, encoding="utf-8").read())
