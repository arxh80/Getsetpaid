// THE NO-CONTENT-LEAK PROPERTY OF CRM WRITE AUDITING FOR THE PHASE 3-6
// TABLES, DRIVEN OVER REAL PostgREST BY REAL MEMBERS (Phase 8 Task 7, Q122).
//
// 20261006000000 attached private.audit_crm_change() to sixteen more tables.
// The reason that migration exists is the sentence the brief opens with: "a
// raw PATCH /rest/v1/events by a valid member leaves no trace at all". So this
// file is that request -- a supabase-js client signed in as an active member,
// POSTing and PATCHing straight at /rest/v1/<table> -- for every Phase 3-6
// table a client can write, plus the membership escalation the derived census
// found. The audit rows are read STRAIGHT OUT OF POSTGRES (a pool as
// postgres), so no UI or policy can hide a false negative.
//
// Per table it asserts: the INSERT wrote exactly one <target>.created row
// with the writer as actor, org A as organisation and the right target type;
// after.values carries EXACTLY the keys private.audit_crm_value_columns()
// returns for that target (read from the database, so this file and
// tests/e2e/operations.spec.ts -- the SERVER-ACTION half -- are held to the
// same list, which is what "audited identically" means in a test); a PATCH
// of every free-text column NAMES each one and carries none; soft-delete and
// restore are their own actions. And the sentinel: planted in every free-text
// column, PROVED to be in the row first (a no-leak test against a row that
// never held the marker is a green test of nothing), then searched for in
// every audit row the run wrote.
//
// It also MEASURES the golden path's audit volume (Task 7 requirement 5):
// the rows and bytes one "event -> lineup -> task -> link -> complete -> note"
// walk now adds to audit_events.
//
// tests/integration/security/crm-audit-no-content-leak.test.ts is the Phase 2
// sibling and the template.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createFixtures, destroyFixtures, type RlsFixtures } from "../rls/support/fixtures";

let fx: RlsFixtures;
let pool: Pool;
let manager: SupabaseClient;
let finance: SupabaseClient;

const SENTINEL = "QZP36-LEAK-PROBE";
const SENTINEL_LC = SENTINEL.toLowerCase();

interface AuditRow {
  action: string;
  target_type: string;
  organisation_id: string | null;
  actor_user_id: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
}

let runStart = "";

async function rowsFor(targetId: string): Promise<AuditRow[]> {
  const { rows } = await pool.query<AuditRow>(
    `select action, target_type, organisation_id, actor_user_id, before, after
       from public.audit_events where target_id = $1
      order by created_at, id`,
    [targetId],
  );
  return rows;
}

async function latest(targetId: string): Promise<AuditRow> {
  const rows = await rowsFor(targetId);
  expect(rows.length, `an audit row exists for ${targetId}`).toBeGreaterThan(0);
  return rows[rows.length - 1];
}

async function allowlist(target: string): Promise<string[]> {
  const { rows } = await pool.query<{ c: string[] }>(
    `select private.audit_crm_value_columns($1) as c`,
    [target],
  );
  return [...rows[0].c].sort();
}

function payload(row: AuditRow): string {
  return JSON.stringify(row.before ?? {}) + JSON.stringify(row.after ?? {});
}

async function insert(client: SupabaseClient, table: string, row: Record<string, unknown>): Promise<string> {
  const { data, error } = await client.from(table).insert(row).select("id").single();
  if (error) throw new Error(`insert ${table}: ${error.message}`);
  return (data as { id: string }).id;
}

/** One table under test. `content` is every free-text column on it, with the
 *  sentinel value the PATCH writes; `inRow` proves the sentinel is in the
 *  stored row (as postgres) before any absence is asserted. */
interface Case {
  table: string;
  target: string;
  who: () => SupabaseClient;
  actor: () => string;
  id: () => string;
  content: Record<string, unknown>;
  softDeletable: boolean;
}

const ids: Record<string, string> = {};

beforeAll(async () => {
  fx = await createFixtures();
  pool = fx._pool;
  manager = fx.activeByRole.manager.client;
  finance = fx.activeByRole.finance.client;
  const { rows } = await pool.query<{ t: string }>(`select clock_timestamp()::text as t`);
  runStart = rows[0].t;

  const org = fx.orgA.id;
  const me = fx.activeByRole.manager.userId;
  // Parents (Phase 2 tables, already audited since Task 6b).
  ids.artist = await insert(manager, "artists", { organisation_id: org, owner_user_id: me, name: "P36 Artist" });
  ids.company = await insert(manager, "companies", { organisation_id: org, owner_user_id: me, name: "P36 Co" });
  // THE SIXTEEN, created with a sentinel in every free-text column.
  ids.event = await insert(manager, "events", {
    organisation_id: org, owner_user_id: me, name: `${SENTINEL} Night`, event_type: "club_night",
    status: "draft", starts_at: new Date(Date.now() + 10 * 864e5).toISOString(),
    location: `${SENTINEL} Loc`, ticket_link: `https://${SENTINEL_LC}.test/t`, notes: `${SENTINEL} notes`,
  });
  ids.lineup = await insert(manager, "event_lineup", {
    organisation_id: org, event_id: ids.event, artist_id: ids.artist, position: 1, billing: "headliner",
    notes: `${SENTINEL} lineup`,
  });
  ids.task = await insert(manager, "tasks", {
    organisation_id: org, owner_user_id: me, title: `${SENTINEL} task`, detail: `${SENTINEL} detail`,
  });
  ids.meeting = await insert(manager, "meetings", {
    organisation_id: org, owner_user_id: me, title: `${SENTINEL} meeting`,
    starts_at: new Date(Date.now() + 864e5).toISOString(), location: `${SENTINEL} room`,
    meeting_url: `https://${SENTINEL_LC}.test/m`, attendees: `${SENTINEL} One, ${SENTINEL} Two`,
    notes: `${SENTINEL} minutes`,
  });
  ids.note = await insert(manager, "notes", {
    organisation_id: org, owner_user_id: me, body: `${SENTINEL} a PRIVATE note body`, visibility: "private",
  });
  ids.document = await insert(manager, "documents", {
    organisation_id: org, owner_user_id: me, filename: `${SENTINEL} Contract - J Smith.pdf`,
    storage_key: `${org}/${SENTINEL}-${fx.runId}`, mime_type: "application/pdf", size_bytes: 4242,
  });
  ids.task_link = await insert(manager, "task_links", {
    organisation_id: org, parent_id: ids.task, entity_type: "event", entity_id: ids.event,
  });
  ids.financial_entry = await insert(finance, "financial_entries", {
    organisation_id: org, event_id: ids.event, category: "cost", status: "budgeted", amount_minor: 918273645,
    currency: "GBP", occurred_on: "2026-11-11", description: `${SENTINEL} desc`,
  });
  ids.network_profile = await insert(manager, "network_profiles", {
    organisation_id: org, entity_kind: "company", entity_id: ids.company, status: "draft",
    // Every field the PATCH below writes must be non-hidden, or
    // network_profiles_hidden_fields_are_null refuses it.
    field_visibility: { headline: "network", bio: "network", city: "network", region: "network", country: "network", website_url: "network", contact_email: "network" }, display_name: `${SENTINEL} Display`, headline: `${SENTINEL} head`,
    bio: `${SENTINEL} bio`, city: `${SENTINEL} city`,
  });
});

afterAll(async () => {
  if (fx) await destroyFixtures(fx); // audit rows by org/actor, then the orgs (cascade), then the users
});

const CASES: Case[] = [
  { table: "events", target: "event", who: () => manager, actor: () => fx.activeByRole.manager.userId, id: () => ids.event,
    content: { name: `${SENTINEL} Renamed`, location: `${SENTINEL} L2`, ticket_link: `https://${SENTINEL_LC}.test/t2`, notes: `${SENTINEL} n2` },
    softDeletable: true },
  { table: "event_lineup", target: "event_lineup", who: () => manager, actor: () => fx.activeByRole.manager.userId, id: () => ids.lineup,
    content: { notes: `${SENTINEL} lu2` }, softDeletable: true },
  { table: "tasks", target: "task", who: () => manager, actor: () => fx.activeByRole.manager.userId, id: () => ids.task,
    content: { title: `${SENTINEL} t2`, detail: `${SENTINEL} d2` }, softDeletable: true },
  { table: "meetings", target: "meeting", who: () => manager, actor: () => fx.activeByRole.manager.userId, id: () => ids.meeting,
    content: { title: `${SENTINEL} m2`, location: `${SENTINEL} ml2`, meeting_url: `https://${SENTINEL_LC}.test/m2`, attendees: `${SENTINEL} Three`, notes: `${SENTINEL} mn2` },
    softDeletable: true },
  { table: "notes", target: "note", who: () => manager, actor: () => fx.activeByRole.manager.userId, id: () => ids.note,
    content: { body: `${SENTINEL} rewritten private body` }, softDeletable: true },
  // documents: filename/storage_key are outside the UPDATE grant, so there is
  // no content PATCH to make -- the INSERT is the only moment either could
  // enter a row, and the INSERT assertions below cover it.
  { table: "documents", target: "document", who: () => manager, actor: () => fx.activeByRole.manager.userId, id: () => ids.document,
    content: {}, softDeletable: true },
  { table: "task_links", target: "task_link", who: () => manager, actor: () => fx.activeByRole.manager.userId, id: () => ids.task_link,
    content: {}, softDeletable: true },
  { table: "financial_entries", target: "financial_entry", who: () => finance, actor: () => fx.activeByRole.finance.userId, id: () => ids.financial_entry,
    content: { description: `${SENTINEL} desc2`, amount_minor: 546372819 }, softDeletable: true },
  { table: "network_profiles", target: "network_profile", who: () => manager, actor: () => fx.activeByRole.manager.userId, id: () => ids.network_profile,
    content: { display_name: `${SENTINEL} D2`, headline: `${SENTINEL} H2`, bio: `${SENTINEL} B2`, city: `${SENTINEL} C2`, region: `${SENTINEL} R2`, country: `${SENTINEL} K2`, website_url: `https://${SENTINEL_LC}.test/w`, contact_email: `${SENTINEL_LC}@p36.test` },
    softDeletable: true },
];

describe("INSERT over PostgREST is audited on every Phase 3-6 table: actor, org, type, allowlisted keys only", () => {
  it("DENOMINATOR: every fixture row really holds the sentinel before its audit row is searched", async () => {
    const probes: Array<[string, string, string]> = [
      ["events", ids.event, "name || location || ticket_link || notes"],
      ["event_lineup", ids.lineup, "notes"],
      ["tasks", ids.task, "title || detail"],
      ["meetings", ids.meeting, "title || location || meeting_url || attendees || notes"],
      ["notes", ids.note, "body"],
      ["documents", ids.document, "filename || storage_key"],
      ["financial_entries", ids.financial_entry, "description || amount_minor::text"],
      ["network_profiles", ids.network_profile, "display_name || headline || bio || city"],
    ];
    for (const [table, id, expr] of probes) {
      const { rows } = await pool.query<{ n: string }>(
        `select count(*)::text as n from public.${table} where id = $1 and (${expr}) ilike $2`,
        [id, `%${SENTINEL}%`],
      );
      expect(rows[0].n, `${table} holds the sentinel`).toBe("1");
    }
  });

  for (const target of ["event", "event_lineup", "task", "meeting", "note", "document", "task_link", "financial_entry", "network_profile"]) {
    it(`${target}: exactly one ${target}.created, attributed, keys === the database's allowlist, no sentinel`, async () => {
      const c = CASES.find((x) => x.target === target)!;
      const rows = await rowsFor(c.id());
      expect(rows.map((r) => r.action)).toEqual([`${target}.created`]);
      const r = rows[0];
      expect(r.actor_user_id).toBe(c.actor());
      expect(r.organisation_id).toBe(fx.orgA.id);
      expect(r.target_type).toBe(target);
      expect(r.before).toBeNull();
      const keys = Object.keys((r.after as { values: object }).values).sort();
      expect(keys).toEqual(await allowlist(target));
      expect(payload(r)).not.toContain(SENTINEL);
      expect(payload(r)).not.toContain(SENTINEL_LC);
      expect(payload(r)).not.toContain("918273645");
      expect(payload(r)).not.toContain("Smith");
    });
  }
});

describe("UPDATE over PostgREST: every free-text column NAMED, none VALUED", () => {
  for (const c of CASES.filter((x) => Object.keys(x.content).length > 0)) {
    it(`${c.table}: a PATCH of ${Object.keys(c.content).join("/")} names each and carries none`, async () => {
      const { error } = await c.who().from(c.table).update(c.content).eq("id", c.id());
      expect(error).toBeNull();
      const r = await latest(c.id());
      expect(r.action).toBe(`${c.target}.updated`);
      expect(r.actor_user_id).toBe(c.actor());
      expect((r.after as { changed: string[] }).changed).toEqual(Object.keys(c.content).sort());
      expect((r.after as { values: object }).values).toEqual({});
      expect((r.before as { values: object }).values).toEqual({});
      expect(payload(r)).not.toContain(SENTINEL);
      expect(payload(r)).not.toContain(SENTINEL_LC);
      expect(payload(r)).not.toContain("546372819");
    });
  }

  it("a structural PATCH carries old -> new: an event's status, a task's completion, a note's visibility", async () => {
    await manager.from("events").update({ status: "confirmed" }).eq("id", ids.event);
    let r = await latest(ids.event);
    expect((r.before as { values: Record<string, unknown> }).values.status).toBe("draft");
    expect((r.after as { values: Record<string, unknown> }).values.status).toBe("confirmed");

    await manager.from("tasks").update({ status: "done", completed_at: new Date().toISOString() }).eq("id", ids.task);
    r = await latest(ids.task);
    expect((r.after as { changed: string[] }).changed).toEqual(["completed_at", "status"]);
    expect((r.after as { values: Record<string, unknown> }).values.status).toBe("done");

    await manager.from("notes").update({ visibility: "company" }).eq("id", ids.note);
    r = await latest(ids.note);
    expect((r.before as { values: Record<string, unknown> }).values.visibility).toBe("private");
    expect((r.after as { values: Record<string, unknown> }).values.visibility).toBe("company");
  });

  it("a PATCH a member cannot make writes nothing: a filename rename is refused by the column grant", async () => {
    const before = (await rowsFor(ids.document)).length;
    const { error } = await manager.from("documents").update({ filename: `${SENTINEL} renamed.pdf` }).eq("id", ids.document);
    expect(error).not.toBeNull();
    expect((await rowsFor(ids.document)).length).toBe(before);
  });
});

describe("soft-delete and restore are their own actions on every soft-deletable Phase 3-6 table", () => {
  // Children first: a link's and a lineup row's UPDATE policies need a live parent.
  const order = ["task_links", "event_lineup", "financial_entries", "documents", "notes", "meetings", "tasks", "network_profiles", "events"];
  it("each soft-delete is <target>.soft_deleted and each restore <target>.restored", async () => {
    const cases = order.map((t) => CASES.find((c) => c.table === t)!);
    for (const c of cases) {
      const { error } = await c.who().from(c.table).update({ deleted_at: new Date().toISOString() }).eq("id", c.id());
      expect(error, c.table).toBeNull();
      expect((await latest(c.id())).action, c.table).toBe(`${c.target}.soft_deleted`);
    }
    for (const c of [...cases].reverse()) {
      const { error } = await c.who().from(c.table).update({ deleted_at: null }).eq("id", c.id());
      expect(error, c.table).toBeNull();
      expect((await latest(c.id())).action, c.table).toBe(`${c.target}.restored`);
    }
  });
});

describe("the membership escalation the derived census found", () => {
  it("an Admin's invite, role change and removal over PostgREST are three attributed rows carrying user/role/status", async () => {
    const admin = fx.activeByRole.admin;
    const invitee = fx.ownerB.userId;
    const { data, error } = await admin.client
      .from("organisation_memberships")
      .insert({ organisation_id: fx.orgA.id, user_id: invitee, role: "standard_user", status: "invited", invited_by: admin.userId })
      .select("id")
      .single();
    expect(error).toBeNull();
    const id = (data as { id: string }).id;
    expect((await admin.client.from("organisation_memberships").update({ role: "manager" }).eq("id", id)).error).toBeNull();
    expect((await admin.client.from("organisation_memberships").delete().eq("id", id)).error).toBeNull();
    const rows = await rowsFor(id);
    expect(rows.map((r) => r.action)).toEqual(["membership.created", "membership.updated", "membership.deleted"]);
    for (const r of rows) {
      expect(r.actor_user_id).toBe(admin.userId);
      expect(r.organisation_id).toBe(fx.orgA.id);
    }
    expect((rows[1].before as { values: Record<string, unknown> }).values.role).toBe("standard_user");
    expect((rows[1].after as { values: Record<string, unknown> }).values.role).toBe("manager");
    expect(Object.keys(rows[2].before ?? {}).sort()).toEqual(["role", "status", "user_id"]);
  });
});

describe("THE SWEEP and THE VOLUME", () => {
  it("no audit row written during this file carries the sentinel, in either case, or either amount -- over a non-empty window", async () => {
    const { rows } = await pool.query<{ total: string; hits: string }>(
      `select count(*)::text as total,
              count(*) filter (where (coalesce(before::text,'') || coalesce(after::text,'')) ilike $2
                                  or (coalesce(before::text,'') || coalesce(after::text,'')) ~ '(918273645|546372819)')::text as hits
         from public.audit_events where created_at >= $1::timestamptz and organisation_id = $3`,
      [runStart, `%${SENTINEL}%`, fx.orgA.id],
    );
    expect(Number(rows[0].total), "the window is populated").toBeGreaterThan(40);
    expect(rows[0].hits).toBe("0");
  });

  it("MEASURED: the golden path's Phase 3-6 walk (event, lineup, task, link, complete, note) writes 6 rows, and their size", async () => {
    // The walk the golden path names, over PostgREST, on fresh rows: create an
    // event, put the artist on the bill, add a task, link it to the event,
    // complete it, add a note. Before Task 7 every one of these six writes
    // left NO row. The number is asserted so a future trigger that fans out
    // (a second writer on a table, a cascade that audits) is a red number.
    const { rows: m } = await pool.query<{ t: string }>(`select clock_timestamp()::text as t`);
    const org = fx.orgA.id;
    const me = fx.activeByRole.manager.userId;
    const ev = await insert(manager, "events", { organisation_id: org, owner_user_id: me, name: "Golden Night", event_type: "club_night", status: "draft", starts_at: new Date(Date.now() + 20 * 864e5).toISOString() });
    await insert(manager, "event_lineup", { organisation_id: org, event_id: ev, artist_id: ids.artist, position: 1 });
    const tk = await insert(manager, "tasks", { organisation_id: org, owner_user_id: me, title: "Advance the settlement" });
    await insert(manager, "task_links", { organisation_id: org, parent_id: tk, entity_type: "event", entity_id: ev });
    expect((await manager.from("tasks").update({ status: "done", completed_at: new Date().toISOString() }).eq("id", tk)).error).toBeNull();
    await insert(manager, "notes", { organisation_id: org, owner_user_id: me, body: "Golden note", visibility: "company" });
    const { rows } = await pool.query<{ n: string; actions: string; bytes: string }>(
      `select count(*)::text as n,
              string_agg(action, ',' order by created_at, id) as actions,
              coalesce(sum(pg_column_size(e.*)), 0)::text as bytes
         from public.audit_events e
        where created_at >= $1::timestamptz and actor_user_id = $2`,
      [m[0].t, me],
    );
    expect(rows[0].actions).toBe("event.created,event_lineup.created,task.created,task_link.created,task.updated,note.created");
    expect(rows[0].n).toBe("6");
    // Heap bytes only (pg_column_size of the row), excluding indexes. The
    // Phase 8 inventory measured 472 B/row INCLUDING indexes; the number is
    // printed for the report rather than pinned, because it moves with uuid
    // and timestamp values rather than with any decision.
    console.info(`[p3-6 golden path] ${rows[0].n} audit rows, ${rows[0].bytes} heap bytes`);
    expect(Number(rows[0].bytes)).toBeGreaterThan(0);
  });
});
