// THE LINK-TARGET ALLOWLIST, WRITTEN FOUR TIMES IN SQL, BOUND TO ONE CONSTANT.
//
// The four *_links tables (20260902002000) each carry an identical CHECK on
// `entity_type`, allowlisting the six major CRM entities. lib/crm/links.ts's
// LINK_ENTITY_TYPES is the TypeScript mirror the picker and write path read.
//
// THIS TEST'S WHOLE JOB is that the four constraints and the constant stay
// IDENTICAL. A widening of one link table that forgets the other three -- the
// exact mistake a copy-paste-per-table schema invites -- fails here, because
// the four sets are no longer equal to each other. Same treatment as
// event-vocabularies and operations-vocabularies.
//
// READ OUT OF THE LIVE CATALOGUE, not the migration text.
import { afterAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { getLocalSupabaseStatus } from "../rls/support/env";
import { LINK_ENTITY_TYPES } from "@/lib/crm/links";

const pool = new Pool({ connectionString: getLocalSupabaseStatus().dbUrl });

afterAll(async () => {
  await pool.end();
});

const LINK_TABLES = [
  "task_links",
  "meeting_links",
  "note_links",
  "document_links",
] as const;

const CONSTRAINTS = LINK_TABLES.map((t) => ({
  relname: t,
  conname: `${t}_entity_type_check`,
}));

function literals(definition: string): string[] {
  return [...definition.matchAll(/'([^']*)'/g)]
    .map((match) => match[1])
    .filter((value) => value !== "text");
}

async function constraintDef(
  relname: string,
  conname: string,
): Promise<string | null> {
  const { rows } = await pool.query<{ def: string }>(
    `select pg_get_constraintdef(c.oid) as def
       from pg_constraint c
       join pg_class t on t.oid = c.conrelid
       join pg_namespace n on n.oid = t.relnamespace
      where n.nspname = 'public' and t.relname = $1 and c.conname = $2`,
    [relname, conname],
  );
  return rows.length === 1 ? rows[0].def : null;
}

describe("all four *_links entity_type allowlists are identical and equal LINK_ENTITY_TYPES", () => {
  it("finds all four constraints, so this cannot pass vacuously", async () => {
    const { rows } = await pool.query<{ relname: string; conname: string }>(
      `select t.relname, c.conname
         from pg_constraint c
         join pg_class t on t.oid = c.conrelid
         join pg_namespace n on n.oid = t.relnamespace
        where n.nspname = 'public' and c.conname = any($1::text[])`,
      [CONSTRAINTS.map((c) => c.conname)],
    );
    expect(rows.map((r) => `${r.relname}.${r.conname}`).sort()).toEqual(
      CONSTRAINTS.map((c) => `${c.relname}.${c.conname}`).sort(),
    );
    // THE DENOMINATOR. Four link tables, four allowlists.
    expect(rows).toHaveLength(4);
  });

  it("each of the four lists exactly LINK_ENTITY_TYPES", async () => {
    for (const { relname, conname } of CONSTRAINTS) {
      const def = await constraintDef(relname, conname);
      expect(def, `${conname} not found on public.${relname}`).not.toBeNull();
      expect(
        literals(def as string).sort(),
        `${conname} and LINK_ENTITY_TYPES in lib/crm/links.ts disagree`,
      ).toEqual([...LINK_ENTITY_TYPES].sort());
    }
  });

  it("all four are identical to EACH OTHER -- a one-table widening is caught here", async () => {
    // The point of the file. If a future migration adds 'note' to
    // document_links only, this set has size two and the assertion fails,
    // naming the drift even if someone also (wrongly) edited LINK_ENTITY_TYPES.
    const sets = new Set<string>();
    for (const { relname, conname } of CONSTRAINTS) {
      const def = await constraintDef(relname, conname);
      sets.add(JSON.stringify(literals(def as string).sort()));
    }
    expect(
      sets.size,
      "the four *_links entity_type allowlists are not identical -- one was " +
        "widened (or narrowed) without the other three",
    ).toBe(1);
  });

  it("a value in the allowlist inserts and one outside it is refused (23514)", async () => {
    // THE BEHAVIOURAL HALF, on task_links as the representative. entity_id has
    // NO foreign key (the target is polymorphic and validated by the policy,
    // not the constraint), so as `postgres` -- no policy in play -- a random
    // uuid target is fine and the ONLY thing under test is the entity_type
    // CHECK. Inside a rolled-back transaction.
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query(
        `insert into public.organisations (id, name, slug)
         values ('44220000-0000-0000-0000-0000000000f1', 'Link Allowlist Org', 'link-allowlist-org')`,
      );
      await client.query(
        `insert into public.tasks (id, organisation_id, title)
         values ('44220000-0000-0000-0000-0000000000f2',
                 '44220000-0000-0000-0000-0000000000f1', 'Parent Task')`,
      );
      const org = "44220000-0000-0000-0000-0000000000f1";
      const parent = "44220000-0000-0000-0000-0000000000f2";

      for (const type of LINK_ENTITY_TYPES) {
        await expect(
          client.query(
            `insert into public.task_links (organisation_id, parent_id, entity_type, entity_id)
             values ($1, $2, $3, gen_random_uuid())`,
            [org, parent, type],
          ),
          `entity_type '${type}' is in LINK_ENTITY_TYPES but task_links_entity_type_check refuses it`,
        ).resolves.toBeDefined();
      }

      // 'note' is deliberately NOT in the allowlist (Q49). The paired negative
      // is also the proof the CHECK still exists at all.
      await expect(
        client.query(
          `insert into public.task_links (organisation_id, parent_id, entity_type, entity_id)
           values ($1, $2, 'note', gen_random_uuid())`,
          [org, parent],
        ),
        "task_links_entity_type_check accepted 'note' -- the constraint is gone " +
          "or the operational allowlist decision (Q49) was reversed",
      ).rejects.toMatchObject({ code: "23514" });
    } finally {
      await client.query("rollback");
      client.release();
    }
  });
});
