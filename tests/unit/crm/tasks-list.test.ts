import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  MEETING_DELETED_LIST,
  MEETING_LIST,
  TASK_DELETED_LIST,
  TASK_LIST,
} from "@/lib/crm/tasks-list";
import { NOTE_DELETED_LIST, NOTE_LIST } from "@/lib/crm/notes-list";
import type { ListSpec, SortOption } from "@/lib/list/spec";
import { repoRoot as root } from "../../support/source";

// THE notNull SWEEP.
//
// ===========================================================================
// WHAT rule 9 IS AND WHY A TEST HAS TO CARRY IT
// ===========================================================================
// A keyset page compares `(sort column, id)` against the previous page's last
// row. Every comparison against NULL is NULL (not true), and `order by` puts
// the NULLs in one contiguous block -- so a nullable sort column silently drops
// a whole BAND of rows out of the middle of the list, with a 200 and the
// right-looking count. Nothing errors; no test that counts one page can see it.
//
// The `SortOption` type already requires `notNull: true` and a `backedBy`
// string, so `pnpm typecheck` refuses a sort with either missing. What the type
// CANNOT know is whether the column named in a `true`-labelled option is
// actually NOT NULL in the database. `tasks.due_at` is the trap: it is nullable
// (a task need not have a due date), and a `due` sort over it would be a lie
// the compiler cannot catch -- `notNull: true` beside `column: "due_at"`
// type-checks. This file is the runtime half: it holds the list of columns that
// are nullable on the LIVE tables and asserts no live-list sort names one.
//
// MUTATION THIS CATCHES (run for real, recorded in the report): add
//   due: { column: "due_at", label: "Due", defaultDirection: "asc",
//          directionLabels: {...}, notNull: true, backedBy: "..." }
// to TASK_LIST.sort. It compiles (the `true` is a lie the type cannot see) and
// this sweep goes RED on "no live-list sort names a nullable column".

const indexMigration = readFileSync(
  root + "supabase/migrations/20260902020000_operations_list_indexes.sql",
  "utf8",
);

/**
 * Columns that are NULLABLE on the live operations tables (20260902000000,
 * 20260902001000). A live-list keyset sort over any of these is rule-9 wrong.
 *
 * `deleted_at` is here too: it is nullable on a LIVE row, and it is a sort only
 * on the deleted views, where `scope: "deleted"` constrains it `not null` and
 * the partial index matches. The deleted specs are swept separately below with
 * that one column allowed.
 */
const NULLABLE_ON_LIVE = new Set([
  "due_at",
  "reminder_at",
  "completed_at",
  "ends_at",
  "scanned_at",
  "deleted_at",
]);

const LIVE_LISTS: Array<[string, ListSpec]> = [
  ["TASK_LIST", TASK_LIST as unknown as ListSpec],
  ["MEETING_LIST", MEETING_LIST as unknown as ListSpec],
  ["NOTE_LIST", NOTE_LIST as unknown as ListSpec],
];

const DELETED_LISTS: Array<[string, ListSpec]> = [
  ["TASK_DELETED_LIST", TASK_DELETED_LIST as unknown as ListSpec],
  ["MEETING_DELETED_LIST", MEETING_DELETED_LIST as unknown as ListSpec],
  ["NOTE_DELETED_LIST", NOTE_DELETED_LIST as unknown as ListSpec],
];

function sortEntries(spec: ListSpec): Array<[string, SortOption]> {
  return Object.entries(spec.sort);
}

describe("every operations sort is notNull and index-backed", () => {
  it("finds the sorts at all, so the sweep cannot pass vacuously", () => {
    // THE DENOMINATOR. Three live lists with 3 + 3 + 2 = 8 sorts, three deleted
    // lists with one each = 3. Eleven in total. A refactor that empties a
    // spec's `sort` object would make every loop below iterate zero times and
    // pass; this count is what stops that.
    const live = LIVE_LISTS.flatMap(([, s]) => sortEntries(s));
    const deleted = DELETED_LISTS.flatMap(([, s]) => sortEntries(s));
    expect(live).toHaveLength(8);
    expect(deleted).toHaveLength(3);
  });

  for (const [name, spec] of [...LIVE_LISTS, ...DELETED_LISTS]) {
    it(`${name}: every sort declares notNull:true and a real backedBy index`, () => {
      const sorts = sortEntries(spec);
      expect(sorts.length).toBeGreaterThan(0);
      for (const [key, option] of sorts) {
        expect(option.notNull, `${name}.${key}.notNull`).toBe(true);
        expect(
          option.backedBy.trim(),
          `${name}.${key}.backedBy`,
        ).not.toBe("");
        // The named index really exists in the migration -- so a sort cannot
        // name an index nobody created (rule 9: "if you cannot name an index
        // here, the column does not belong in the allowlist").
        expect(
          indexMigration,
          `${name}.${key}.backedBy = ${option.backedBy}`,
        ).toContain(`create index ${option.backedBy}`);
      }
    });
  }

  it("no LIVE-list sort names a column that is nullable on a live row", () => {
    // THE HEART OF THE SWEEP. `due_at` is the mutation trap; the others are
    // here so the next nullable column added as a sort is caught too.
    const offenders: string[] = [];
    for (const [name, spec] of LIVE_LISTS) {
      for (const [key, option] of sortEntries(spec)) {
        if (NULLABLE_ON_LIVE.has(option.column)) {
          offenders.push(`${name}.${key} sorts on ${option.column}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("a deleted view sorts on deleted_at, which scope: deleted constrains", () => {
    // The one column the sweep above forbids on a live list is exactly the one
    // a restore queue must sort by. Asserted so the exception is visible and
    // deliberate rather than a hole in the previous test.
    for (const [name, spec] of DELETED_LISTS) {
      const cols = sortEntries(spec).map(([, o]) => o.column);
      expect(cols, name).toEqual(["deleted_at"]);
    }
  });
});
