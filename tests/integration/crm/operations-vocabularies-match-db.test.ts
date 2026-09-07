// THE FIVE OPERATIONS VOCABULARIES, WRITTEN IN SQL, BOUND HERE.
//
// `tasks_status_check`, `tasks_priority_check`, `meetings_status_check`,
// `notes_visibility_check` and `documents_scan_status_check` are the
// enforcement (20260902000000, 20260902001000). `TASK_STATUSES`,
// `TASK_PRIORITIES`, `MEETING_STATUSES`, `NOTE_VISIBILITIES` and `SCAN_STATUSES`
// in lib/crm/task-status.ts are the copy the create/edit form's <select> and
// the filters read, because a request cannot consult a CHECK constraint.
//
// WHAT DRIFT COSTS, in each direction:
//
//   a value in SQL and not in TypeScript   a row the database holds happily
//                                          that no form can produce and no
//                                          filter can select.
//   a value in TypeScript and not in SQL   a <select> option that raises
//                                          23514 on submit.
//
// READ OUT OF THE LIVE CATALOGUE (pg_get_constraintdef), not the migration
// text: a later migration can drop and re-add a constraint, and what is
// deployed is what decides. Same treatment as
// tests/integration/crm/event-vocabularies-match-db.test.ts.
import { afterAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { getLocalSupabaseStatus } from "../rls/support/env";
import {
  MEETING_STATUSES,
  NOTE_VISIBILITIES,
  SCAN_STATUSES,
  TASK_PRIORITIES,
  TASK_STATUSES,
} from "@/lib/crm/task-status";

const pool = new Pool({ connectionString: getLocalSupabaseStatus().dbUrl });

afterAll(async () => {
  await pool.end();
});

/**
 * The quoted literals in a CHECK definition. `pg_get_constraintdef` renders an
 * `in (...)` allowlist as `CHECK ((status = ANY (ARRAY['open'::text, ...])))`,
 * so the values are exactly the single-quoted runs with the `text` casts
 * filtered out.
 */
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
      where n.nspname = 'public'
        and t.relname = $1
        and c.conname = $2`,
    [relname, conname],
  );
  return rows.length === 1 ? rows[0].def : null;
}

const CASES = [
  {
    relname: "tasks",
    conname: "tasks_status_check",
    constant: "TASK_STATUSES",
    values: TASK_STATUSES as readonly string[],
  },
  {
    relname: "tasks",
    conname: "tasks_priority_check",
    constant: "TASK_PRIORITIES",
    values: TASK_PRIORITIES as readonly string[],
  },
  {
    relname: "meetings",
    conname: "meetings_status_check",
    constant: "MEETING_STATUSES",
    values: MEETING_STATUSES as readonly string[],
  },
  {
    relname: "notes",
    conname: "notes_visibility_check",
    constant: "NOTE_VISIBILITIES",
    values: NOTE_VISIBILITIES as readonly string[],
  },
  {
    relname: "documents",
    conname: "documents_scan_status_check",
    constant: "SCAN_STATUSES",
    values: SCAN_STATUSES as readonly string[],
  },
] as const;

describe("the operations vocabularies agree with their CHECK constraints", () => {
  it("finds all five constraints, on the tables that carry them, so this cannot pass vacuously", async () => {
    const { rows } = await pool.query<{ relname: string; conname: string }>(
      `select t.relname, c.conname
         from pg_constraint c
         join pg_class t on t.oid = c.conrelid
         join pg_namespace n on n.oid = t.relnamespace
        where n.nspname = 'public' and c.conname = any($1::text[])`,
      [CASES.map((c) => c.conname)],
    );
    expect(rows.map((r) => `${r.relname}.${r.conname}`).sort()).toEqual(
      CASES.map((c) => `${c.relname}.${c.conname}`).sort(),
    );
    // THE DENOMINATOR, written out. Five constraints across four tables.
    expect(rows).toHaveLength(5);
  });

  for (const { relname, conname, constant, values } of CASES) {
    it(`${conname} lists exactly ${constant}`, async () => {
      const def = await constraintDef(relname, conname);
      expect(def, `${conname} not found on public.${relname}`).not.toBeNull();

      // Sorted, because the constraint's order is a migration detail and the
      // TypeScript tuple's order is a UI one. What has to match is the SET.
      expect(
        literals(def as string).sort(),
        `${conname} and ${constant} in lib/crm/task-status.ts disagree. A ` +
          "value in only one of them is either a row no form can create or a " +
          "form option that raises 23514 on submit.",
      ).toEqual([...values].sort());
    });
  }

  it("the CHECK definitions really contain literals, not zero of them", async () => {
    // NON-VACUITY: the two-value notes_visibility set is the tightest, so the
    // threshold is >= 2, not > 1, for that one -- expressed as > 1 covers it.
    for (const { relname, conname } of CASES) {
      const def = await constraintDef(relname, conname);
      expect(literals(def as string).length, conname).toBeGreaterThan(1);
    }
  });

  it("every task/meeting/note/document value is insertable, and nothing else is", async () => {
    // THE BEHAVIOURAL HALF. The comparisons above are about TEXT: they would
    // pass against a CHECK whose rendering listed the right values while the
    // expression did something else. This drives the constraints. As
    // `postgres`, inside one rolled-back transaction, so no policy is in play
    // -- the claim under test is the CONSTRAINT, which binds every writer.
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query(
        `insert into public.organisations (id, name, slug)
         values ('44110000-0000-0000-0000-0000000000f1', 'Ops Vocab Org', 'ops-vocab-org')`,
      );
      const org = "44110000-0000-0000-0000-0000000000f1";

      for (const status of TASK_STATUSES) {
        await expect(
          client.query(
            `insert into public.tasks (organisation_id, title, status)
             values ($1, $2, $3)`,
            [org, `Task ${status}`, status],
          ),
          `task status '${status}' is in TASK_STATUSES but tasks_status_check refuses it`,
        ).resolves.toBeDefined();
      }
      for (const priority of TASK_PRIORITIES) {
        await expect(
          client.query(
            `insert into public.tasks (organisation_id, title, priority)
             values ($1, $2, $3)`,
            [org, `Task ${priority}`, priority],
          ),
          `task priority '${priority}' is in TASK_PRIORITIES but tasks_priority_check refuses it`,
        ).resolves.toBeDefined();
      }
      for (const status of MEETING_STATUSES) {
        await expect(
          client.query(
            `insert into public.meetings (organisation_id, title, starts_at, status)
             values ($1, $2, now(), $3)`,
            [org, `Meeting ${status}`, status],
          ),
          `meeting status '${status}' is in MEETING_STATUSES but meetings_status_check refuses it`,
        ).resolves.toBeDefined();
      }
      for (const visibility of NOTE_VISIBILITIES) {
        await expect(
          client.query(
            `insert into public.notes (organisation_id, body, visibility)
             values ($1, $2, $3)`,
            [org, `Note ${visibility}`, visibility],
          ),
          `note visibility '${visibility}' is in NOTE_VISIBILITIES but notes_visibility_check refuses it`,
        ).resolves.toBeDefined();
      }
      for (const scan of SCAN_STATUSES) {
        // scanned_at is required IFF the status is terminal
        // (documents_scanned_at_iff_terminal), so the fixture sets it to keep
        // the value under test the ONLY thing the insert exercises.
        const scannedAt = scan === "pending" ? null : new Date().toISOString();
        await expect(
          client.query(
            `insert into public.documents
               (organisation_id, filename, storage_key, mime_type, size_bytes, scan_status, scanned_at)
             values ($1, $2, $3, 'text/plain', 1, $4, $5)`,
            [org, `doc-${scan}`, `${org}/doc-${scan}`, scan, scannedAt],
          ),
          `scan_status '${scan}' is in SCAN_STATUSES but documents_scan_status_check refuses it`,
        ).resolves.toBeDefined();
      }

      // THE PAIRED NEGATIVES, one per constraint. Without them every assertion
      // above is satisfied by a CHECK that was dropped. Each runs inside its own
      // SAVEPOINT: a failed statement aborts the enclosing transaction (25P02),
      // so without a rollback-to-savepoint the second negative would fail for
      // the wrong reason.
      const negatives: Array<[string, string, unknown[]]> = [
        [
          "tasks_status_check accepted a value outside TASK_STATUSES",
          `insert into public.tasks (organisation_id, title, status)
           values ($1, 'Bad', 'not_a_status')`,
          [org],
        ],
        [
          "tasks_priority_check accepted a value outside TASK_PRIORITIES",
          `insert into public.tasks (organisation_id, title, priority)
           values ($1, 'Bad', 'not_a_priority')`,
          [org],
        ],
        [
          "meetings_status_check accepted a value outside MEETING_STATUSES",
          `insert into public.meetings (organisation_id, title, starts_at, status)
           values ($1, 'Bad', now(), 'not_a_status')`,
          [org],
        ],
        [
          "notes_visibility_check accepted a value outside NOTE_VISIBILITIES",
          `insert into public.notes (organisation_id, body, visibility)
           values ($1, 'Bad', 'not_a_visibility')`,
          [org],
        ],
        [
          "documents_scan_status_check accepted a value outside SCAN_STATUSES",
          `insert into public.documents
             (organisation_id, filename, storage_key, mime_type, size_bytes, scan_status)
           values ($1, 'Bad', $2, 'text/plain', 1, 'not_a_scan')`,
          [org, `${org}/bad`],
        ],
      ];
      for (const [message, sql, params] of negatives) {
        await client.query("savepoint neg");
        await expect(client.query(sql, params), message).rejects.toMatchObject({
          code: "23514",
        });
        await client.query("rollback to savepoint neg");
      }
    } finally {
      await client.query("rollback");
      client.release();
    }
  });
});
