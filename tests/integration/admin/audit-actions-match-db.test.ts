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

/** The argument list that follows an open paren, split at depth 0. */
function splitArgs(tail: string): string[] {
  const args: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of tail) {
    if (ch === "(" || ch === "[") depth += 1;
    else if (ch === "]") depth -= 1;
    else if (ch === ")") {
      if (depth === 0) break;
      depth -= 1;
    }
    if (ch === "," && depth === 0) {
      args.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  args.push(current);
  return args;
}

describe("every literal action any database function writes is in the catalogue", () => {
  it("scans every public/private function body for log_audit_event(... p_action => '<name>' ...)", async () => {
    const { rows } = await pool.query<{ fqn: string; body: string }>(
      `select n.nspname || '.' || p.proname as fqn, pg_get_functiondef(p.oid) as body
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname in ('public', 'private') and p.prokind = 'f'
          and pg_get_functiondef(p.oid) ~ 'log_audit_event|log_organisation_lifecycle_event|log_override_event'`,
    );
    expect(rows.length).toBeGreaterThan(5);

    const known = new Set(knownAuditActions());
    const missing: string[] = [];
    // EVERY CALL SITE IS ACCOUNTED FOR, NOT JUST THE ONES SPELLED ONE WAY
    // (census audit, finding 12). This matched `p_action => '<name>'` and
    // nothing else, so a PERFECTLY LEGAL positional call --
    // `perform private.log_audit_event('org.suspended', 'organisation', ...)`
    // -- was invisible, and the enclosing `rows.length > 5` denominator did
    // not move, because the function still matches `log_audit_event` and still
    // appears in `rows`. All 33 call sites use named notation today by house
    // convention, asserted by nothing until now.
    //
    // The character class was also `[a-z_.]+`, which does not match a digit or
    // a capital: `gdpr.art17_erasure` failed the pattern entirely (the closing
    // quote does not follow `gdpr.art`) and was skipped in silence rather than
    // reported as unknown.
    //
    // So: every `log_audit_event` call site is found, its action resolved
    // named-or-positional, and any site whose action this cannot read is
    // reported as UNRESOLVED and has to be named in DYNAMIC_ACTION_SITES with
    // the reason. That is what makes this a census rather than a sample.
    const unresolved: string[] = [];
    for (const { fqn, body } of rows) {
      // Strip `--` comments so a name mentioned in prose does not count.
      const code = body.replace(/--[^\n]*/g, "");
      if (fqn === "private.log_audit_event") continue; // its own definition
      // THE TWO PARAMETERISED WRAPPERS ARE ENTRY POINTS TOO. A function that
      // calls `private.log_override_event('billing_override.granted', ...)`
      // does not name `log_audit_event` at all, so it was outside the row set
      // ENTIRELY -- not merely unmatched. Resolving one level of wrapper is
      // what makes the equality below a statement about every literal action
      // the schema writes.
      for (const call of code.matchAll(/(log_audit_event|log_organisation_lifecycle_event|log_override_event)\s*\(/g)) {
        const entry = call[1]!;
        // Skip the function's OWN `create function ...(` header.
        if (fqn.endsWith(`.${entry}`)) continue;
        const tail = code.slice(call.index! + call[0].length, call.index! + call[0].length + 400);
        const named = /p_action\s*=>\s*'([A-Za-z0-9_.]+)'\s*[,)]/.exec(tail.split(")")[0] ?? "");
        // Where p_action sits when the call is POSITIONAL, per entry point.
        const at = entry === "log_organisation_lifecycle_event" ? 1 : 0;
        const positional = /^'([A-Za-z0-9_.]+)'$/.exec((splitArgs(tail)[at] ?? "").trim());
        const action = named?.[1] ?? positional?.[1];
        if (action === undefined) {
          unresolved.push(`${fqn}: ${tail.slice(0, 60).replace(/\s+/g, " ").trim()}`);
        } else if (!known.has(action)) {
          missing.push(`${fqn}: ${action}`);
        }
      }
      // The document audit RPC validates p_action against a closed set
      // written as `p_action not in ('a', 'b', ...)`.
      const closed = code.match(/p_action\s+not\s+in\s*\(([^)]*)\)/);
      if (closed) {
        for (const m of closed[1].matchAll(/'([A-Za-z0-9_.]+)'/g)) {
          if (!known.has(m[1])) missing.push(`${fqn} (closed set): ${m[1]}`);
        }
      }
    }
    expect(missing).toEqual([]);

    // WHAT THE RESOLUTION DROPPED, PINNED. A call whose action is built at
    // runtime cannot be read out of the body, and dropping it silently is the
    // whole bug class: each one is named, with the reason its outcomes are
    // listed by hand instead.
    const DYNAMIC_ACTION_SITES: Record<string, string> = {
      "private.audit_crm_row":
        "the Phase 2 CRM audit trigger: p_action => tg_argv[0], so the name is the trigger's own " +
        "argument. Every such trigger is censused BY NAME in the trigger block above (22 pinned), " +
        "which is where those action names are actually checked.",
      "private.audit_crm_change":
        "the Phase 7 Task 6b CRM audit trigger: v_target || '.created' and v_action, both built from " +
        "the table name. The forty names they produce are pinned by crmAuditActions() and asserted " +
        "against the catalogue in the block above.",
      "private.audit_network_row":
        "the network audit trigger: v_action is built from TG_OP, and its outcomes are in the " +
        "catalogue under network_profile.* / network_connection_request.*.",
      "private.audit_dsr_transition":
        "'data_subject_request.' || new.status -- the status values are a CHECK constraint the state " +
        "machine owns, and each resulting name is in the catalogue.",
      "private.audit_incident_alert_resolution":
        "a `case` over new.resolved_at, producing incident_alert.resolved / .reopened, both listed.",
      "public.end_impersonation_session":
        "builds 'impersonation.' || v_status; both outcomes (.ended, .expired) are listed by hand " +
        "in the catalogue, and the prefix alone is not a name.",
      "private.audit_document_action":
        "p_action IS ITS OWN PARAMETER, reached from TypeScript rather than from SQL, and validated " +
        "against a closed `p_action not in (...)` set -- which the branch above reads and checks " +
        "name by name. That closed set is the census for this one.",
      "private.log_organisation_lifecycle_event":
        "a WRAPPER: it forwards its own p_action parameter. Its callers are resolved above, since " +
        "the row set now includes functions that name the wrapper rather than log_audit_event.",
      "private.log_override_event":
        "a WRAPPER, exactly as above.",
    };
    const unresolvedFns = [...new Set(unresolved.map((u) => u.split(":")[0]!))].sort();
    expect(
      unresolvedFns,
      "a function calls log_audit_event with an action this census cannot read out of the body. " +
        "Either write the action as a literal, or name the function in DYNAMIC_ACTION_SITES with " +
        "the reason its outcomes are pinned somewhere else. Sites: " + unresolved.join(" | "),
    ).toEqual(Object.keys(DYNAMIC_ACTION_SITES).sort());
  });

  it("POSITIVE CONTROL: the resolver reads a positional call and a name with a digit", () => {
    // Measured against the two shapes the old pattern could not see. Without
    // this the widening above is an untested claim.
    const read = (tail: string): string | undefined =>
      (/^\s*p_action\s*=>\s*'([A-Za-z0-9_.]+)'\s*[,)]/.exec(tail) ?? /^\s*'([A-Za-z0-9_.]+)'\s*[,)]/.exec(tail))?.[1];
    expect(read(`'org.suspended', 'organisation', v_id)`)).toBe("org.suspended");
    expect(read(`\n      p_action => 'gdpr.art17_erasure',`)).toBe("gdpr.art17_erasure");
    expect(read(`\n      p_action => tg_argv[0],`)).toBeUndefined();
    // ...and the OLD pattern misses both of the first two.
    const OLD = /p_action\s*=>\s*'([a-z_.]+)'\s*[,)]/;
    expect(OLD.test(`log_audit_event('org.suspended', 'organisation', v_id)`)).toBe(false);
    expect(OLD.test(`log_audit_event(p_action => 'gdpr.art17_erasure',`)).toBe(false);
  });
});

// ===========================================================================
// THE THIRD WAY AN ACTION NAME REACHES THE TABLE, AND IT WAS INVISIBLE UNTIL
// PHASE 8 TASK 5 NEEDED IT.
// ===========================================================================
// Everything above reads `private.log_audit_event(...)` and its two wrappers.
// That function REQUIRES `auth.uid()` -- it raises 28000 without one -- so a
// sessionless writer cannot use it at all, and Task 5 has two: the erasure
// job's request trigger (a workspace purge is started by the platform) and
// the erasure summary itself (by the time it is written, the person who asked
// does not exist). Both INSERT into public.audit_events directly, with the
// Q130 tombstone as the actor.
//
// A direct insert was outside every census in this file. Its action name
// could be renamed, mistyped or added without the operator's filter ever
// learning it existed -- the "a check that cannot see its own subject" class,
// on the exact surface this file is about. So: find every function that
// inserts into public.audit_events directly, read the literal it puts in the
// `action` column, and require it to be in the catalogue.
describe("every literal action a function INSERTS into audit_events directly is in the catalogue", () => {
  it("finds the direct writers and reads their action names", async () => {
    const { rows } = await pool.query<{ fqn: string; body: string }>(
      `select n.nspname || '.' || p.proname as fqn, pg_get_functiondef(p.oid) as body
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname in ('public', 'private') and p.prokind = 'f'
          -- POSIX CHARACTER CLASSES, NOT BACKSLASH ESCAPES, AND THAT IS NOT
          -- A STYLE CHOICE. This query is a JS template literal, in which a
          -- lone backslash-s is not a recognised escape and is silently
          -- DROPPED to a bare s -- so the pattern that reached Postgres read
          -- insertss+intoss+public... and matched nothing at all. Measured on
          -- this census's first run against a real database: it returned an
          -- EMPTY row set, and the DENOMINATOR assertion below is the only
          -- reason that was a red test rather than a green census of nothing.
          -- [[:space:]] carries no backslash and therefore cannot be eaten.
          and pg_get_functiondef(p.oid) ~* 'insert[[:space:]]+into[[:space:]]+public[.]audit_events'`,
    );

    // DENOMINATOR. private.log_audit_event itself, plus the two Task 5
    // writers. Fewer than three means this stopped finding them -- which is
    // how a census of this shape goes quietly green.
    expect(
      rows.map((r) => r.fqn).sort(),
      "the direct-insert census lost a writer it used to see",
    ).toEqual(
      ["private.audit_erasure_job_requested", "private.erase_account", "private.log_audit_event"],
    );

    const known = new Set(knownAuditActions());
    const found: string[] = [];
    const missing: string[] = [];
    for (const { fqn, body } of rows) {
      if (fqn === "private.log_audit_event") continue; // forwards its parameter
      const code = body.replace(/--[^\n]*/g, "");
      // SCOPED TO THE INSERT STATEMENT ITSELF, from the keyword to that
      // statement's terminating semicolon -- not the whole function body.
      // private.erase_account() is full of dotted literals that are jsonb
      // COUNT KEYS ('notes.private_deleted', 'merges.owner_snapshots'), and a
      // whole-body scan would report every one of them as an unknown audit
      // action. Inside the statement, the action is the one dotted literal:
      // 'erasure_job' (the target type) and 'account' (a kind) carry no dot.
      for (const at of code.matchAll(/insert\s+into\s+public\.audit_events/gi)) {
        const from = at.index ?? 0;
        const end = code.indexOf(";", from);
        const statement = code.slice(from, end === -1 ? code.length : end);
        for (const m of statement.matchAll(/'([A-Za-z0-9_]+\.[A-Za-z0-9_.]+)'/g)) {
          found.push(`${fqn}: ${m[1]}`);
          if (!known.has(m[1])) missing.push(`${fqn}: ${m[1]}`);
        }
      }
    }
    // POSITIVE CONTROL: the reader found something. Without this, a regex
    // that matched nothing would satisfy `missing` perfectly.
    expect(found.length, "no action name was read out of any direct writer").toBeGreaterThan(1);
    expect(missing).toEqual([]);
  });
});
