// THE AUDIT ACTION CATALOGUE IS WRITTEN IN TWO LANGUAGES, AND THIS BINDS THEM.
//
// lib/admin/audit-actions.ts derives the CRM half of the catalogue from a
// target list and a verb set, and lists the platform half by hand. The
// database is the truth on both counts: the triggers 20260912000000 attached
// carry the target type as their one argument, the deleted_at column decides
// which targets can soft-delete, and every literal action name any function
// passes to private.log_audit_event() is in its body. This file reads all
// three out of the LIVE catalogue (pg_trigger, information_schema,
// pg_get_functiondef) rather than the migration text, because a later
// migration can replace any of them and what is deployed is what decides.
//
// WHAT DRIFT COSTS, in each direction:
//   a name in the database and not in the catalogue   the founder's action
//                                                       filter cannot suggest
//                                                       it -- "an action the
//                                                       viewer cannot filter is
//                                                       an action the founder
//                                                       cannot find" (Task 6b
//                                                       brief, requirement 4)
//   a name in the catalogue and not in the database    the datalist offers a
//                                                       filter that can never
//                                                       match a row
import { afterAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { getLocalSupabaseStatus } from "../rls/support/env";
import {
  CRM_AUDIT_TARGETS,
  CRM_AUDIT_TARGET_TABLE,
  CRM_AUDIT_VERBS,
  crmAuditActions,
  knownAuditActions,
} from "@/lib/admin/audit-actions";

const pool = new Pool({ connectionString: getLocalSupabaseStatus().dbUrl });

afterAll(async () => {
  await pool.end();
});

describe("the CRM audit triggers agree with CRM_AUDIT_TARGETS", () => {
  it("finds the trigger function at all, so this suite cannot pass vacuously", async () => {
    const { rows } = await pool.query<{ n: string }>(
      `select count(*)::text as n from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'private' and p.proname = 'audit_crm_change'`,
    );
    expect(rows[0].n).toBe("1");
  });

  it("every table with an audit_insert/audit_update pair is in the catalogue, under the trigger's own target argument", async () => {
    // tgargs is a NUL-separated bytea; one argument here, the target type.
    const { rows } = await pool.query<{ table_name: string; target: string; tgname: string }>(
      `select c.relname as table_name, t.tgname,
              encode(t.tgargs, 'escape') as target
         from pg_trigger t
         join pg_class c on c.oid = t.tgrelid
         join pg_proc p on p.oid = t.tgfoid
         join pg_namespace n on n.oid = p.pronamespace
        where c.relnamespace = 'public'::regnamespace
          and not t.tgisinternal
          and n.nspname = 'private' and p.proname = 'audit_crm_change'
        order by 1, 2`,
    );
    expect(rows.length).toBe(22);

    const byTable = new Map<string, { target: string; triggers: string[] }>();
    for (const r of rows) {
      // encode(..., 'escape') renders the argument's NUL terminator as the
      // four characters `\000`; strip either spelling.
      const target = r.target.replace(/(\\000|\0)+$/, "");
      const cur = byTable.get(r.table_name) ?? { target, triggers: [] };
      expect(cur.target, `${r.table_name}: both triggers name the same target`).toBe(target);
      cur.triggers.push(r.tgname);
      byTable.set(r.table_name, cur);
    }

    const catalogueTables = Object.entries(CRM_AUDIT_TARGET_TABLE)
      .map(([target, table]) => ({ target, table }))
      .sort((a, b) => a.table.localeCompare(b.table));
    expect([...byTable.keys()].sort()).toEqual(catalogueTables.map((c) => c.table).sort());
    for (const { target, table } of catalogueTables) {
      expect(byTable.get(table)?.target, `${table}'s trigger argument`).toBe(target);
      expect(byTable.get(table)?.triggers.sort()).toEqual(["audit_insert", "audit_update"]);
    }
  });

  it("softDeletable agrees with which tables carry a deleted_at column", async () => {
    const { rows } = await pool.query<{ table_name: string }>(
      `select table_name from information_schema.columns
        where table_schema = 'public' and column_name = 'deleted_at'`,
    );
    const withDeletedAt = new Set(rows.map((r) => r.table_name));
    for (const [target, { softDeletable }] of Object.entries(CRM_AUDIT_TARGETS)) {
      const table = CRM_AUDIT_TARGET_TABLE[target as keyof typeof CRM_AUDIT_TARGET_TABLE];
      expect(withDeletedAt.has(table), `${table}.deleted_at exists`).toBe(softDeletable);
    }
  });

  it("the allowlist function names a value-column set for every catalogue target and {} for an unknown one", async () => {
    for (const target of Object.keys(CRM_AUDIT_TARGETS)) {
      const { rows } = await pool.query<{ n: number }>(
        `select cardinality(private.audit_crm_value_columns($1)) as n`,
        [target],
      );
      expect(rows[0].n, `${target} has an allowlist`).toBeGreaterThan(0);
    }
    const { rows } = await pool.query<{ n: number }>(
      `select cardinality(private.audit_crm_value_columns($1)) as n`,
      ["a_table_that_does_not_exist"],
    );
    expect(rows[0].n).toBe(0);
  });

  // FIX ROUND 1, REVIEW M3: the two halves of the catalogue that were bound
  // to NOTHING. The test below pins the TARGETS (from tgargs) and the one
  // further down pins every COMPLETE `p_action => '<literal>'`; neither could
  // see the verbs, which audit_crm_change() builds as `v_target || '.updated'`,
  // nor the action names audit_crm_row() takes from tg_argv[0]. A verb rename,
  // or a new `audit_crm_row('event.hard_deleted', 'event')` trigger, left the
  // datalist stale with this file green.
  it("the verbs audit_crm_change() builds its action names from are exactly CRM_AUDIT_VERBS", async () => {
    const { rows } = await pool.query<{ body: string }>(
      `select pg_get_functiondef(p.oid) as body
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'private' and p.proname = 'audit_crm_change'`,
    );
    expect(rows.length).toBe(1);
    // The function's only dotted string literals ARE its verbs: it emits
    // `v_target || '.created'` and a CASE over '.soft_deleted' / '.restored' /
    // '.updated'. Comments stripped so a verb named in prose does not count.
    const code = rows[0].body.replace(/--[^\n]*/g, "");
    const verbs = [...new Set([...code.matchAll(/'\.([a-z_]+)'/g)].map((m) => m[1]))];
    expect(verbs.sort()).toEqual([...CRM_AUDIT_VERBS].sort());
  });

  it("every action name an audit_crm_row trigger passes through tg_argv is in the catalogue", async () => {
    const { rows } = await pool.query<{ table_name: string; tgname: string; args: string }>(
      `select c.relname as table_name, t.tgname, encode(t.tgargs, 'escape') as args
         from pg_trigger t
         join pg_class c on c.oid = t.tgrelid
         join pg_proc p on p.oid = t.tgfoid
         join pg_namespace n on n.oid = p.pronamespace
        where c.relnamespace = 'public'::regnamespace
          and not t.tgisinternal
          and n.nspname = 'private' and p.proname = 'audit_crm_row'
        order by 1, 2`,
    );
    // contact_company.deleted, custom_field_value.deleted, records.merged
    // (20260828141000) -- fewer than three means this stopped finding them.
    expect(rows.length).toBeGreaterThanOrEqual(3);

    const known = new Set(knownAuditActions());
    const missing = rows
      // Two NUL-separated arguments, the action first. encode(..., 'escape')
      // renders a NUL as the four characters `\000`.
      .map((r) => ({ ...r, action: r.args.split(/\\000|\0/)[0] }))
      .filter((r) => !known.has(r.action))
      .map((r) => `${r.table_name}.${r.tgname}: ${r.action}`);
    expect(missing).toEqual([]);
  });

  it("the derived CRM action set is exactly what the trigger can emit", () => {
    // 9 soft-deletable x 4 verbs + 2 x 2 verbs. The verbs themselves are
    // pinned by rls_phase7_crm_audit.sql § CI/CU/CD against real writes; this
    // is the count that the two facts above imply.
    expect(crmAuditActions()).toHaveLength(40);
  });
});

describe("every literal action any database function writes is in the catalogue", () => {
  it("scans every public/private function body for log_audit_event(... p_action => '<name>' ...)", async () => {
    const { rows } = await pool.query<{ fqn: string; body: string }>(
      `select n.nspname || '.' || p.proname as fqn, pg_get_functiondef(p.oid) as body
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname in ('public', 'private') and p.prokind = 'f'
          and pg_get_functiondef(p.oid) ~ 'log_audit_event'`,
    );
    expect(rows.length).toBeGreaterThan(5);

    const known = new Set(knownAuditActions());
    const missing: string[] = [];
    for (const { fqn, body } of rows) {
      // Strip `--` comments so a name mentioned in prose does not count.
      const code = body.replace(/--[^\n]*/g, "");
      // A COMPLETE literal only: `p_action => 'x.y',` or `... 'x.y')`.
      // public.end_impersonation_session builds its name as
      // `'impersonation.' || case ... end`, and both of its outcomes
      // (.ended/.expired) are listed by hand; the prefix alone is not a name.
      for (const m of code.matchAll(/p_action\s*=>\s*'([a-z_.]+)'\s*[,)]/g)) {
        if (!known.has(m[1])) missing.push(`${fqn}: ${m[1]}`);
      }
      // The document audit RPC validates p_action against a closed set
      // written as `p_action not in ('a', 'b', ...)`.
      const closed = code.match(/p_action\s+not\s+in\s*\(([^)]*)\)/);
      if (closed) {
        for (const m of closed[1].matchAll(/'([a-z_.]+)'/g)) {
          if (!known.has(m[1])) missing.push(`${fqn} (closed set): ${m[1]}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });
});
