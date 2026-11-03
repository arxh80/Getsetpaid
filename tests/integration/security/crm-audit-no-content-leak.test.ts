// THE NO-CONTENT-LEAK PROPERTY OF CRM WRITE AUDITING, DRIVEN OVER REAL
// PostgREST BY A REAL MEMBER -- the request a script sends, never the form.
//
// Phase 7 Task 6b put an AFTER INSERT OR UPDATE audit trigger on the eleven
// mutable CRM tables (20260912000000). audit_events is readable by the platform
// superuser, and CLAUDE.md § Superuser dashboard forbids tenant record content
// on that surface, so the ONE property that matters most is: an UPDATE that
// changes a content column produces a row that NAMES the column and never
// carries its old or new value. rls_phase7_crm_audit.sql § CU proves it from
// `set role authenticated` in psql; this file proves the same thing from the
// attacker's position -- a supabase-js client signed in as an active member
// of org A, PATCHing straight at /rest/v1/<table>, for every one of the eleven
// tables, with a sentinel that appears nowhere else in the database. The audit
// rows are then read STRAIGHT OUT OF POSTGRES (a pool as postgres), so no UI
// or policy can hide a false negative.
//
// tests/integration/security/feedback-budget.test.ts is the sibling and the
// template for the fixture lifecycle.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  createFixtures,
  destroyFixtures,
  type RlsFixtures,
} from "../rls/support/fixtures";

let fx: RlsFixtures;
let pool: Pool;
let manager: SupabaseClient;
let admin: SupabaseClient;

const SENTINEL = "QZKV-LEAK-PROBE";

interface AuditRow {
  action: string;
  target_type: string;
  organisation_id: string | null;
  actor_user_id: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  correlation_id: string;
}

async function latestRow(targetId: string): Promise<AuditRow> {
  const { rows } = await pool.query<AuditRow>(
    `select action, target_type, organisation_id, actor_user_id, before, after, correlation_id
       from public.audit_events where target_id = $1
      order by created_at desc, id desc limit 1`,
    [targetId],
  );
  expect(rows.length, `an audit row exists for ${targetId}`).toBe(1);
  return rows[0];
}

async function rowsFor(targetId: string): Promise<number> {
  const { rows } = await pool.query<{ n: string }>(
    `select count(*)::text as n from public.audit_events where target_id = $1`,
    [targetId],
  );
  return Number(rows[0].n);
}

function payloadText(row: AuditRow): string {
  return JSON.stringify(row.before ?? {}) + JSON.stringify(row.after ?? {});
}

/** One table under test: how to create it (as the member), which content
 *  column to poison, and one structural change with its expected old/new. */
interface Case {
  table: string;
  target: string;
  /** Who writes it: definitions need manage_custom_fields (admin). */
  who: () => SupabaseClient;
  create: (ids: Ids) => Record<string, unknown>;
  contentPatch: Record<string, unknown>;
  contentColumns: string[];
  structural?: {
    patch: (ids: Ids) => Record<string, unknown>;
    column: string;
    before: (ids: Ids) => unknown;
    after: (ids: Ids) => unknown;
  };
  softDeletable: boolean;
}

interface Ids {
  company: string;
  company2: string;
  contact: string;
  agency: string;
  artist: string;
  venue: string;
  venue2: string;
  room: string;
  representation: string;
  fee: string;
  link: string;
  definition: string;
  value: string;
}

const ids: Ids = {
  company: "", company2: "", contact: "", agency: "", artist: "", venue: "", venue2: "",
  room: "", representation: "", fee: "", link: "", definition: "", value: "",
};

beforeAll(async () => {
  fx = await createFixtures();
  pool = fx._pool;
  manager = fx.activeByRole.manager.client;
  admin = fx.activeByRole.admin.client;

  const insert = async (client: SupabaseClient, table: string, row: Record<string, unknown>) => {
    const { data, error } = await client.from(table).insert(row).select("id").single();
    if (error) throw new Error(`fixture insert ${table}: ${error.message}`);
    return (data as { id: string }).id;
  };
  const org = fx.orgA.id;
  const owner = fx.activeByRole.manager.userId;
  ids.company = await insert(manager, "companies", { organisation_id: org, owner_user_id: owner, name: "Leak Co", type: ["promoter"] });
  ids.company2 = await insert(manager, "companies", { organisation_id: org, owner_user_id: owner, name: "Leak Co Two" });
  ids.contact = await insert(manager, "contacts", { organisation_id: org, owner_user_id: owner, name: "Leak Contact" });
  ids.agency = await insert(manager, "agencies", { organisation_id: org, owner_user_id: owner, name: "Leak Agency" });
  ids.artist = await insert(manager, "artists", { organisation_id: org, owner_user_id: owner, name: "Leak Artist" });
  ids.venue = await insert(manager, "venues", { organisation_id: org, owner_user_id: owner, name: "Leak Venue" });
  ids.venue2 = await insert(manager, "venues", { organisation_id: org, owner_user_id: owner, name: "Leak Venue Two" });
  ids.room = await insert(manager, "venue_rooms", { organisation_id: org, venue_id: ids.venue, name: "Leak Room" });
  ids.representation = await insert(manager, "artist_representations", { organisation_id: org, artist_id: ids.artist, agency_id: ids.agency, role: "agent" });
  ids.fee = await insert(manager, "artist_fee_history", { organisation_id: org, artist_id: ids.artist, occurred_on: "2026-01-10", currency: "GBP", amount_minor: 150000, note: "seed" });
  ids.link = await insert(manager, "contact_companies", { organisation_id: org, contact_id: ids.contact, company_id: ids.company, is_primary: true });
  ids.definition = await insert(admin, "custom_field_definitions", { organisation_id: org, entity_type: "contact", key: "leak_probe", label: "Leak probe", field_type: "text" });
  ids.value = await insert(manager, "custom_field_values", { organisation_id: org, field_id: ids.definition, entity_type: "contact", entity_id: ids.contact, value: "seed" });
});

afterAll(async () => {
  if (fx) await destroyFixtures(fx); // cascades every CRM row via the org, and the audit rows explicitly
});

const CASES: Case[] = [
  {
    table: "companies", target: "company", who: () => manager,
    create: () => ({}), contentPatch: { name: `${SENTINEL} Co` }, contentColumns: ["name"],
    structural: { patch: () => ({ type: ["promoter", "supplier"] }), column: "type", before: () => ["promoter"], after: () => ["promoter", "supplier"] },
    softDeletable: true,
  },
  {
    table: "contacts", target: "contact", who: () => manager,
    create: () => ({}), contentPatch: { email: `${SENTINEL.toLowerCase()}@leak.test`, phone: `${SENTINEL}-1`, title: SENTINEL, tags: [SENTINEL] }, contentColumns: ["email", "phone", "tags", "title"],
    structural: { patch: () => ({ owner_user_id: fx.activeByRole.booker.userId }), column: "owner_user_id", before: () => fx.activeByRole.manager.userId, after: () => fx.activeByRole.booker.userId },
    softDeletable: true,
  },
  {
    table: "agencies", target: "agency", who: () => manager,
    create: () => ({}), contentPatch: { name: `${SENTINEL} Agency` }, contentColumns: ["name"], softDeletable: true,
  },
  {
    table: "artists", target: "artist", who: () => manager,
    create: () => ({}), contentPatch: { notes: SENTINEL, genres: [SENTINEL], socials: { instagram: SENTINEL } }, contentColumns: ["genres", "notes", "socials"], softDeletable: true,
  },
  {
    table: "venues", target: "venue", who: () => manager,
    create: () => ({}), contentPatch: { address: SENTINEL, technical_info: SENTINEL, capacity: 4321 }, contentColumns: ["address", "capacity", "technical_info"], softDeletable: true,
  },
  {
    table: "venue_rooms", target: "venue_room", who: () => manager,
    create: () => ({}), contentPatch: { name: `${SENTINEL} Room` }, contentColumns: ["name"],
    structural: { patch: (i) => ({ venue_id: i.venue2 }), column: "venue_id", before: (i) => i.venue, after: (i) => i.venue2 },
    softDeletable: true,
  },
  {
    table: "artist_representations", target: "artist_representation", who: () => manager,
    create: () => ({}), contentPatch: { role: SENTINEL, territory: SENTINEL }, contentColumns: ["role", "territory"],
    structural: { patch: () => ({ ended_at: "2026-12-31" }), column: "ended_at", before: () => null, after: () => "2026-12-31" },
    softDeletable: true,
  },
  {
    table: "artist_fee_history", target: "artist_fee", who: () => manager,
    create: () => ({}), contentPatch: { note: SENTINEL, amount_minor: 987654 }, contentColumns: ["amount_minor", "note"],
    structural: { patch: () => ({ currency: "EUR" }), column: "currency", before: () => "GBP", after: () => "EUR" },
    softDeletable: true,
  },
  {
    table: "contact_companies", target: "contact_company", who: () => manager,
    create: () => ({}), contentPatch: {}, contentColumns: [],
    structural: { patch: () => ({ is_primary: false }), column: "is_primary", before: () => true, after: () => false },
    softDeletable: false,
  },
  {
    table: "custom_field_definitions", target: "custom_field_definition", who: () => admin,
    create: () => ({}), contentPatch: { label: SENTINEL }, contentColumns: ["label"], softDeletable: true,
  },
  {
    table: "custom_field_values", target: "custom_field_value", who: () => manager,
    create: () => ({}), contentPatch: { value: SENTINEL }, contentColumns: ["value"], softDeletable: false,
  },
];

function idFor(c: Case): string {
  switch (c.table) {
    case "companies": return ids.company;
    case "contacts": return ids.contact;
    case "agencies": return ids.agency;
    case "artists": return ids.artist;
    case "venues": return ids.venue;
    case "venue_rooms": return ids.room;
    case "artist_representations": return ids.representation;
    case "artist_fee_history": return ids.fee;
    case "contact_companies": return ids.link;
    case "custom_field_definitions": return ids.definition;
    case "custom_field_values": return ids.value;
  }
  throw new Error(`no id for ${c.table}`);
}

describe("INSERT over PostgREST is audited: id, org, actor, structural values, no content", () => {
  it("the fixture INSERTs above each produced exactly one <target>.created row attributed to the writer", async () => {
    for (const c of CASES) {
      const id = idFor(c);
      const row = await latestRow(id);
      expect(row.action, c.table).toBe(`${c.target}.created`);
      expect(row.target_type).toBe(c.target);
      expect(row.organisation_id).toBe(fx.orgA.id);
      expect(row.actor_user_id).toBe(c.who() === admin ? fx.activeByRole.admin.userId : fx.activeByRole.manager.userId);
      expect(row.before).toBeNull();
      expect(row.after).toHaveProperty("values");
      expect(row.after).not.toHaveProperty("changed");
      // The names typed into the fixtures ("Leak Co", "Leak Contact", "seed") are
      // content: none of them may be in the row.
      expect(payloadText(row)).not.toMatch(/Leak |seed|agent/);
    }
  });
});

describe("UPDATE over PostgREST: changed names, values for the allowlist only, NO CONTENT LEAK", () => {
  for (const c of CASES) {
    if (c.contentColumns.length > 0) {
      it(`${c.table}: a content-column PATCH names ${c.contentColumns.join("/")} and carries no value`, async () => {
        const id = idFor(c);
        const { error } = await c.who().from(c.table).update(c.contentPatch).eq("id", id);
        expect(error).toBeNull();
        const row = await latestRow(id);
        expect(row.action).toBe(`${c.target}.updated`);
        expect((row.after as { changed: string[] }).changed).toEqual(c.contentColumns);
        expect(payloadText(row)).not.toContain(SENTINEL);
        expect(payloadText(row)).not.toContain(SENTINEL.toLowerCase());
        if (c.table === "venues") expect(payloadText(row)).not.toContain("4321");
        if (c.table === "artist_fee_history") expect(payloadText(row)).not.toContain("987654");
        expect((row.after as { values: object }).values).toEqual({});
        expect((row.before as { values: object }).values).toEqual({});
      });
    }

    if (c.structural) {
      const s = c.structural;
      it(`${c.table}: a structural PATCH carries old and new ${s.column}`, async () => {
        const id = idFor(c);
        const { error } = await c.who().from(c.table).update(s.patch(ids)).eq("id", id);
        expect(error).toBeNull();
        const row = await latestRow(id);
        expect(row.action).toBe(`${c.target}.updated`);
        expect((row.after as { changed: string[] }).changed).toEqual([s.column]);
        expect((row.before as { values: Record<string, unknown> }).values[s.column]).toEqual(s.before(ids));
        expect((row.after as { values: Record<string, unknown> }).values[s.column]).toEqual(s.after(ids));
      });
    }
  }

  it("a PATCH that changes nothing writes no row", async () => {
    const before = await rowsFor(ids.agency);
    const { error } = await manager.from("agencies").update({ name: `${SENTINEL} Agency` }).eq("id", ids.agency);
    expect(error).toBeNull();
    expect(await rowsFor(ids.agency)).toBe(before);
  });
});

describe("soft-delete and restore are their own actions", () => {
  for (const c of CASES.filter((c) => c.softDeletable)) {
    it(`${c.table}: deleted_at null -> now is ${c.target}.soft_deleted, and back is ${c.target}.restored`, async () => {
      const id = idFor(c);
      // Children before parents: the representation's, fee's and room's
      // UPDATE policies require a live parent, so the loop order in CASES
      // (parents first) is wrong for deletion -- each case restores itself
      // before the next runs, so the parent is live again by then.
      const del = await c.who().from(c.table).update({ deleted_at: new Date().toISOString() }).eq("id", id);
      expect(del.error).toBeNull();
      const gone = await latestRow(id);
      expect(gone.action).toBe(`${c.target}.soft_deleted`);
      expect((gone.after as { changed: string[] }).changed).toEqual(["deleted_at"]);
      expect((gone.before as { values: Record<string, unknown> }).values.deleted_at).toBeNull();
      expect((gone.after as { values: Record<string, unknown> }).values.deleted_at).not.toBeNull();

      const back = await c.who().from(c.table).update({ deleted_at: null }).eq("id", id);
      expect(back.error).toBeNull();
      const restored = await latestRow(id);
      expect(restored.action).toBe(`${c.target}.restored`);
      expect((restored.after as { values: Record<string, unknown> }).values.deleted_at).toBeNull();
    });
  }
});

describe("bulk RPCs share one correlation id", () => {
  it("set_contact_primary_company: the demote and the promote are one thread", async () => {
    const { error: linkErr } = await manager.from("contact_companies").insert({
      organisation_id: fx.orgA.id, contact_id: ids.contact, company_id: ids.company2, is_primary: false,
    });
    expect(linkErr).toBeNull();
    // ids.link was demoted to is_primary=false by the structural case above;
    // make it primary again so the RPC has something to demote.
    await manager.from("contact_companies").update({ is_primary: true }).eq("id", ids.link);

    // A marker from the database's own clock, taken AFTER the fix-ups above
    // and BEFORE the RPC, so the window holds exactly the RPC's rows.
    const { rows: mark } = await pool.query<{ t: string }>(`select clock_timestamp()::text as t`);

    const { data, error } = await manager.rpc("set_contact_primary_company", {
      p_contact_id: ids.contact, p_company_id: ids.company2, p_organisation_id: fx.orgA.id,
    });
    expect(error).toBeNull();
    expect(data).toBe(1);

    const { rows } = await pool.query<{ n: string; threads: string }>(
      `select count(*)::text as n, count(distinct correlation_id)::text as threads
         from public.audit_events
        where action = 'contact_company.updated' and organisation_id = $1
          and created_at >= $3::timestamptz
          and target_id in (select id from public.contact_companies where contact_id = $2)`,
      [fx.orgA.id, ids.contact, mark[0].t],
    );
    expect(rows[0].n).toBe("2");
    expect(rows[0].threads).toBe("1");
  });

  it("the moved bodies are not routable: rpc/merge_records_unthreaded is 404", async () => {
    const { error } = await manager.rpc("merge_records_unthreaded", {});
    expect(error).not.toBeNull();
    expect(String(error?.code)).toMatch(/PGRST202|404/);
  });
});
