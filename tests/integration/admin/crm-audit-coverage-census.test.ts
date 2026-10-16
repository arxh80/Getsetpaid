// THE CRM WRITE-AUDIT COVERAGE CENSUS (Phase 8 Task 7, Q122).
//
// The question this file answers is not "are the sixteen tables the brief
// named audited?" but "is there ANY tenant-owned table a client can write
// that nothing audits?" -- derived from the live catalogue, so that a table
// Phase 9 adds with a client grant and no trigger lands here as a red test
// naming itself, rather than as a pentest finding.
//
// `private.audit_coverage()` (20261006000000) does the derivation in SQL:
// every table in `public` with a foreign key to public.organisations (or
// organisations itself) on which `authenticated`/`anon` holds INSERT, UPDATE
// or DELETE at table or column level, and for each such operation whether a
// generic pair (private.audit_crm_change), a dedicated AFTER ROW
// private.audit_* trigger, or a marker-guarded policy set covers it. This
// file binds that to the two declared rolls in lib/admin/audit-actions.ts --
// CRM_AUDIT_TARGET_TABLE (the generic set) and AUDIT_COVERAGE_EXCUSALS (every
// other client-writable table, with the coverage it claims) -- in BOTH
// directions, so a stale excusal is as red as a missing one. And it proves
// the denominator: a planted table with a client grant and no trigger is
// reported `unaudited` (standing lesson 1 -- a census that cannot see its
// own subject is a green census of nothing).
//
// WHAT THIS CANNOT SEE, stated: the derivation checks that a trigger FIRES
// on an operation, not what it does. A dedicated writer that returns early
// for some writes (private.audit_network_row() does, for a draft insert and
// an ordinary edit) reads as covered here. The behavioural half -- one audit
// row per effective write, per table, with no content in it -- is
// rls_phase8_crm_audit_p3_6.sql and crm-audit-no-content-leak-p3-6.test.ts.
import { afterAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { getLocalSupabaseStatus } from "../rls/support/env";
import {
  AUDIT_COVERAGE_EXCUSALS,
  CRM_AUDIT_TARGETS,
  CRM_AUDIT_TARGET_TABLE,
} from "@/lib/admin/audit-actions";

const pool = new Pool({ connectionString: getLocalSupabaseStatus().dbUrl });

afterAll(async () => {
  await pool.end();
});

interface CoverageRow {
  table_name: string;
  client_writes: string[];
  uncovered_ops: string[];
  coverage: "generic" | "dedicated" | "rpc_only" | "unaudited";
  target_type: string | null;
}

async function coverage(client: { query: Pool["query"] }): Promise<CoverageRow[]> {
  const { rows } = await client.query<CoverageRow>(
    `select table_name, client_writes, uncovered_ops, coverage, target_type
       from private.audit_coverage() order by table_name`,
  );
  return rows;
}

describe("private.audit_coverage(): every tenant-owned client-writable table is audited or excused by name", () => {
  it("DENOMINATOR: the census sees the whole client-writable tenant surface, not a sample", async () => {
    const rows = await coverage(pool);
    // 35 at 208 migrations: the eleven Phase 2 tables, the sixteen Task 7
    // targets, five dedicated, two rpc_only, and organisations. A LOWER
    // number means the derivation lost a table (a grant it cannot see, an
    // FK shape it does not walk); a higher one means Phase 9 added a table
    // and the assertions below say whether it is covered.
    expect(rows.length).toBeGreaterThanOrEqual(35);
    // Every row has at least one client-writable op -- that is what puts a
    // table in the denominator.
    for (const r of rows) expect(r.client_writes.length, r.table_name).toBeGreaterThan(0);
    // The three shapes of client write are all represented, so a blind spot
    // in the privilege check would show as a missing kind, not as silence:
    // table-level INSERT/UPDATE (events), column-level only (documents,
    // feedback), and DELETE (contact_companies, organisation_memberships).
    const byName = new Map(rows.map((r) => [r.table_name, r]));
    expect(byName.get("events")?.client_writes).toEqual(["INSERT", "UPDATE"]);
    expect(byName.get("documents")?.client_writes).toEqual(["INSERT", "UPDATE"]);
    expect(byName.get("feedback")?.client_writes).toEqual(["INSERT", "UPDATE"]);
    expect(byName.get("incident_alerts")?.client_writes).toEqual(["UPDATE"]);
    expect(byName.get("contact_companies")?.client_writes).toEqual(["DELETE", "INSERT", "UPDATE"]);
    expect(byName.get("organisation_memberships")?.client_writes).toEqual(["DELETE", "INSERT", "UPDATE"]);
    // ...and the tables the brief names that have NO client write are NOT in
    // it, by construction -- the day a grant lands they will be.
    expect(byName.has("event_status_changes")).toBe(false);
    expect(byName.has("document_versions")).toBe(false);
    expect(byName.has("merges")).toBe(false);
  });

  it("no table is `unaudited` except the ones AUDIT_COVERAGE_EXCUSALS declares so, with a reason", async () => {
    const rows = await coverage(pool);
    const unaudited = rows.filter((r) => r.coverage === "unaudited").map((r) => r.table_name).sort();
    const declared = Object.entries(AUDIT_COVERAGE_EXCUSALS)
      .filter(([, e]) => e.coverage === "unaudited")
      .map(([t]) => t)
      .sort();
    expect(
      unaudited,
      "a tenant-owned table a client can write has an operation nothing audits. Either attach the " +
        "generic pair (private.audit_crm_change, and register it in CRM_AUDIT_TARGETS) or excuse it " +
        "in AUDIT_COVERAGE_EXCUSALS with the reason and a queued question. Uncovered: " +
        rows.filter((r) => r.coverage === "unaudited").map((r) => `${r.table_name}:${r.uncovered_ops.join("/")}`).join(", "),
    ).toEqual(declared);
    for (const t of declared) {
      expect(AUDIT_COVERAGE_EXCUSALS[t].reason.length, `${t}'s excusal has a reason`).toBeGreaterThan(40);
      expect(AUDIT_COVERAGE_EXCUSALS[t].reason, `${t}'s excusal names where the decision is queued`).toMatch(/Q\d+/);
    }
  });

  it("the `generic` set IS CRM_AUDIT_TARGET_TABLE, in both directions, with the trigger's own target argument", async () => {
    const rows = await coverage(pool);
    const generic = rows.filter((r) => r.coverage === "generic");
    expect(generic.map((r) => r.table_name).sort()).toEqual(Object.values(CRM_AUDIT_TARGET_TABLE).sort());
    for (const r of generic) {
      const target = (Object.entries(CRM_AUDIT_TARGET_TABLE).find(([, t]) => t === r.table_name) ?? [])[0];
      expect(r.target_type, `${r.table_name}'s trigger argument`).toBe(target);
      expect(r.uncovered_ops, `${r.table_name} has an op the generic pair does not see`).toEqual([]);
    }
    // 27 since Task 7 (11 before it).
    expect(generic.length).toBe(Object.keys(CRM_AUDIT_TARGETS).length);
    expect(generic.length).toBe(27);
  });

  it("every other table is in AUDIT_COVERAGE_EXCUSALS with the coverage it claims, and its named triggers exist and fire on the client's ops", async () => {
    const rows = await coverage(pool);
    const others = rows.filter((r) => r.coverage !== "generic");
    expect(others.map((r) => r.table_name).sort()).toEqual(Object.keys(AUDIT_COVERAGE_EXCUSALS).sort());
    for (const r of others) {
      const ex = AUDIT_COVERAGE_EXCUSALS[r.table_name];
      expect(r.coverage, `${r.table_name}: live coverage vs the excusal's claim`).toBe(ex.coverage);
      if (ex.coverage === "unaudited") continue;
      expect(ex.triggers.length, `${r.table_name} names its trigger(s)`).toBeGreaterThan(0);
      const { rows: trg } = await pool.query<{ tgname: string; tgtype: number; fn: string }>(
        `select t.tgname, t.tgtype, n.nspname || '.' || p.proname as fn
           from pg_trigger t join pg_class c on c.oid = t.tgrelid
           join pg_proc p on p.oid = t.tgfoid join pg_namespace n on n.oid = p.pronamespace
          where c.relnamespace = 'public'::regnamespace and c.relname = $1 and not t.tgisinternal
            and t.tgname = any($2::text[])`,
        [r.table_name, [...ex.triggers]],
      );
      expect(trg.map((t) => t.tgname).sort(), `${r.table_name}: every named trigger exists`).toEqual([...ex.triggers].sort());
      if (ex.coverage === "dedicated") {
        // Every client-writable op is fired on by at least one of the named
        // AFTER ROW audit triggers.
        for (const op of r.client_writes) {
          const bit = op === "INSERT" ? 4 : op === "UPDATE" ? 16 : 8;
          const fires = trg.some((t) => (t.tgtype & bit) !== 0 && (t.tgtype & 1) !== 0 && (t.tgtype & 66) === 0 && /^private\.audit_/.test(t.fn));
          expect(fires, `${r.table_name}: a named private.audit_* AFTER ROW trigger fires on ${op}`).toBe(true);
        }
      } else {
        // rpc_only: the named guard is a BEFORE trigger (the policy-independent
        // second gate) and every client op's policy carries the marker term.
        for (const t of trg) expect((t.tgtype & 2) !== 0, `${t.tgname} is a BEFORE guard`).toBe(true);
        const { rows: pol } = await pool.query<{ n: string }>(
          `select count(*)::text as n from pg_policy p
            where p.polrelid = ('public.' || $1)::regclass and p.polcmd in ('a', 'w', '*')
              and coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '') !~ '_in_progress\\(\\)'`,
          [r.table_name],
        );
        expect(pol[0].n, `${r.table_name}: a write policy without the marker term`).toBe("0");
      }
    }
  });

  it("DENOMINATOR, PLANTED: a tenant-owned table with a client grant and no trigger is reported `unaudited`, and the pair makes it `generic`", async () => {
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query(
        `create table public.zz_task7_planted (
           id uuid primary key default gen_random_uuid(),
           organisation_id uuid not null references public.organisations(id) on delete cascade,
           body text)`,
      );
      await client.query(`alter table public.zz_task7_planted enable row level security`);
      // A COLUMN-level grant on purpose -- the shape a table-level census
      // cannot see (Phase 8 Task 2 fix round 1 / Task 4 review I2 class).
      await client.query(`grant insert (organisation_id, body), update (body) on public.zz_task7_planted to authenticated`);
      let rows = await coverage(client);
      const planted = rows.find((r) => r.table_name === "zz_task7_planted");
      expect(planted, "the planted table is in the denominator").toBeDefined();
      expect(planted!.client_writes).toEqual(["INSERT", "UPDATE"]);
      expect(planted!.coverage).toBe("unaudited");
      expect(planted!.uncovered_ops).toEqual(["INSERT", "UPDATE"]);

      // Half a pair is still a hole.
      await client.query(
        `create trigger audit_insert after insert on public.zz_task7_planted
           for each row execute function private.audit_crm_change('zz_planted')`,
      );
      rows = await coverage(client);
      expect(rows.find((r) => r.table_name === "zz_task7_planted")!.coverage).toBe("unaudited");
      expect(rows.find((r) => r.table_name === "zz_task7_planted")!.uncovered_ops).toEqual(["UPDATE"]);

      // The whole pair, and it reads as generic under its own argument.
      await client.query(
        `create trigger audit_update after update on public.zz_task7_planted
           for each row execute function private.audit_crm_change('zz_planted')`,
      );
      rows = await coverage(client);
      const covered = rows.find((r) => r.table_name === "zz_task7_planted")!;
      expect(covered.coverage).toBe("generic");
      expect(covered.target_type).toBe("zz_planted");
      expect(covered.uncovered_ops).toEqual([]);

      // M1 (fix round 1): a trigger that EXISTS is not a trigger that FIRES.
      // Disabled, and then replica-only, the update half is a hole again --
      // before 20261007001000 both read `generic` (measured: O2).
      await client.query(`alter table public.zz_task7_planted disable trigger audit_update`);
      rows = await coverage(client);
      expect(rows.find((r) => r.table_name === "zz_task7_planted")!.coverage).toBe("unaudited");
      expect(rows.find((r) => r.table_name === "zz_task7_planted")!.uncovered_ops).toEqual(["UPDATE"]);
      await client.query(`alter table public.zz_task7_planted enable replica trigger audit_update`);
      rows = await coverage(client);
      expect(rows.find((r) => r.table_name === "zz_task7_planted")!.uncovered_ops).toEqual(["UPDATE"]);
      await client.query(`alter table public.zz_task7_planted enable always trigger audit_update`);
      rows = await coverage(client);
      expect(rows.find((r) => r.table_name === "zz_task7_planted")!.coverage).toBe("generic");

      // ...and a DELETE grant reopens it, because the pair cannot see one.
      await client.query(`grant delete on public.zz_task7_planted to authenticated`);
      rows = await coverage(client);
      expect(rows.find((r) => r.table_name === "zz_task7_planted")!.coverage).toBe("unaudited");
      expect(rows.find((r) => r.table_name === "zz_task7_planted")!.uncovered_ops).toEqual(["DELETE"]);
    } finally {
      await client.query("rollback");
      client.release();
    }
  });

  it("DENOMINATOR, PLANTED: a table with NO client grant is outside the census, and arrives the moment one lands", async () => {
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query(
        `create table public.zz_task7_dormant (
           id uuid primary key default gen_random_uuid(),
           organisation_id uuid not null references public.organisations(id) on delete cascade)`,
      );
      await client.query(`alter table public.zz_task7_dormant enable row level security`);
      await client.query(`grant select on public.zz_task7_dormant to authenticated`);
      let rows = await coverage(client);
      expect(rows.some((r) => r.table_name === "zz_task7_dormant"), "SELECT-only: not in the denominator").toBe(false);
      await client.query(`grant update (organisation_id) on public.zz_task7_dormant to anon`);
      rows = await coverage(client);
      const arrived = rows.find((r) => r.table_name === "zz_task7_dormant");
      expect(arrived?.coverage, "an anon column grant puts it in, unaudited").toBe("unaudited");
      expect(arrived?.client_writes).toEqual(["UPDATE"]);
    } finally {
      await client.query("rollback");
      client.release();
    }
  });

  it("Q228: export_job_parts is outside the denominator, because no client role can write it (the census proves that, it does not assume it)", async () => {
    // The parts of a closure backup (20261101000000) are written by the export
    // runner alone, so the CRM write-audit question does not arise for them.
    // Two facts make that true, and both are measured: the census returns no
    // row for the table, and no client role holds any write privilege on it
    // at table OR column level (a column grant is the shape a table-level
    // check would miss). Its FK is to export_jobs, not organisations, so the
    // derivation's FK walk is a second reason it is absent; the grant check
    // is the one that would still hold if that walk ever widened.
    const rows = await coverage(pool);
    expect(rows.some((r) => r.table_name === "export_job_parts")).toBe(false);
    const { rows: held } = await pool.query<{ r: string; p: string }>(
      `select r, p
         from unnest(array['anon', 'authenticated']) r,
              unnest(array['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) p
        where has_table_privilege(r, 'public.export_job_parts', p)
           or (p in ('INSERT', 'UPDATE') and has_any_column_privilege(r, 'public.export_job_parts', p))
        order by r, p`,
    );
    expect(held, "a client role can write export_job_parts").toEqual([]);
    // DENOMINATOR: the probe sees a write grant when there is one.
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query("grant insert (part_no) on public.export_job_parts to authenticated");
      const { rows: lent } = await client.query<{ ok: boolean }>(
        `select has_any_column_privilege('authenticated', 'public.export_job_parts', 'INSERT') as ok`,
      );
      expect(lent[0]?.ok).toBe(true);
    } finally {
      await client.query("rollback");
      client.release();
    }
  });

  it("M2, PLANTED: the three shapes the first census could not see are each in the denominator and red", async () => {
    // Fix round 1. Each shape is planted in one rolled-back transaction and
    // must read `unaudited` BY NAME -- and each has a positive control, so the
    // red is the shape's and not the plant's.
    const client = await pool.connect();
    try {
      await client.query("begin");

      // (a) rpc_only with row security OFF: every policy carries the marker
      // term, so the first census called it rpc_only -- and no policy is
      // consulted at all.
      await client.query(
        `create table public.zz_task7_rpc (
           id uuid primary key default gen_random_uuid(),
           organisation_id uuid not null references public.organisations(id) on delete cascade,
           body text)`,
      );
      await client.query(`grant insert (organisation_id, body) on public.zz_task7_rpc to authenticated`);
      await client.query(
        `create policy zz_task7_rpc_insert on public.zz_task7_rpc for insert to authenticated
           with check (private.override_transition_in_progress())`,
      );
      await client.query(`alter table public.zz_task7_rpc enable row level security`);
      let rows = await coverage(client);
      expect(rows.find((r) => r.table_name === "zz_task7_rpc")?.coverage, "positive control: RLS on").toBe("rpc_only");
      await client.query(`alter table public.zz_task7_rpc disable row level security`);
      rows = await coverage(client);
      expect(rows.find((r) => r.table_name === "zz_task7_rpc")?.coverage, "RLS off ignores the policy").toBe("unaudited");

      // (b) an org path that is not a direct FK: an organisation_id column
      // with no foreign key at all.
      await client.query(
        `create table public.zz_task7_orgcol (
           id uuid primary key default gen_random_uuid(),
           organisation_id uuid not null,
           body text)`,
      );
      await client.query(`alter table public.zz_task7_orgcol enable row level security`);
      await client.query(`grant update (body) on public.zz_task7_orgcol to authenticated`);
      rows = await coverage(client);
      expect(rows.find((r) => r.table_name === "zz_task7_orgcol")?.coverage).toBe("unaudited");

      // (c) a client-writable auto-updatable view over a table no client can
      // write -- the base table is outside the denominator, the view is not.
      await client.query(
        `create table public.zz_task7_base (
           id uuid primary key default gen_random_uuid(),
           organisation_id uuid not null references public.organisations(id) on delete cascade,
           body text)`,
      );
      await client.query(`alter table public.zz_task7_base enable row level security`);
      await client.query(`create view public.zz_task7_view as select id, organisation_id, body from public.zz_task7_base`);
      rows = await coverage(client);
      expect(rows.some((r) => r.table_name === "zz_task7_view"), "positive control: no grant, not in").toBe(false);
      await client.query(`grant insert, update on public.zz_task7_view to authenticated`);
      rows = await coverage(client);
      const view = rows.find((r) => r.table_name === "zz_task7_view");
      expect(view?.coverage).toBe("unaudited");
      expect(view?.uncovered_ops).toEqual(["INSERT", "UPDATE"]);
      expect(rows.some((r) => r.table_name === "zz_task7_base"), "the base table still has no client grant").toBe(false);
    } finally {
      await client.query("rollback");
      client.release();
    }
  });

  it("the census function is reachable by no client role (it reads grants, not data, but it is not an RPC)", async () => {
    const { rows } = await pool.query<{ r: string; ok: boolean }>(
      `select r, has_function_privilege(r, 'private.audit_coverage()', 'execute') as ok
         from unnest(array['anon', 'authenticated', 'service_role']) r`,
    );
    for (const row of rows) expect(row.ok, row.r).toBe(false);
  });
});
