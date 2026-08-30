// PERMISSION_FOR_ENTITY (lib/crm/custom-fields.ts) vs the DEPLOYED
// private.entity_is_manageable() and the DEPLOYED public.permissions
// catalogue.
//
// ===========================================================================
// WHY THIS FILE EXISTS, AND WHY IT IS NOT A UNIT TEST ANY MORE
// ===========================================================================
// It replaces the describe block "PERMISSION_FOR_ENTITY mirrors
// private.entity_is_manageable()" in tests/unit/crm/source-shape.test.ts,
// which Phase 3 Task 1's review (finding I-2) found could not see the sixth
// entry. That version had two independent blind spots and each one is closed
// by a different assertion below:
//
//   1. IT ITERATED ITS OWN HARDCODED FIVE-ENTRY MAP. Task 1 added
//      `event: "manage_events"` to PERMISSION_FOR_ENTITY and nothing went red,
//      because the loop never asked what was in the TypeScript table -- it
//      asked whether the five entries it already knew about were. A sixth,
//      seventh or wrong entry was invisible in both directions. Here the
//      iteration is over the REAL table, and `it("...covers every entry")`
//      asserts the two key sets are equal, so an entity type added to either
//      side alone is red.
//
//   2. IT READ A MIGRATION FILE AS TEXT --
//      20260828120500_crm_policy_helpers.sql, the file that FIRST created the
//      function. `create or replace function` means that file stopped being
//      what is deployed the moment 20260901010000 replaced it, so the test was
//      asserting against a body the database no longer runs. Every mirror in
//      this repository that got this right reads pg_get_functiondef(); so does
//      this one.
//
// The blast radius is genuinely small -- the old file's own comment said
// getting this wrong "cannot open a write", because the SQL function is the
// enforcement and the TypeScript table only decides which sentence a blocked
// user reads. That is exactly why nothing else would have caught it, and why
// the tripwire has to be deliberate.
//
// LOCAL ONLY, everything rolled back. Same guard as every other integration
// test here: env.ts refuses anything that is not the loopback stack.
import { afterAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { getLocalSupabaseStatus } from "../rls/support/env";
import { PERMISSION_FOR_ENTITY } from "@/lib/crm/custom-fields";

const pool = new Pool({ connectionString: getLocalSupabaseStatus().dbUrl });

afterAll(async () => {
  await pool.end();
});

/** The deployed body of private.entity_is_manageable(). */
async function deployedBody(): Promise<string> {
  const { rows } = await pool.query<{ def: string }>(
    `select pg_get_functiondef(p.oid) as def
       from pg_proc p
       join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'private' and p.proname = 'entity_is_manageable'`,
  );
  expect(rows, "private.entity_is_manageable() is not in the catalogue").toHaveLength(1);
  return rows[0]!.def;
}

/**
 * entity type -> the permission key its arm names, read out of the deployed
 * body. Sliced arm by arm rather than regexed whole, because each arm also
 * contains `private.full_scope_organisations()` and a table name, and a blunt
 * scrape would pair the wrong two strings.
 */
function armKeys(def: string): Record<string, string> {
  const out: Record<string, string> = {};
  const arms = [...def.matchAll(/when\s+'([^']+)'\s+then/g)];
  for (const [i, m] of arms.entries()) {
    const from = m.index!;
    const to = i + 1 < arms.length ? arms[i + 1]!.index! : def.length;
    const body = def.slice(from, to);
    const key = body.match(/permitted_organisations\('([^']+)'\)/);
    if (key) out[m[1]!] = key[1]!;
  }
  return out;
}

describe("PERMISSION_FOR_ENTITY mirrors the DEPLOYED entity_is_manageable()", () => {
  it("finds arms at all, so nothing below can pass vacuously", async () => {
    const keys = armKeys(await deployedBody());
    expect(Object.keys(keys).length).toBeGreaterThan(0);
    expect(keys.venue).toBe("manage_venues");
  });

  it("covers every entry of PERMISSION_FOR_ENTITY, and no more", async () => {
    // THE ASSERTION THE OLD VERSION COULD NOT MAKE. Both sides are read, not
    // typed out, so a seventh entity type added to the TypeScript table with
    // no SQL arm -- or an arm with no TypeScript entry -- is red here rather
    // than silently half-shipped. `else false` means a missing arm is a silent
    // DENY, which is the safe direction and the invisible one.
    const keys = armKeys(await deployedBody());
    expect(Object.keys(keys).sort()).toEqual(
      Object.keys(PERMISSION_FOR_ENTITY).sort(),
    );
  });

  it("agrees with SQL on WHICH key every entity type resolves to", async () => {
    const keys = armKeys(await deployedBody());
    const disagreements: string[] = [];
    for (const [entity, key] of Object.entries(PERMISSION_FOR_ENTITY)) {
      if (keys[entity] !== key) {
        disagreements.push(`${entity}: ts=${key} sql=${keys[entity] ?? "<no arm>"}`);
      }
    }
    expect(disagreements, disagreements.join("; ")).toEqual([]);
  });

  it("names only keys that exist in the deployed catalogue", async () => {
    // THE HALF NOTHING HAS EVER ASSERTED. A key that is absent from
    // public.permissions is absent from the join inside
    // private.permitted_organisations(), which returns no rows -- so a typo in
    // either mirror fails CLOSED, denying every write of that entity type with
    // no error anywhere. That is what 20260901001000's header § (d) is about,
    // and it is why manage_events is seeded in the same file as its arm.
    const wanted = [...new Set(Object.values(PERMISSION_FOR_ENTITY))];
    const { rows } = await pool.query<{ key: string }>(
      "select key from public.permissions where key = any($1)",
      [wanted],
    );
    expect(rows.map((r) => r.key).sort()).toEqual([...wanted].sort());
  });

  it("manage_events is granted to exactly the six roles Q29 named", async () => {
    // Read out of role_permissions rather than out of the migration text, for
    // the reason rls_phase2_crm.sql § A gives: a matrix that was seeded wrong
    // makes every policy assertion meaningless in a way that still shows green.
    // The psql half is rls_phase3_events.sql § EA; this is the half that runs
    // in `pnpm test`, where nobody has to remember to reset a database first.
    const { rows } = await pool.query<{ role_key: string }>(
      "select role_key from public.role_permissions where permission_key = 'manage_events' order by role_key",
    );
    expect(rows.map((r) => r.role_key)).toEqual([
      "admin",
      "booker",
      "manager",
      "owner",
      "standard_user",
      "venue_manager",
    ]);
  });

  it("BEHAVIOURAL: a booker manages events and artists, and not venues", async () => {
    // THE ASSERTION THAT MAKES THE MAPPING MEAN SOMETHING. Everything above
    // compares two texts; this asks the deployed function, through a real
    // `authenticated` session with real claims, and gets three different
    // answers out of one role -- which is only possible if the key really is
    // chosen per entity type.
    //
    // The Booker is the discriminating role by construction (Q2 / Q29): they
    // hold manage_artists and manage_events and NOT manage_venues. A dispatch
    // that had copy-pasted the venue arm's key into the event arm would answer
    // false for the event; one that ignored the key altogether would answer
    // true for the venue. Both are caught here and by nothing above.
    const client = await pool.connect();
    try {
      await client.query("begin");
      const {
        rows: [{ uid }],
      } = await client.query<{ uid: string }>(
        `insert into auth.users (id, instance_id, aud, role, email,
                                 encrypted_password, email_confirmed_at,
                                 created_at, updated_at)
         values (gen_random_uuid(), '00000000-0000-0000-0000-000000000000',
                 'authenticated', 'authenticated',
                 'pfe-' || gen_random_uuid() || '@example.test',
                 'x', now(), now(), now())
         returning id as uid`,
      );
      const {
        rows: [{ org }],
      } = await client.query<{ org: string }>(
        `insert into public.organisations (name, slug)
         values ('Permission mirror probe',
                 'pfe-' || replace(gen_random_uuid()::text, '-', ''))
         returning id as org`,
      );
      await client.query(
        `insert into public.organisation_memberships
           (organisation_id, user_id, role, status, joined_at)
         values ($1, $2, 'booker', 'active', now())`,
        [org, uid],
      );
      const {
        rows: [ids],
      } = await client.query<{ ev: string; ar: string; vn: string }>(
        `with e as (
           insert into public.events (organisation_id, name, starts_at)
           values ($1, 'Mirror Event', now()) returning id
         ), a as (
           insert into public.artists (organisation_id, name)
           values ($1, 'Mirror Artist') returning id
         ), v as (
           insert into public.venues (organisation_id, name)
           values ($1, 'Mirror Venue') returning id
         )
         select (select id from e) as ev, (select id from a) as ar,
                (select id from v) as vn`,
        [org],
      );

      await client.query("set local role authenticated");
      await client.query("select set_config('request.jwt.claims', $1, true)", [
        JSON.stringify({ sub: uid, role: "authenticated", aal: "aal2" }),
      ]);

      const { rows } = await client.query<{
        ev: boolean;
        ar: boolean;
        vn: boolean;
      }>(
        `select private.entity_is_manageable('event',  $1, $4) as ev,
                private.entity_is_manageable('artist', $2, $4) as ar,
                private.entity_is_manageable('venue',  $3, $4) as vn`,
        [ids!.ev, ids!.ar, ids!.vn, org],
      );
      expect(rows[0], "a Booker holds manage_events and manage_artists, not manage_venues")
        .toEqual({ ev: true, ar: true, vn: false });
    } finally {
      await client.query("rollback").catch(() => {});
      client.release();
    }
  });
});
