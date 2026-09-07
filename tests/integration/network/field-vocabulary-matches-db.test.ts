// The tripwire for lib/network/fields.ts, and the reason it is an INTEGRATION
// test rather than a unit one.
//
// ===========================================================================
// WHY A TEST THAT RE-STATES THE LITERALS WOULD PROVE NOTHING
// ===========================================================================
// The `tiers-match-db` pattern, verbatim: lib/network/fields.ts is a typed
// COMPILE-TIME MIRROR of vocabularies the DATABASE enforces --
// private.network_visibility_is_valid()'s two `in (...)` lists, and the CHECK
// constraints on network_profiles.entity_kind / .status and
// network_connection_requests.status. Proving the mirror is accurate means
// reading the ACTUAL deployed constraint and function bodies out of a REAL
// Postgres and comparing them to the constants. A test that compared those
// constants to a SECOND HARDCODED OBJECT written in this file would restate the
// same literals twice and stay green after someone widened a CHECK in a
// migration and forgot fields.ts -- which is exactly the drift this exists to
// catch, and exactly why it lives in tests/integration.
//
// ===========================================================================
// WHAT EACH ASSERTION IS ACTUALLY WORTH
// ===========================================================================
// The vocabulary matters in four different ways, and the tests are grouped by
// which:
//
//   VISIBILITY LEVELS  a level in TypeScript the CHECK rejects is a 23514 the
//                      user cannot act on; a level in the CHECK that fields.ts
//                      does not know is a `<select>` option that never renders,
//                      so a publisher cannot reach a state the database allows.
//   PUBLISHABLE FIELDS a field added to the CHECK without a `case when` arm in
//                      the masking views would be PUBLISHED UNMASKED. This is
//                      the one whose failure is a leak rather than a bug, so it
//                      is asserted against the views' column lists too.
//   ALWAYS-NETWORK     display_name and entity_kind must be REJECTED as keys.
//                      A level that cannot be set cannot be mis-set, and the
//                      day one of them becomes settable it must be a decision,
//                      not a widening nobody noticed.
//   ENTITY KINDS /     ordinary vocabulary mirrors, the operations-vocabularies
//   STATUSES           pattern.
//
// LOCAL ONLY, same discipline as every other file in tests/integration:
// getLocalSupabaseStatus() refuses anything that is not the loopback stack. No
// fixtures are planted and nothing is written, so there is no rollback to do --
// every query reads the catalog.
import { afterAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { getLocalSupabaseStatus } from "../rls/support/env";
import {
  ALWAYS_NETWORK_FIELDS,
  CONNECTION_STATUSES,
  NETWORK_ENTITY_KINDS,
  PROFILE_STATUSES,
  PUBLISHABLE_FIELDS,
  VISIBILITY_LEVELS,
} from "@/lib/network/fields";

const pool = new Pool({ connectionString: getLocalSupabaseStatus().dbUrl });

afterAll(async () => {
  await pool.end();
});

/** The deployed source of a private function, out of pg_get_functiondef. */
async function functionBody(name: string): Promise<string> {
  const { rows } = await pool.query<{ def: string }>(
    `select pg_get_functiondef(p.oid) as def
       from pg_proc p
       join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'private' and p.proname = $1`,
    [name],
  );
  expect(rows.length, `private.${name} exists`).toBe(1);
  return rows[0]!.def;
}

/** The deployed definition of a named CHECK constraint. */
async function constraintDef(name: string): Promise<string> {
  const { rows } = await pool.query<{ def: string }>(
    `select pg_get_constraintdef(oid) as def
       from pg_constraint
      where connamespace = 'public'::regnamespace and conname = $1`,
    [name],
  );
  expect(rows.length, `constraint ${name} exists`).toBe(1);
  return rows[0]!.def;
}

/**
 * Every single-quoted literal in a deparsed expression, deduplicated.
 *
 * The deparser normalises a CHECK's `in ('a','b')` to
 * `= ANY (ARRAY['a'::text, 'b'::text])`, so a regex over the ARRAY body is what
 * reads the set back. It is deliberately a LITERAL extractor rather than an
 * attempt to parse the expression: what has to match is the SET of accepted
 * values, and any expression whose literals differ from the constants has
 * drifted whatever its shape.
 */
function literalsIn(sql: string): string[] {
  return [...new Set(Array.from(sql.matchAll(/'([^']*)'/g), (m) => m[1]!))];
}

describe("the visibility vocabulary matches private.network_visibility_is_valid", () => {
  it("the three LEVELS in the deployed function are exactly VISIBILITY_LEVELS", async () => {
    const body = await functionBody("network_visibility_is_valid");
    // The function has two `not in (...)` lists: the KEYS list and the LEVELS
    // list. They are sliced apart on `kv.value`, which begins the second, so a
    // level smuggled into the keys list (or vice versa) does not satisfy this.
    const [, levelsHalf] = body.split("kv.value");
    expect(levelsHalf, "the function tests kv.value against a list").toBeDefined();
    expect(literalsIn(levelsHalf!).sort()).toEqual([...VISIBILITY_LEVELS].sort());
  });

  it("the seven KEYS in the deployed function are exactly PUBLISHABLE_FIELDS", async () => {
    const body = await functionBody("network_visibility_is_valid");
    const keysHalf = body.split("kv.key")[1]!.split("kv.value")[0]!;
    expect(literalsIn(keysHalf).sort()).toEqual([...PUBLISHABLE_FIELDS].sort());
  });

  it("REJECTS the always-network fields as keys -- a level that cannot be set cannot be mis-set", async () => {
    // Q71's other half, and the one a widening would quietly undo. Asserted
    // against the KEYS list specifically rather than the whole body, so a
    // future comment mentioning display_name does not turn this red.
    const body = await functionBody("network_visibility_is_valid");
    const keysHalf = body.split("kv.key")[1]!.split("kv.value")[0]!;
    const keys = literalsIn(keysHalf);
    for (const always of ALWAYS_NETWORK_FIELDS) {
      expect(keys, `${always} must NOT be a settable visibility key`).not.toContain(
        always,
      );
    }
    // The non-vacuity half: the list this is checking is genuinely the key list.
    expect(keys.length, "keys inspected").toBe(PUBLISHABLE_FIELDS.length);
  });

  it("is wired to the table by a CHECK, not merely defined", async () => {
    // A vocabulary function nothing calls is the Phase 5 I2 defect (Constraint
    // 19): shipping the validator and not calling it. The constraint is what
    // makes the function load-bearing.
    const def = await constraintDef("network_profiles_visibility_vocabulary");
    expect(def).toContain("network_visibility_is_valid");
  });
});

describe("the publishable fields are exactly what the schema constrains and the views mask", () => {
  it("network_profiles_hidden_fields_are_null names all seven, and only those seven", async () => {
    // N3's constraint governs one value column per publishable field. A field
    // in PUBLISHABLE_FIELDS that this CHECK does not name could be set to
    // `hidden` and KEEP ITS VALUE -- masked at read time and stored, which is
    // exactly the state N3 exists to forbid.
    const def = await constraintDef("network_profiles_hidden_fields_are_null");
    for (const name of PUBLISHABLE_FIELDS) {
      expect(def, `${name} is governed by the hidden-fields CHECK`).toContain(name);
    }
    // ...and nothing else is. Counted through the constraint's own literal set,
    // which for this CHECK is the seven field names plus the single 'hidden'
    // level it coalesces to.
    const literals = literalsIn(def).filter((l) => l !== "hidden");
    expect(literals.sort()).toEqual([...PUBLISHABLE_FIELDS].sort());
  });

  it("BOTH masking views expose exactly the seven, plus the three always-visible columns", async () => {
    // THE ASSERTION WHOSE FAILURE IS A LEAK. A field added to the vocabulary
    // and to the table without a `case when` arm in 20260904004000 would be
    // projected unmasked -- or, if the view were not updated at all, would be
    // absent and silently unpublishable. Both directions are wrong and this
    // catches both, on both views.
    const expected = [
      "id",
      "entity_kind",
      "display_name",
      ...PUBLISHABLE_FIELDS,
      "published_at",
    ].sort();
    for (const view of ["network_directory", "network_connected_profiles"]) {
      const { rows } = await pool.query<{ column_name: string }>(
        `select column_name from information_schema.columns
          where table_schema='public' and table_name=$1`,
        [view],
      );
      expect(
        rows.map((r) => r.column_name).sort(),
        `${view} column list`,
      ).toEqual(expected);
    }
  });

  it("neither view projects organisation_id or entity_id, and the base table has both", async () => {
    // The denominator half. "Neither view has them" is satisfied by two views
    // that have no columns at all, so the base table's possession of them is
    // what makes the absence a finding.
    const { rows } = await pool.query<{ table_name: string; column_name: string }>(
      `select table_name, column_name from information_schema.columns
        where table_schema='public'
          and table_name in ('network_profiles','network_directory',
                             'network_connected_profiles')
          and column_name in ('organisation_id','entity_id')`,
    );
    expect(
      rows.filter((r) => r.table_name !== "network_profiles"),
      "views projecting a tenant identifier",
    ).toEqual([]);
    expect(
      rows.filter((r) => r.table_name === "network_profiles").length,
      "the base table has both (so the absence above is measured)",
    ).toBe(2);
  });
});

describe("the three closed status/kind vocabularies match their CHECK constraints", () => {
  it("NETWORK_ENTITY_KINDS matches network_profiles.entity_kind", async () => {
    const def = await constraintDef("network_profiles_entity_kind_check");
    expect(literalsIn(def).sort()).toEqual([...NETWORK_ENTITY_KINDS].sort());
  });

  it("...and 'contact' is deliberately NOT among them (Q74)", async () => {
    // Written as its own assertion rather than left implicit in the set
    // comparison above, because the omission is a PRODUCT decision -- a contact
    // is a person in someone's address book, and publishing a person's details
    // as an industry identity is a consent question this MVP does not answer.
    // Adding it should be a founder decision, and this is what makes it one.
    expect([...NETWORK_ENTITY_KINDS]).not.toContain("contact");
  });

  it("PROFILE_STATUSES matches network_profiles.status", async () => {
    const def = await constraintDef("network_profiles_status_check");
    expect(literalsIn(def).sort()).toEqual([...PROFILE_STATUSES].sort());
  });

  it("CONNECTION_STATUSES matches network_connection_requests.status", async () => {
    const def = await constraintDef("network_connection_requests_status_check");
    expect(literalsIn(def).sort()).toEqual([...CONNECTION_STATUSES].sort());
  });

  it("the transition guard treats exactly the three non-pending statuses as terminal", async () => {
    // The guard's own list has to stay in step with CONNECTION_STATUSES minus
    // `pending`. A status added to the CHECK without being added there would be
    // freely re-writable after the fact -- the un-declining a stray PATCH could
    // otherwise do, arriving through the front door.
    const body = await functionBody("network_request_status_transition_guard");
    const terminal = CONNECTION_STATUSES.filter((s) => s !== "pending");
    for (const status of terminal) {
      expect(body, `${status} is terminal in the guard`).toContain(`'${status}'`);
    }
    expect(terminal.length, "terminal statuses inspected").toBe(3);
  });
});
