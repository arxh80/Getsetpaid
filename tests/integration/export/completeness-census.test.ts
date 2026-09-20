// THE EXPORT COMPLETENESS CENSUS.
//
// "Completeness is a census, not a promise" (Phase 8 Task 4 brief § 3). The
// denominator is derived from the LIVE catalogue — every table in `public`
// with a foreign key to `public.organisations` (plus `organisations` itself)
// for the workspace export, and every table with a foreign key to
// `auth.users` for the account one — and `private.export_catalogue()` must
// name every one of them, exactly once, as `exported` or `excused`.
//
// ===========================================================================
// WHY A FOREIGN-KEY WALK AND NOT A COLUMN-NAME MATCH
// ===========================================================================
// FOUR of the organisation paths in this schema are not called
// `organisation_id`: `data_subject_requests.routed_to_organisation_id`,
// `impersonation_sessions.target_organisation_id` and
// `network_connection_requests.from_organisation_id` /
// `to_organisation_id`. A census keyed on the name would have dropped all
// four SILENTLY — a census that cannot see its own subject, which is the
// failure this phase has now shipped twice (Task 3's `"use server"` regex
// that required the directive's semicolon).
//
// THE MUTATIONS THIS FILE IS BUILT TO SURVIVE are therefore both directions:
//   * a table ARRIVING (a later phase adds one) — the planted-table proofs
//     below create a real table with a real foreign key inside a rolled-back
//     transaction and assert the census sees it;
//   * a table LEAVING (the derivation stops matching a shape it used to) —
//     the second planted table names its foreign-key column something else
//     entirely, which is exactly what a name-keyed census would miss, and the
//     membership rolls and counts below are PINNED so a shrinking denominator
//     is red rather than quietly green.

import { afterAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { getLocalSupabaseStatus } from "../rls/support/env";

const pool = new Pool({ connectionString: getLocalSupabaseStatus().dbUrl, max: 2 });

afterAll(async () => {
  await pool.end();
});

/**
 * The denominator, straight out of pg_constraint. `organisations` itself is
 * unioned in: it is the workspace, and it has no foreign key to itself.
 */
const ORGANISATION_TABLES_SQL = `
  select distinct c.relname as tbl
    from pg_constraint k
    join pg_class c on c.oid = k.conrelid
    join pg_namespace n on n.oid = c.relnamespace
    join pg_class tc on tc.oid = k.confrelid
    join pg_namespace tn on tn.oid = tc.relnamespace
   where k.contype = 'f' and n.nspname = 'public'
     and tn.nspname = 'public' and tc.relname = 'organisations'
  union
  select 'organisations'`;

const USER_TABLES_SQL = `
  select distinct c.relname as tbl
    from pg_constraint k
    join pg_class c on c.oid = k.conrelid
    join pg_namespace n on n.oid = c.relnamespace
    join pg_class tc on tc.oid = k.confrelid
    join pg_namespace tn on tn.oid = tc.relnamespace
   where k.contype = 'f' and n.nspname = 'public'
     and tn.nspname = 'auth' and tc.relname = 'users'`;

async function derived(sql: string): Promise<string[]> {
  const { rows } = await pool.query<{ tbl: string }>(sql);
  return rows.map((r) => r.tbl).sort();
}

async function catalogued(kind: "workspace" | "account"): Promise<string[]> {
  const { rows } = await pool.query<{ table_name: string }>(
    "select table_name from private.export_catalogue() where export_kind = $1 order by table_name",
    [kind],
  );
  return rows.map((r) => r.table_name);
}

// ===========================================================================
// THE PINNED ROLLS. Not decoration: without them a derivation that stopped
// matching a shape would agree with a catalogue that had stopped listing it,
// and both halves would shrink together in silence.
// ===========================================================================

const WORKSPACE_EXPORTED = [
  "agencies",
  "artist_fee_history",
  "artist_representations",
  "artists",
  "companies",
  "contact_companies",
  "contacts",
  "custom_field_definitions",
  "custom_field_values",
  "document_links",
  "document_versions",
  "documents",
  "event_lineup",
  "event_status_changes",
  "events",
  "financial_entries",
  "impersonation_sessions",
  "meeting_links",
  "meetings",
  "merge_candidates",
  "merges",
  "network_connection_requests",
  "network_links",
  "network_profiles",
  "note_links",
  "notes",
  "organisation_billing_overrides",
  "organisation_feature_overrides",
  "organisation_memberships",
  "organisation_subscriptions",
  "organisations",
  "task_links",
  "tasks",
  "venue_rooms",
  "venues",
];

const WORKSPACE_EXCUSED = [
  "audit_events",
  "data_subject_requests",
  "export_jobs",
  "feedback",
  "incident_alerts",
];

const ACCOUNT_EXPORTED = [
  "audit_events",
  "consents",
  "data_subject_requests",
  "feedback",
  "impersonation_sessions",
  "organisation_memberships",
  "platform_admins",
  "profiles",
];

/** The four reads that cannot run under the requester's own RLS, and why. */
const ACCOUNT_ELEVATED = [
  "audit_events",
  "feedback",
  "impersonation_sessions",
  "platform_admins",
];

describe("the export catalogue is sound", () => {
  it("answers `sound` against the live schema", async () => {
    const { rows } = await pool.query<{ sound: string }>(
      "select private.export_catalogue_is_sound() as sound",
    );
    expect(rows[0]?.sound).toBe("sound");
  });
});

describe("every organisation-scoped table is exported or excused", () => {
  it("the catalogue equals the foreign-key walk, both directions", async () => {
    const want = await derived(ORGANISATION_TABLES_SQL);
    const have = await catalogued("workspace");

    const missing = want.filter((t) => !have.includes(t));
    const extra = have.filter((t) => !want.includes(t));
    expect(
      missing,
      "these tables have a row -> organisation path and are in neither disposition of private.export_catalogue(). Add each as `exported` with its scope column, or as `excused` with a reason.",
    ).toEqual([]);
    expect(
      extra,
      "these tables are in the workspace export catalogue and have no foreign key to public.organisations any more",
    ).toEqual([]);
  });

  it("DENOMINATOR: the derivation is not empty and is the size it was", async () => {
    const want = await derived(ORGANISATION_TABLES_SQL);
    expect(want.length).toBe(WORKSPACE_EXPORTED.length + WORKSPACE_EXCUSED.length);
    // The four paths a name-keyed census would have missed, named so that
    // losing one is a red test rather than a smaller number.
    for (const table of [
      "data_subject_requests",
      "impersonation_sessions",
      "network_connection_requests",
    ]) {
      expect(want, `${table} reaches an organisation through a column that is NOT called organisation_id`).toContain(table);
    }
  });

  it("the exported and excused rolls are exactly these", async () => {
    const { rows } = await pool.query<{ table_name: string; disposition: string }>(
      "select table_name, disposition from private.export_catalogue() where export_kind = 'workspace' order by table_name",
    );
    expect(rows.filter((r) => r.disposition === "exported").map((r) => r.table_name)).toEqual(
      WORKSPACE_EXPORTED,
    );
    expect(rows.filter((r) => r.disposition === "excused").map((r) => r.table_name)).toEqual(
      WORKSPACE_EXCUSED,
    );
  });

  it("every excused table says why, in more than a word", async () => {
    const { rows } = await pool.query<{ table_name: string; reason: string | null }>(
      "select table_name, reason from private.export_catalogue() where disposition = 'excused'",
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect((row.reason ?? "").length, `${row.table_name} is excused with no real reason`)
        .toBeGreaterThan(60);
    }
  });
});

describe("every user-scoped table is exported or excused", () => {
  it("the catalogue equals the foreign-key walk, both directions", async () => {
    const want = await derived(USER_TABLES_SQL);
    const have = await catalogued("account");

    expect(
      want.filter((t) => !have.includes(t)),
      "these tables have a row -> user path and are in neither disposition of private.export_catalogue()",
    ).toEqual([]);
    expect(
      have.filter((t) => !want.includes(t)),
      "these tables are in the account export catalogue and have no foreign key to auth.users any more",
    ).toEqual([]);
  });

  it("the exported roll is exactly these", async () => {
    const { rows } = await pool.query<{ table_name: string }>(
      "select table_name from private.export_catalogue() where export_kind = 'account' and disposition = 'exported' order by table_name",
    );
    expect(rows.map((r) => r.table_name)).toEqual(ACCOUNT_EXPORTED);
  });

  it("exactly four account tables are read with elevated rights, and each has a reason", async () => {
    const { rows } = await pool.query<{ table_name: string; reason: string | null; projection: string[] | null }>(
      "select table_name, reason, projection from private.export_catalogue() where authorisation = 'elevated' order by table_name",
    );
    expect(rows.map((r) => r.table_name)).toEqual(ACCOUNT_ELEVATED);
    for (const row of rows) {
      expect((row.reason ?? "").length, `${row.table_name} is elevated with no reason`).toBeGreaterThan(
        80,
      );
    }
    // The two that hold more than the requester's own data must be PROJECTED.
    const byName = new Map(rows.map((r) => [r.table_name, r]));
    expect(byName.get("audit_events")?.projection).not.toBeNull();
    expect(byName.get("audit_events")?.projection).not.toContain("before");
    expect(byName.get("audit_events")?.projection).not.toContain("after");
    expect(byName.get("feedback")?.projection).not.toBeNull();
    expect(byName.get("feedback")?.projection).not.toContain("screenshot_key");
  });

  it("no workspace export table is read with elevated rights", async () => {
    const { rows } = await pool.query(
      "select table_name from private.export_catalogue() where export_kind = 'workspace' and authorisation = 'elevated'",
    );
    expect(rows).toEqual([]);
  });
});

// ===========================================================================
// PROVING THE DENOMINATOR: the census can see a table it has never been told
// about. Both plants run inside a transaction that is ROLLED BACK, so the
// schema is unchanged afterwards.
// ===========================================================================

describe("the census sees a table nobody has told it about", () => {
  it("a new organisation-scoped table lands in the derivation and NOT in the catalogue", async () => {
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query(`
        create table public.census_probe_org (
          id uuid primary key default gen_random_uuid(),
          organisation_id uuid not null references public.organisations (id)
        )`);
      const { rows } = await client.query<{ tbl: string }>(ORGANISATION_TABLES_SQL);
      const derivedNow = rows.map((r) => r.tbl);
      expect(derivedNow, "the planted table is invisible to the derivation").toContain(
        "census_probe_org",
      );

      const { rows: cat } = await client.query<{ table_name: string }>(
        "select table_name from private.export_catalogue() where export_kind = 'workspace'",
      );
      expect(cat.map((r) => r.table_name)).not.toContain("census_probe_org");
      // Which is exactly the state the real assertion above calls a failure.
      expect(
        derivedNow.filter((t) => !cat.map((r) => r.table_name).includes(t)),
      ).toEqual(["census_probe_org"]);
    } finally {
      await client.query("rollback");
      client.release();
    }
  });

  it("a table whose organisation column is NOT called organisation_id is seen too", async () => {
    // This is the mutation that makes a table LEAVE a name-keyed census. The
    // schema already contains four such tables; this proves the derivation
    // finds one it has never seen, by the foreign key alone.
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query(`
        create table public.census_probe_odd (
          id uuid primary key default gen_random_uuid(),
          owning_workspace uuid not null references public.organisations (id)
        )`);
      const { rows } = await client.query<{ tbl: string }>(ORGANISATION_TABLES_SQL);
      expect(
        rows.map((r) => r.tbl),
        "a census keyed on the COLUMN NAME would have missed this table entirely",
      ).toContain("census_probe_odd");
    } finally {
      await client.query("rollback");
      client.release();
    }
  });

  it("a new user-scoped table lands in the user derivation", async () => {
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query(`
        create table public.census_probe_user (
          id uuid primary key default gen_random_uuid(),
          touched_by uuid not null references auth.users (id)
        )`);
      const { rows } = await client.query<{ tbl: string }>(USER_TABLES_SQL);
      expect(rows.map((r) => r.tbl)).toContain("census_probe_user");
    } finally {
      await client.query("rollback");
      client.release();
    }
  });

  it("the probe tables are gone afterwards", async () => {
    const { rows } = await pool.query<{ relname: string }>(
      "select relname from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and relname like 'census_probe_%'",
    );
    expect(rows).toEqual([]);
  });
});
