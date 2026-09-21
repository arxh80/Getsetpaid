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
import { REMAINDER_WITHHELD } from "@/lib/export/contract";

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

/**
 * THE REMAINDER: every `public` BASE TABLE in NEITHER derivation.
 *
 * ===========================================================================
 * WHY A FOREIGN-KEY WALK NEEDS ONE (Task 4 review, finding I2)
 * ===========================================================================
 * The two walks above are strictly stronger than a column-name match against
 * a RENAMED column, and strictly WEAKER against a MISSING CONSTRAINT — and
 * that case is live rather than hypothetical. `public.rate_limit_counters`
 * carries `subject_id`, which is a user id OR an organisation id chosen by
 * `subject_scope`, with no foreign key on it. It therefore has a genuine
 * row -> organisation path and a genuine row -> user path, and BOTH walks are
 * blind to it: it is neither exported nor excused, simply unseen, and the
 * census was green.
 *
 * Nothing leaks — rate-limit internals must never be exported — but the
 * GUARANTEE was holed, which is what a census is for. So the unexamined
 * residue becomes a DISPOSITION: the six tables in neither derivation are
 * pinned by name with a reason each, and a seventh arrives as a red test
 * naming itself.
 *
 * These are NOT catalogue rows. A table with no foreign key cannot be added
 * to private.export_catalogue() without the both-directions assertions above
 * reporting it as `extra` — the catalogue's subject is the derivation, and
 * this roll is the complement of it.
 */
const NEITHER_DERIVATION: Readonly<Record<string, string>> = {
  // ---- PLATFORM REFERENCE DATA. Seeded by migration, identical in every
  // ---- deployment, about nobody. Exporting it would be exporting the
  // ---- product's own configuration to a customer.
  permissions:
    "The permission-key catalogue. Seeded by migration, the same rows in every deployment, about no person and no workspace.",
  roles:
    "The role catalogue. Seeded by migration, the same rows in every deployment.",
  role_permissions:
    "Which role holds which permission key. Seeded by migration; the product's own policy, not a customer record.",
  subscription_plans:
    "The tier catalogue (Free / Starter / Pro) and what each one entitles. Seeded by migration; price-list data.",
  rate_limit_policies:
    "The rate-limit budgets from SECURITY.md section 5, seeded by migration. Platform configuration.",

  // ---- THE ONE THAT IS NOT REFERENCE DATA, and the reason this roll exists.
  rate_limit_counters:
    "SUBJECT-SCOPED AND NOT DERIVABLE. `subject_id` is a user id OR an organisation id, chosen by `subject_scope`, with no foreign key on it — so it has a real row -> organisation path and a real row -> user path and the foreign-key walks cannot see either. It is EXCUSED, deliberately and permanently: the Task 4 brief names rate-limit internals among the things an export may never contain, the row is GetSetPaid's own enforcement state rather than the subject's data, and a counter naming a user id would put one person's throttling history into another's archive whenever the scope is `organisation`. Listed here rather than in the catalogue because a table with no foreign key cannot be catalogued without the both-directions assertions reporting it as `extra`.",
};

async function neitherDerivation(): Promise<string[]> {
  const { rows } = await pool.query<{ tbl: string }>(
    `select c.relname as tbl
       from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind in ('r', 'p')
        and c.relname not in (${ORGANISATION_TABLES_SQL})
        and c.relname not in (${USER_TABLES_SQL})
      order by c.relname`,
  );
  return rows.map((r) => r.tbl);
}

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
  // Phase 8 Task 5. The erasure register: a workspace appears on it only as
  // the subject of its own 60-day purge, which is the platform's operational
  // state rather than one of the business's records.
  "erasure_jobs",
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

/**
 * THE ACCOUNT HALF'S OTHER ROLL, and the whole of Task 4 review finding I1.
 *
 * The workspace half pinned both rolls and a denominator; the account half
 * pinned `ACCOUNT_EXPORTED` and `ACCOUNT_ELEVATED` and NOTHING ELSE. So a
 * table that left the derivation AND left the catalogue together — which is
 * what a later phase dropping a table, or a migration dropping the foreign
 * key that made it visible, produces — was invisible. Measured by the
 * reviewer: dropping `legal_documents`' three foreign keys to `auth.users`
 * and deleting its catalogue row gave **13 passed, 0 failed**, while the same
 * shape on the workspace half reddened 2.
 *
 * An absence satisfied by the denominator shrinking is the one failure shape
 * this whole file was written against, and it was still in it.
 */
const ACCOUNT_EXCUSED = [
  "agencies",
  "artists",
  "companies",
  "contacts",
  "data_subject_request_notes",
  "documents",
  // Phase 8 Task 5. Unreachable in practice -- a SUCCEEDED account erasure
  // has already deleted the account that would export it -- and what is left
  // (a queued or failed job) is on /account/erase, live.
  "erasure_jobs",
  "event_status_changes",
  "events",
  "export_jobs",
  "financial_entries",
  "incident_alerts",
  "legal_documents",
  "meetings",
  "merge_candidates",
  "merges",
  "network_connection_requests",
  "network_links",
  "network_profiles",
  "notes",
  "organisation_billing_overrides",
  "organisation_feature_overrides",
  "tasks",
  "venues",
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

  it("DENOMINATOR: the derivation is not empty and is the size it was", async () => {
    // THE ASSERTION THE ACCOUNT HALF DID NOT HAVE (review finding I1). Its
    // twin on the workspace half is 40 lines above; without it a table
    // leaving the derivation and the catalogue together is silently green,
    // which was measured at 0 of 13.
    const want = await derived(USER_TABLES_SQL);
    expect(want.length).toBe(ACCOUNT_EXPORTED.length + ACCOUNT_EXCUSED.length);
    expect(want.length).toBeGreaterThan(0);
  });

  it("the exported and excused rolls are exactly these", async () => {
    const { rows } = await pool.query<{ table_name: string; disposition: string }>(
      "select table_name, disposition from private.export_catalogue() where export_kind = 'account' order by table_name",
    );
    expect(rows.filter((r) => r.disposition === "exported").map((r) => r.table_name)).toEqual(
      ACCOUNT_EXPORTED,
    );
    expect(rows.filter((r) => r.disposition === "excused").map((r) => r.table_name)).toEqual(
      ACCOUNT_EXCUSED,
    );
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
    // EVERY elevated row is PROJECTED, not just the two whose withholdings
    // are named below (review finding M2). The catalogue's rule was prose in
    // three places and machinery in none, and impersonation_sessions shipped
    // with a null projection — `select *` — handing the requester the
    // operator's break-glass reason and a staff user id. The rule now lives
    // in private.export_catalogue_is_sound() as well as here.
    for (const row of rows) {
      expect(row.projection, `${row.table_name} is elevated with no projection`).not.toBeNull();
      expect((row.projection ?? []).length, row.table_name).toBeGreaterThan(0);
    }
    const byName = new Map(rows.map((r) => [r.table_name, r]));
    expect(byName.get("audit_events")?.projection).not.toContain("before");
    expect(byName.get("audit_events")?.projection).not.toContain("after");
    expect(byName.get("feedback")?.projection).not.toContain("screenshot_key");
    // Q167: the operator's own words and the operator's own identity are not
    // the requester's data. The columns describing THEIR decision are.
    expect(byName.get("impersonation_sessions")?.projection).not.toContain("reason");
    expect(byName.get("impersonation_sessions")?.projection).not.toContain("superuser_user_id");
    expect(byName.get("impersonation_sessions")?.projection).toContain("admin_accepted_by");
    expect(byName.get("impersonation_sessions")?.projection).toContain("declined_at");
  });

  it("no workspace export table is read with elevated rights", async () => {
    const { rows } = await pool.query(
      "select table_name from private.export_catalogue() where export_kind = 'workspace' and authorisation = 'elevated'",
    );
    expect(rows).toEqual([]);
  });
});

describe("the tables in NEITHER derivation are a disposition, not a residue", () => {
  it("the remainder is exactly the pinned roll, and each one says why", async () => {
    const remainder = await neitherDerivation();
    expect(
      remainder,
      "a public base table is in neither foreign-key derivation. If it holds nothing about a person or a workspace, add it to NEITHER_DERIVATION with a reason. If it does — a subject id with no foreign key, a polymorphic entity id — then the census cannot see it and it needs a disposition, not a comment.",
    ).toEqual(Object.keys(NEITHER_DERIVATION).sort());
    for (const [table, reason] of Object.entries(NEITHER_DERIVATION)) {
      expect(reason.length, `${table} is in neither derivation with no real reason`).toBeGreaterThan(60);
    }
  });

  it("DENOMINATOR: the remainder query really is looking at the whole schema", async () => {
    // RR5 (Task 4 scoped re-review). The middle assertion here USED to be
    // `remainder === all − |org ∪ user|`, and its comment claimed it would
    // catch "a typo in the relkind, a schema rename". It would not:
    // `neitherDerivation()` IS `allBaseTables` minus those same two
    // subqueries, written with the same two SQL constants, so the equality
    // held by construction for any value of the constants, INCLUDING a broken
    // one. A typo in the relkind changes both sides together, which is the
    // exact failure shape this file is named against.
    //
    // It is a LITERAL COUNT now: 51 base tables in `public` at 163 migrations,
    // measured. A relkind typo takes it to 0 and this reds; a new table takes
    // it to 52 and this reds, which is correct -- a new table needs a
    // disposition, and the rolls below are where it gets one.
    const { rows } = await pool.query<{ n: string }>(
      "select count(*)::text as n from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind in ('r', 'p')",
    );
    const all = Number(rows[0]?.n ?? 0);
    const org = (await derived(ORGANISATION_TABLES_SQL)).length;
    const user = (await derived(USER_TABLES_SQL)).length;
    const remainder = (await neitherDerivation()).length;
    expect(
      all,
      "the number of base tables in `public` has changed. If you ADDED one it needs a disposition " +
        "in the catalogue or in NEITHER_DERIVATION (the rolls above will say which). If this is 0, " +
        "the relkind or the schema name in this query is wrong and every 'is in neither derivation' " +
        "assertion in this file has been answered by an empty set.",
    ).toBe(51);
    // Kept, and no longer pretending to be the load-bearing one: the two
    // derivations overlap (a table can have both paths), so the remainder is
    // the complement by construction. What makes it worth a line is that it
    // fails LOUDLY if `neitherDerivation()` and the count above ever stop
    // being written over the same relkinds.
    expect(remainder).toBe(all - new Set([
      ...(await derived(ORGANISATION_TABLES_SQL)),
      ...(await derived(USER_TABLES_SQL)),
    ]).size);
    expect(org).toBeGreaterThan(0);
    expect(user).toBeGreaterThan(0);
  });

  it("RR3: a PARTITIONED table is in the walk, not invisible to both halves", async () => {
    // The completeness walks filtered `relkind = 'r'`, so a partitioned table
    // (`relkind = 'p'`) with no foreign key was in neither derivation, neither
    // remainder AND neither count -- the two halves blind together, so the
    // arithmetic still balanced and nothing reported it. Not live today (51
    // `r`, 0 `p`), and partitioning `audit_events` for the hot/cold retention
    // split (SECURITY.md § 7) is a NAMED future task, so this is the exact
    // change that would have done it.
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query(
        `create table public.census_probe_partitioned (id uuid not null, at timestamptz not null) partition by range (at)`,
      );
      const { rows } = await client.query<{ tbl: string }>(
        `select c.relname as tbl
           from pg_class c join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'public' and c.relkind in ('r', 'p')
            and c.relname not in (${ORGANISATION_TABLES_SQL})
            and c.relname not in (${USER_TABLES_SQL})
          order by c.relname`,
      );
      expect(rows.map((r) => r.tbl)).toContain("census_probe_partitioned");
      // ...and the OLD filter is asserted to MISS it, so the widening is
      // measured rather than claimed.
      const { rows: old } = await client.query<{ tbl: string }>(
        `select c.relname as tbl from pg_class c join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'public' and c.relkind = 'r' and c.relname = 'census_probe_partitioned'`,
      );
      expect(old, "relkind = 'r' is supposed to miss a partitioned table").toEqual([]);
    } finally {
      await client.query("rollback");
      client.release();
    }
  });

  it("rate_limit_counters is the one that is not reference data, and it is named as such", () => {
    // The review's finding in one assertion: this table has a real
    // row -> organisation path and a real row -> user path through a column
    // with NO foreign key, so both walks are blind to it. It must never be
    // exported; what it must not be is UNSEEN.
    expect(Object.keys(NEITHER_DERIVATION)).toContain("rate_limit_counters");
    expect(NEITHER_DERIVATION.rate_limit_counters).toContain("subject_id");
  });

  it("RR4: and it is stated IN THE ARCHIVE, not only in this file's comment", () => {
    // A remainder table has no catalogue row by construction, so the runner's
    // `withheld` array -- built from the plan's EXCUSED rows -- could never
    // carry one. Every other excluded table says so in the manifest the data
    // subject can read; this one said so only in the TypeScript comment above.
    // REMAINDER_WITHHELD is the product-side roll that closes that, and this
    // is the assertion that keeps the two from drifting: a later table with a
    // subject path and no foreign key cannot join the remainder without
    // joining the archive's own statement of what it left out.
    expect(REMAINDER_WITHHELD.map((r) => r.table)).toEqual(["rate_limit_counters"]);
    for (const entry of REMAINDER_WITHHELD) {
      expect(Object.keys(NEITHER_DERIVATION), `${entry.table} is withheld but not in the remainder`).toContain(
        entry.table,
      );
      // The detail is what the person actually reads, so it has to be a
      // sentence rather than a table name.
      expect(entry.detail.length, entry.table).toBeGreaterThan(120);
      expect(entry.detail).not.toContain("_");
    }
  });

  it("and the column that makes it so is still there, unconstrained", async () => {
    // If a later migration gives `subject_id` a foreign key, the table joins
    // a derivation and needs a catalogue row instead — so this reds rather
    // than leaving the reason above quietly stale.
    const { rows } = await pool.query<{ n: string }>(
      `select count(*)::text as n
         from pg_attribute a
         join pg_class c on c.oid = a.attrelid
         join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relname = 'rate_limit_counters'
          and a.attname = 'subject_id' and a.attnum > 0 and not a.attisdropped`,
    );
    expect(rows[0]?.n).toBe("1");
    const { rows: fks } = await pool.query<{ conname: string }>(
      `select k.conname
         from pg_constraint k
         join pg_class c on c.oid = k.conrelid
         join pg_namespace n on n.oid = c.relnamespace
        where k.contype = 'f' and n.nspname = 'public' and c.relname = 'rate_limit_counters'
          and 'subject_id' = any (
            select a.attname from pg_attribute a
             where a.attrelid = c.oid and a.attnum = any (k.conkey))`,
    );
    expect(fks, "subject_id grew a foreign key: rate_limit_counters now lands in a derivation and needs a catalogue disposition, not a remainder entry").toEqual([]);
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

  it("A TABLE WITH A BARE uuid organisation_id AND NO FOREIGN KEY is caught by the remainder", async () => {
    // THE SHAPE NONE OF THE THREE PLANTS ABOVE COVERS (review finding I2).
    // All three plant a table WITH a foreign key, so all three are caught by
    // the derivation — and the hole the review found is a table with a real
    // row -> organisation path and no constraint to walk. `rate_limit_counters`
    // is that shape today; this is the proof that a SECOND one arrives as a
    // red test rather than as silence.
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query(`
        create table public.census_probe_bare (
          id uuid primary key default gen_random_uuid(),
          organisation_id uuid not null
        )`);

      // Invisible to BOTH walks — which is the whole problem.
      const { rows: org } = await client.query<{ tbl: string }>(ORGANISATION_TABLES_SQL);
      expect(org.map((r) => r.tbl)).not.toContain("census_probe_bare");
      const { rows: usr } = await client.query<{ tbl: string }>(USER_TABLES_SQL);
      expect(usr.map((r) => r.tbl)).not.toContain("census_probe_bare");

      // And therefore in the remainder, where it does not match the roll.
      const { rows } = await client.query<{ tbl: string }>(
        `select c.relname as tbl
           from pg_class c
           join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'public' and c.relkind in ('r', 'p')
            and c.relname not in (${ORGANISATION_TABLES_SQL})
            and c.relname not in (${USER_TABLES_SQL})
          order by c.relname`,
      );
      const remainderNow = rows.map((r) => r.tbl);
      expect(remainderNow).toContain("census_probe_bare");
      expect(
        remainderNow,
        "this is the assertion that would have gone red: the remainder no longer equals its pinned roll",
      ).not.toEqual(Object.keys(NEITHER_DERIVATION).sort());
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
