import { describe, expect, it } from "vitest";
import { EVENT_STATUSES, STATUS_LABELS } from "@/lib/crm/event-status";
import {
  EVENT_DELETED_LIST,
  EVENT_DELETED_SELECT,
  EVENT_LIST,
  EVENT_SELECT,
} from "@/lib/crm/events-list";
import { defineListSpec, RESERVED_PARAMS } from "@/lib/list/spec";

// THE EVENTS LIST SPEC, ASSERTED WHERE THE COMPILER STOPS.
//
// `lib/list/spec.ts` already makes most of this file's subject a type error:
// `notNull` is `true` (the literal, not `boolean`), `backedBy` is a required
// `string`, and a column's `sortKey` is constrained to the spec's own keys. So
// what is left to assert at runtime is the part a type cannot see -- that
// `backedBy` names something REAL, that the filter vocabulary still matches the
// database's, and that none of these loops is running zero times.
//
// EVERY LOOP HAS A DENOMINATOR. Three sorts on the live spec, one on the
// deleted spec, eight statuses. Without those counts a spec emptied by a bad
// refactor passes every assertion below by iterating nothing, which is the
// exact failure mode `tests/unit/list/one-cursor-only.test.ts` was corrected
// for (L1143).

describe("EVENT_LIST sorts", () => {
  const sortKeys = Object.keys(EVENT_LIST.sort);

  it("has exactly the three sorts the indexes exist for", () => {
    // THREE IS THE DENOMINATOR for the loop below, and it is also the
    // assertion that catches the mutation this file was written against:
    // adding an `ends` sort over the NULLABLE `ends_at`, which keyset
    // pagination silently drops a contiguous band of rows for (a NULL
    // comparison is NULL, not false). See lib/crm/events-list.ts's sort block.
    expect(sortKeys.sort()).toEqual(["name", "starts", "updated"]);
  });

  it("every sort is NOT NULL and names a real index", () => {
    expect(sortKeys).toHaveLength(3);
    for (const key of sortKeys) {
      const option = EVENT_LIST.sort[key as keyof typeof EVENT_LIST.sort];
      expect(option.notNull, `${key}.notNull`).toBe(true);
      expect(option.backedBy.trim(), `${key}.backedBy`).not.toBe("");
      // The NAME's shape, not its existence -- only Postgres can say whether
      // the index is really there, and it does:
      // supabase/tests/rls_phase3_events.sql § EX looks all four up in
      // pg_class and asserts each is an index on public.events.
      expect(option.backedBy, `${key}.backedBy`).toMatch(/^events_org_.+_idx$/);
    }
  });

  it("the default sort is the date, descending", () => {
    // Founder decision, 2026-08-30. An events list opened cold shows the most
    // recent thing first.
    expect(EVENT_LIST.defaultSort).toBe("starts");
    expect(EVENT_LIST.sort.starts.column).toBe("starts_at");
    expect(EVENT_LIST.sort.starts.defaultDirection).toBe("desc");
  });

  it("no date sort is labelled A–Z", () => {
    // lib/list/spec.ts's `directionLabels` exists because the first browser
    // pass rendered "sorted by updated (Z–A)" for a date column and a reader
    // then has to work out which end is newest.
    for (const key of ["starts", "updated"] as const) {
      const labels = EVENT_LIST.sort[key].directionLabels;
      expect([labels.asc, labels.desc].join(" ")).not.toMatch(/[A-Z]–[A-Z]/);
    }
  });
});

describe("EVENT_DELETED_LIST sorts", () => {
  it("has exactly one sort, and it is NOT NULL and indexed", () => {
    // ONE IS THE DENOMINATOR. "Most recently deleted first" is the only
    // ordering a restore queue is read in, and every sort in an allowlist
    // costs an index.
    const keys = Object.keys(EVENT_DELETED_LIST.sort);
    expect(keys).toEqual(["deleted"]);
    expect(EVENT_DELETED_LIST.sort.deleted.notNull).toBe(true);
    expect(EVENT_DELETED_LIST.sort.deleted.backedBy).toBe(
      "events_org_deleted_at_id_idx",
    );
  });

  it("has no filters, so its default state hides nothing", () => {
    expect(Object.keys(EVENT_DELETED_LIST.filters)).toEqual([]);
  });
});

describe("EVENT_LIST filters", () => {
  it("the status choices are EVENT_STATUSES exactly, in order, behind one 'any'", () => {
    // THE MUTATION THIS CATCHES: a ninth status added to the CHECK constraint
    // and to EVENT_STATUSES, with the filter left alone -- so the product has
    // a status no one can filter for, and nothing else goes red. The choices
    // are GENERATED from EVENT_STATUSES in the spec, which is what makes this
    // assertion about the generation staying in place rather than about eight
    // hand-typed strings.
    const choices = EVENT_LIST.filters.status.choices;
    expect(choices).toHaveLength(EVENT_STATUSES.length + 1);
    expect(choices[0]).toEqual({ value: "any", label: "Any status" });
    expect(choices.slice(1).map((c) => c.value)).toEqual([...EVENT_STATUSES]);
    expect(choices.slice(1).map((c) => c.label)).toEqual(
      EVENT_STATUSES.map((s) => STATUS_LABELS[s]),
    );
  });

  it("every filter's FIRST choice is the one that filters nothing", () => {
    // lib/list/spec.ts's FilterDefinition: "The first choice is the default and
    // MUST be the one that filters nothing." `isNarrowed` reads exactly this
    // position, so a default anywhere else renders the UN-narrowed empty state
    // ("No events yet", with a create button) over a workspace full of rows --
    // the failure Phase 2 Task 3 shipped and a browser found.
    //
    // `when` defaulting to `all` rather than `upcoming` is the one this
    // product actually had to decide; asserted by value, not by position
    // alone, so "reorder the choices" cannot satisfy it accidentally.
    const firsts = Object.fromEntries(
      Object.entries(EVENT_LIST.filters).map(([key, def]) => [
        key,
        def.choices[0].value,
      ]),
    );
    expect(firsts).toEqual({ when: "all", status: "any", owner: "anyone" });
  });

  it("has exactly the three filters, and none collides with a reserved param", () => {
    const keys = Object.keys(EVENT_LIST.filters);
    expect(keys.sort()).toEqual(["owner", "status", "when"]);
    for (const key of keys) {
      expect(RESERVED_PARAMS as readonly string[]).not.toContain(key);
    }
  });

  it("defineListSpec accepts this spec and REFUSES a colliding one", () => {
    // The negative is the assertion; the positive is the control that proves
    // the negative is not passing because `defineListSpec` throws at
    // everything. A filter key becomes a query-string key verbatim, so a
    // filter called `sort` would shadow the sort parameter.
    const good = () =>
      defineListSpec({
        entity: "control-good",
        noun: { one: "thing", many: "things" },
        searchColumn: "name",
        searchLabel: "Search",
        sort: {
          name: {
            column: "name",
            label: "Name",
            defaultDirection: "asc",
            directionLabels: { asc: "A–Z", desc: "Z–A" },
            notNull: true,
            backedBy: "control_idx",
          },
        },
        defaultSort: "name",
        filters: { owner: { label: "Owner", choices: [{ value: "anyone", label: "Anyone" }] } },
      });
    expect(good).not.toThrow();

    const bad = () =>
      defineListSpec({
        entity: "control-bad",
        noun: { one: "thing", many: "things" },
        searchColumn: "name",
        searchLabel: "Search",
        sort: {
          name: {
            column: "name",
            label: "Name",
            defaultDirection: "asc",
            directionLabels: { asc: "A–Z", desc: "Z–A" },
            notNull: true,
            backedBy: "control_idx",
          },
        },
        defaultSort: "name",
        // `sort` is in RESERVED_PARAMS. This is the collision the real spec
        // must not have, built deliberately so the check above is not vacuous.
        filters: { sort: { label: "Sort", choices: [{ value: "any", label: "Any" }] } },
      });
    expect(bad).toThrow(/collides with a reserved query parameter/);
  });
});

describe("EVENT_SELECT", () => {
  const columns = EVENT_SELECT.split(",").map((c) => c.trim());

  it("carries owner_user_id, which two mechanisms need", () => {
    // The "Mine" filter compares against it, and the SELECT policy's
    // record-scope term (20260901011000) reads it. It is in the covering
    // indexes' INCLUDE list and it is never rendered.
    expect(columns).toContain("owner_user_id");
  });

  it("carries every column the sorts order by", () => {
    // lib/list/query.ts derives the cursor's boundary value from
    // `spec.sort[params.sort].column` on the returned row, so a sort whose
    // column is missing from `select` produces a cursor of `undefined` -- and
    // that file's own comment says the one thing a caller still has to get
    // right is exactly this.
    for (const key of Object.keys(EVENT_LIST.sort)) {
      const column =
        EVENT_LIST.sort[key as keyof typeof EVENT_LIST.sort].column;
      expect(columns, `sort "${key}" orders by ${column}`).toContain(column);
    }
    expect(EVENT_DELETED_SELECT.split(",").map((c) => c.trim())).toContain(
      EVENT_DELETED_LIST.sort.deleted.column,
    );
  });

  it("does NOT carry ticket_link or notes", () => {
    // `ticket_link` is an href and belongs on the detail page behind
    // safeHref(); `notes` is unbounded free text -- a paragraph, not a table
    // cell, and a kilobyte a row on the wire for something no column shows.
    expect(columns).not.toContain("ticket_link");
    expect(columns).not.toContain("notes");
  });

  it("names nine columns, so the assertions above are not over an empty list", () => {
    expect(columns).toHaveLength(9);
  });
});
