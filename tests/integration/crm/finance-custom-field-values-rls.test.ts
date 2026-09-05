// `financial_entry` IS THE SEVENTH CUSTOM-FIELD ENTITY TYPE (Phase 5 Task 3).
// This is the behavioural half of that claim: everything else about the change
// is a census, a mirror or a CHECK constraint, and none of those can say
// whether a Finance user can actually store a value on a finance line, or
// whether anyone else can.
//
// Four things are proved here, each with its own denominator:
//
//   POSITIVE      a Finance caller (view_finance + manage_finance, aal2) writes
//                 a `financial_entry` custom-field value through the SAME
//                 public.set_custom_field_values RPC every other entity uses,
//                 and reads it back.
//   THE GATE      a Booker (view_crm, manage_events, no finance keys) reads
//                 ZERO of those values and is REFUSED the write -- while
//                 writing and reading an `event` custom-field value in the same
//                 role, which is the non-vacuity control that says the refusal
//                 is about finance and not about the session.
//   TIER (Q64)    a Starter org may DEFINE a `financial_entry` field (the
//                 shared enforce_custom_field_limit trigger is the only gate on
//                 definitions, and Starter has 5 slots per entity type) but the
//                 finance MODULE gate lands on the VALUE write. Two cases, and
//                 the second is the one that matters: a never-Pro Starter org
//                 can hold no financial_entries row at all, and a Pro org that
//                 DOWNGRADES keeps its lines (Q67) but loses the value write --
//                 by the explicit finance_module conjunct 20260903030000 put on
//                 entity_is_manageable's financial_entry arm (review finding
//                 I1). Reads survive the downgrade; writes do not.
//   THE ARM KEYS  private.entity_is_visible()'s `financial_entry` arm names
//                 view_finance and entity_is_manageable()'s names
//                 manage_finance, read out of the DEPLOYED bodies.
//
// ONE ASSERTION PER TRANSACTION WHERE A REFUSAL IS EXPECTED. A statement an RLS
// policy refuses raises, and a raise aborts the whole transaction -- so a
// refusal and the positive control that gives it a denominator cannot share
// one, and each `it` below opens its own.
//
// The CHECK-constraint and arm-SET censuses live in
// entity-dispatch-branches-match-db.test.ts and
// custom-field-entity-types-match-db.test.ts; this file does not repeat them.
//
// LOCAL ONLY, everything rolled back. env.ts refuses anything but the loopback
// stack.
import { afterAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import type { PoolClient } from "pg";
import { getLocalSupabaseStatus } from "../rls/support/env";
import { PERMISSION_FOR_ENTITY } from "@/lib/crm/custom-fields";

const pool = new Pool({ connectionString: getLocalSupabaseStatus().dbUrl });

afterAll(async () => {
  await pool.end();
});

async function createUser(client: PoolClient, prefix: string): Promise<string> {
  const {
    rows: [row],
  } = await client.query<{ uid: string }>(
    `insert into auth.users (id, instance_id, aud, role, email,
                             encrypted_password, email_confirmed_at,
                             created_at, updated_at)
     values (gen_random_uuid(), '00000000-0000-0000-0000-000000000000',
             'authenticated', 'authenticated',
             $1 || gen_random_uuid() || '@example.test',
             'x', now(), now(), now())
     returning id as uid`,
    [prefix],
  );
  return row!.uid;
}

async function createOrg(client: PoolClient, name: string): Promise<string> {
  const {
    rows: [row],
  } = await client.query<{ org: string }>(
    `insert into public.organisations (name, slug)
     values ($1, 'cfv-' || replace(gen_random_uuid()::text, '-', ''))
     returning id as org`,
    [name],
  );
  return row!.org;
}

/**
 * An ACTIVE subscription on `plan`, a year out.
 *
 * Without a row the organisation is UN-GATED -- the "not yet billed" escape in
 * private.crm_write_organisations() and private.finance_module_organisations()
 * -- which is exactly the state a tier assertion must not accidentally test.
 */
async function subscribe(
  client: PoolClient,
  org: string,
  plan: "free" | "starter" | "pro",
): Promise<void> {
  await client.query(
    `insert into public.organisation_subscriptions
       (organisation_id, plan_id, billing_cycle, seat_count, status,
        current_period_end)
     values ($1, $2, 'monthly', 1, 'active', now() + interval '365 days')`,
    [org, plan],
  );
}

/** Become this user for the statements that follow, at this assurance level. */
async function actAs(
  client: PoolClient,
  uid: string,
  aal: "aal1" | "aal2",
): Promise<void> {
  await client.query("set local role authenticated");
  await client.query("select set_config('request.jwt.claims', $1, true)", [
    JSON.stringify({ sub: uid, role: "authenticated", aal }),
  ]);
}

/** Back to the owner role, so the next fixture statement is not RLS-bound. */
async function stopActing(client: PoolClient): Promise<void> {
  await client.query("reset role");
  await client.query("select set_config('request.jwt.claims', '', true)");
}

/**
 * The RPC the finance form calls (lib/crm/finance.ts).
 *
 * SECURITY INVOKER, so all three custom_field_values write policies -- and
 * through them private.entity_is_manageable() and private.entity_is_live() --
 * decide every statement it runs. Driving the RPC rather than a bare INSERT is
 * deliberate: it is the exact path the application takes.
 */
async function setValue(
  client: PoolClient,
  org: string,
  entityType: string,
  entityId: string,
  fieldId: string,
  value: string,
): Promise<number> {
  const { rows } = await client.query<{ n: number }>(
    `select public.set_custom_field_values($1, $2, $3,
              jsonb_build_object($4::text, to_jsonb($5::text))) as n`,
    [org, entityType, entityId, fieldId, value],
  );
  return Number(rows[0]!.n);
}

async function readValues(
  client: PoolClient,
  org: string,
  entityType: string,
  entityId: string,
): Promise<string[]> {
  const { rows } = await client.query<{ value: unknown }>(
    `select value from public.custom_field_values
      where organisation_id = $1 and entity_type = $2 and entity_id = $3`,
    [org, entityType, entityId],
  );
  return rows.map((r) => JSON.stringify(r.value));
}

/** org + admin/finance/booker members + a live event + a live finance line. */
async function proOrgWithLine(client: PoolClient): Promise<{
  org: string;
  adminUid: string;
  financeUid: string;
  bookerUid: string;
  eventId: string;
  entryId: string;
  financeFieldId: string;
  eventFieldId: string;
}> {
  const org = await createOrg(client, "Finance custom field probe");
  await subscribe(client, org, "pro");

  const adminUid = await createUser(client, "cfv-admin-");
  const financeUid = await createUser(client, "cfv-fin-");
  const bookerUid = await createUser(client, "cfv-book-");
  await client.query(
    `insert into public.organisation_memberships
       (organisation_id, user_id, role, status, joined_at)
     values ($1, $2, 'admin',   'active', now()),
            ($1, $3, 'finance', 'active', now()),
            ($1, $4, 'booker',  'active', now())`,
    [org, adminUid, financeUid, bookerUid],
  );

  const {
    rows: [ids],
  } = await client.query<{ ev: string; fe: string }>(
    `with e as (
       insert into public.events (organisation_id, owner_user_id, name, starts_at)
       values ($1, $2, 'Custom finance field probe', now()) returning id
     ), f as (
       insert into public.financial_entries
         (organisation_id, created_by, event_id, category, status,
          amount_minor, currency, occurred_on)
       select $1, $2, e.id, 'fee', 'budgeted', 100000, 'GBP', current_date
         from e returning id
     )
     select (select id from e) as ev, (select id from f) as fe`,
    [org, adminUid],
  );

  // THE DEFINITIONS ARE AN ADMIN ACTION, through the real policy:
  // manage_custom_fields, not manage_finance. Defining a field and filling it
  // in are different permissions -- which is the whole reason
  // PERMISSION_FOR_ENTITY names the ENTITY's key. Admin requires MFA (aal2).
  await actAs(client, adminUid, "aal2");
  const {
    rows: [fields],
  } = await client.query<{ fin: string; ev: string }>(
    `with f as (
       insert into public.custom_field_definitions
         (organisation_id, entity_type, key, label, field_type)
       values ($1, 'financial_entry', 'contract_ref', 'Contract ref', 'text')
       returning id
     ), e as (
       insert into public.custom_field_definitions
         (organisation_id, entity_type, key, label, field_type)
       values ($1, 'event', 'promoter_ref', 'Promoter ref', 'text')
       returning id
     )
     select (select id from f) as fin, (select id from e) as ev`,
    [org],
  );
  await stopActing(client);

  return {
    org,
    adminUid,
    financeUid,
    bookerUid,
    eventId: ids!.ev,
    entryId: ids!.fe,
    financeFieldId: fields!.fin,
    eventFieldId: fields!.ev,
  };
}

describe("financial_entry custom-field values are gated by the finance keys", () => {
  it("a Finance user writes one and reads it back", async () => {
    const client = await pool.connect();
    try {
      await client.query("begin");
      const f = await proOrgWithLine(client);

      await actAs(client, f.financeUid, "aal2");
      expect(
        await setValue(
          client,
          f.org,
          "financial_entry",
          f.entryId,
          f.financeFieldId,
          "A-1",
        ),
        "one value upserted through the shared RPC",
      ).toBe(1);
      expect(
        await readValues(client, f.org, "financial_entry", f.entryId),
        "the Finance user reads back exactly what they wrote",
      ).toEqual(['"A-1"']);
    } finally {
      await client.query("rollback").catch(() => {});
      client.release();
    }
  });

  it("a Booker reads ZERO of them -- and reads the event's own fine", async () => {
    // The read gate plus its denominator, in one session. The Booker holds
    // view_crm, so the custom_field_values SELECT policy's first term passes
    // for both rows; what separates them is entity_is_visible(), which for
    // `financial_entry` asks for view_finance and for `event` asks for
    // view_crm. Without the event row, "reads nothing" would also be the
    // answer for a fixture that stored nothing.
    const client = await pool.connect();
    try {
      await client.query("begin");
      const f = await proOrgWithLine(client);

      await actAs(client, f.financeUid, "aal2");
      await setValue(client, f.org, "financial_entry", f.entryId, f.financeFieldId, "A-1");
      await stopActing(client);
      await actAs(client, f.adminUid, "aal2");
      await setValue(client, f.org, "event", f.eventId, f.eventFieldId, "P-9");
      await stopActing(client);

      await actAs(client, f.bookerUid, "aal1");
      expect(
        await readValues(client, f.org, "financial_entry", f.entryId),
        "no view_finance -> entity_is_visible('financial_entry') is false",
      ).toEqual([]);
      expect(
        await readValues(client, f.org, "event", f.eventId),
        "the SAME session reads the event's value, so the empty result above " +
          "is the finance gate and not an empty fixture",
      ).toEqual(['"P-9"']);
    } finally {
      await client.query("rollback").catch(() => {});
      client.release();
    }
  });

  it("a Booker's write of a financial_entry value is REFUSED", async () => {
    const client = await pool.connect();
    try {
      await client.query("begin");
      const f = await proOrgWithLine(client);

      await actAs(client, f.bookerUid, "aal1");
      await expect(
        setValue(client, f.org, "financial_entry", f.entryId, f.financeFieldId, "B-2"),
        "no manage_finance -> entity_is_manageable('financial_entry') is false " +
          "and the INSERT policy refuses",
      ).rejects.toThrow();
    } finally {
      await client.query("rollback").catch(() => {});
      client.release();
    }
  });

  it("...while the SAME Booker writes an event custom field", async () => {
    // THE NON-VACUITY CONTROL for the refusal above, in its own transaction
    // because a refused statement aborts the one it happens in. Without it,
    // that assertion passes just as happily against a session that could not
    // write anything at all -- a broken fixture, a missing grant, a claims
    // string that named nobody.
    const client = await pool.connect();
    try {
      await client.query("begin");
      const f = await proOrgWithLine(client);

      await actAs(client, f.bookerUid, "aal1");
      expect(
        await setValue(client, f.org, "event", f.eventId, f.eventFieldId, "P-9"),
        "a Booker holds manage_events, so the identical write on an EVENT " +
          "custom field succeeds -- the finance refusal is about the finance " +
          "keys, not about this session",
      ).toBe(1);
      expect(await readValues(client, f.org, "event", f.eventId)).toEqual(['"P-9"']);
    } finally {
      await client.query("rollback").catch(() => {});
      client.release();
    }
  });

  it("a Starter org may DEFINE a financial_entry field but can hold no line", async () => {
    // Q64's chain, measured. Starter's custom_field_limit is 5 per entity
    // type, so the DEFINITION is allowed -- the module gate is deliberately
    // NOT duplicated onto definitions. What Starter cannot have is a
    // financial_entries ROW, and without one there is nothing for a
    // `financial_entry` value's entity_is_manageable()/entity_is_live() terms
    // to resolve against.
    const client = await pool.connect();
    try {
      await client.query("begin");

      const org = await createOrg(client, "Starter finance probe");
      await subscribe(client, org, "starter");
      const ownerUid = await createUser(client, "cfv-starter-");
      await client.query(
        `insert into public.organisation_memberships
           (organisation_id, user_id, role, status, joined_at)
         values ($1, $2, 'owner', 'active', now())`,
        [org, ownerUid],
      );
      const {
        rows: [ev],
      } = await client.query<{ id: string }>(
        `insert into public.events (organisation_id, owner_user_id, name, starts_at)
         values ($1, $2, 'Starter event', now()) returning id`,
        [org, ownerUid],
      );

      await actAs(client, ownerUid, "aal2");

      // THE DEFINITION IS ALLOWED: Owner holds manage_custom_fields, Starter
      // has crm_writes and five slots per entity type.
      const {
        rows: [field],
      } = await client.query<{ id: string }>(
        `insert into public.custom_field_definitions
           (organisation_id, entity_type, key, label, field_type)
         values ($1, 'financial_entry', 'contract_ref', 'Contract ref', 'text')
         returning id`,
        [org],
      );
      expect(field!.id, "Starter may define a financial_entry field").toBeTruthy();

      // THE LINE IS NOT. Owner holds manage_finance, so the only term that can
      // be refusing is finance_module_organisations().
      await expect(
        client.query(
          `insert into public.financial_entries
             (organisation_id, created_by, event_id, category, status,
              amount_minor, currency, occurred_on)
           values ($1, $2, $3, 'fee', 'budgeted', 100000, 'GBP', current_date)`,
          [org, ownerUid, ev!.id],
        ),
        "Starter has no finance module, so no financial_entries row can exist",
      ).rejects.toThrow();
    } finally {
      await client.query("rollback").catch(() => {});
      client.release();
    }
  });

  it("a DOWNGRADED org's financial_entry VALUE write is refused on a REAL surviving line", async () => {
    // REVIEW FINDING I1, AND THE TEST THAT USED TO HIDE IT. The earlier version
    // of this case wrote against a nonexistent entity id, on the argument that
    // "no financial_entries row exists in a Starter org" -- which is true only
    // of an org that was NEVER Pro, and false of the case Q67 exists to
    // describe. A Pro org that DOWNGRADES keeps its finance lines (downgrading
    // must never silently delete data), so it keeps a LIVE, MANAGEABLE finance
    // row -- and before 20260903030000 it kept the ability to write
    // custom-field values against it, because the deployed custom_field_values
    // write policies gate on crm_write_organisations() and Starter has
    // crm_writes = true.
    //
    // So this walks the real chain: subscribe PRO, write the line and its
    // value, DOWNGRADE to starter, and then assert -- in that order, because a
    // refusal aborts the transaction and everything that needs the session
    // alive has to happen first:
    //   1. the line and its value still READ (Q67, reads survive a downgrade);
    //   2. an `event` custom-field value write by the SAME user in the SAME
    //      instant still succeeds -- Starter keeps crm_writes, so this is what
    //      makes the refusal below about the FINANCE MODULE rather than about a
    //      Starter org that can write no custom-field values at all;
    //   3. the financial_entry value write is REFUSED.
    const client = await pool.connect();
    try {
      await client.query("begin");

      const org = await createOrg(client, "Downgraded value probe");
      await subscribe(client, org, "pro");
      const ownerUid = await createUser(client, "cfv-downgrade-");
      await client.query(
        `insert into public.organisation_memberships
           (organisation_id, user_id, role, status, joined_at)
         values ($1, $2, 'owner', 'active', now())`,
        [org, ownerUid],
      );
      const {
        rows: [ids],
      } = await client.query<{ ev: string; fe: string }>(
        `with e as (
           insert into public.events (organisation_id, owner_user_id, name, starts_at)
           values ($1, $2, 'Downgrade event', now()) returning id
         ), f as (
           insert into public.financial_entries
             (organisation_id, created_by, event_id, category, status,
              amount_minor, currency, occurred_on)
           select $1, $2, e.id, 'fee', 'budgeted', 100000, 'GBP', current_date
             from e returning id
         )
         select (select id from e) as ev, (select id from f) as fe`,
        [org, ownerUid],
      );

      await actAs(client, ownerUid, "aal2");
      const {
        rows: [fields],
      } = await client.query<{ fin: string; ev: string }>(
        `with f as (
           insert into public.custom_field_definitions
             (organisation_id, entity_type, key, label, field_type)
           values ($1, 'financial_entry', 'contract_ref', 'Contract ref', 'text')
           returning id
         ), e as (
           insert into public.custom_field_definitions
             (organisation_id, entity_type, key, label, field_type)
           values ($1, 'event', 'promoter_ref', 'Promoter ref', 'text')
           returning id
         )
         select (select id from f) as fin, (select id from e) as ev`,
        [org],
      );

      // WHILE PRO: the finance value write works. This is the denominator --
      // without it, the refusal after the downgrade could be a fixture that
      // never worked in the first place.
      expect(
        await setValue(
          client,
          org,
          "financial_entry",
          ids!.fe,
          fields!.fin,
          "CC-PRO",
        ),
        "on Pro, the same user writes the same value on the same line",
      ).toBe(1);

      // THE DOWNGRADE. Nothing else changes: finance_module goes false,
      // crm_writes stays true.
      await stopActing(client);
      await client.query(
        `update public.organisation_subscriptions set plan_id = 'starter'
          where organisation_id = $1`,
        [org],
      );
      await actAs(client, ownerUid, "aal2");

      // 1. READS SURVIVE (Q67) -- the line and the value are both still there.
      const {
        rows: [lines],
      } = await client.query<{ n: string }>(
        `select count(*)::text as n from public.financial_entries where id = $1`,
        [ids!.fe],
      );
      expect(lines!.n, "the downgrade deleted no finance line").toBe("1");
      expect(
        await readValues(client, org, "financial_entry", ids!.fe),
        "and the custom-field value written on Pro still reads back",
      ).toEqual(['"CC-PRO"']);

      // 2. THE NON-VACUITY CONTROL, in the same session, after the downgrade.
      expect(
        await setValue(client, org, "event", ids!.ev, fields!.ev, "P-1"),
        "Starter keeps crm_writes, so an EVENT custom-field value still writes",
      ).toBe(1);

      // 3. THE REFUSAL. Same user, same org, same RPC, same live line -- the
      // only term that changed is finance_module.
      await expect(
        setValue(
          client,
          org,
          "financial_entry",
          ids!.fe,
          fields!.fin,
          "CC-STARTER",
        ),
        "the finance_module conjunct on entity_is_manageable's financial_entry " +
          "arm refuses the write the downgrade should have closed",
      ).rejects.toThrow();
    } finally {
      await client.query("rollback").catch(() => {});
      client.release();
    }
  });
});

describe("the financial_entry arms name the FINANCE permission keys", () => {
  /**
   * entity type -> the permission key its arm names, sliced arm by arm out of
   * the DEPLOYED body. Six of the seven arms also carry
   * full_scope_organisations() and a table name, so a whole-body regexp would
   * pair the wrong two strings. Same shaping as
   * permission-for-entity-matches-db.test.ts's armKeys.
   */
  async function armKeys(proname: string): Promise<Record<string, string>> {
    const { rows } = await pool.query<{ def: string }>(
      `select pg_get_functiondef(p.oid) as def
         from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'private' and p.proname = $1`,
      [proname],
    );
    expect(rows, `private.${proname}() is not in the catalogue`).toHaveLength(1);
    const def = rows[0]!.def;
    const out: Record<string, string> = {};
    const arms = [...def.matchAll(/when\s+'([^']+)'\s+then/g)];
    for (const [i, m] of arms.entries()) {
      const to = i + 1 < arms.length ? arms[i + 1]!.index! : def.length;
      const key = def
        .slice(m.index!, to)
        .match(/permitted_organisations\('([^']+)'\)/);
      if (key) out[m[1]!] = key[1]!;
    }
    return out;
  }

  it("entity_is_visible: financial_entry -> view_finance, and event -> view_crm", async () => {
    // FINANCE IS THE ONE EXCEPTION to "view_crm reads everything", so the event
    // arm beside it is the denominator: an extractor that returned the same
    // string for every arm, or a body whose finance arm was copy-pasted from
    // the event arm, fails one of these two.
    const keys = await armKeys("entity_is_visible");
    expect(keys.financial_entry).toBe("view_finance");
    expect(keys.event).toBe("view_crm");
  });

  it("entity_is_manageable: financial_entry -> manage_finance, matching the TS mirror", async () => {
    const keys = await armKeys("entity_is_manageable");
    expect(keys.financial_entry).toBe("manage_finance");
    expect(keys.event).toBe("manage_events");
    // The TypeScript half, which decides which sentence a blocked user reads.
    // permission-for-entity-matches-db.test.ts binds the WHOLE map; this pins
    // the entry this task added, beside the SQL it has to agree with.
    expect(PERMISSION_FOR_ENTITY.financial_entry).toBe("manage_finance");
  });
});
