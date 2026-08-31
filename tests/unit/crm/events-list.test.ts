import { describe, expect, it } from "vitest";
import { EVENT_STATUSES, STATUS_LABELS } from "@/lib/crm/event-status";
import {
  ARTIST_EVENTS_LIST,
  ARTIST_EVENTS_SEARCH_PARAM,
  artistEventsParams,
  EVENT_DELETED_LIST,
  EVENT_DELETED_SELECT,
  EVENT_LIST,
  EVENT_SELECT,
  mapEventRow,
  VENUE_EVENTS_LIST,
  VENUE_EVENTS_SEARCH_PARAM,
  venueEventsParams,
} from "@/lib/crm/events-list";
// The other three specs that can share a detail route with one of the two
// above. Imported so the prefix set below is a fact about the PRODUCT rather
// than about this file's two specs -- see § 1.
import { ACTIVITY_LIST } from "@/lib/crm/activity";
import { ARTIST_FEE_LIST } from "@/lib/crm/artists-list";
import { LINEUP_LIST } from "@/lib/crm/lineup-list";
import { encodeCursor } from "@/lib/list/cursor";
import { paramKey } from "@/lib/list/params";
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

// ===========================================================================
// PHASE 3 TASK 7: THE TWO DERIVED SURFACES, AND THE PREFIX SET
// ===========================================================================
// § 1 below is the one that matters most, for `lineup-list.test.ts` § 1's
// reason restated with a bigger denominator: every other failure these two
// specs can have is loud, and a colliding `paramPrefix` is not. The ARTIST
// detail page now carries THREE lib/list/ surfaces (the fee history, the event
// history, the timeline) and the VENUE page carries two. Two of them reading
// one `after` hand each other's cursor, and the symptom depends on which
// arrives first: a PostgREST 400 rendered as "we couldn't load" on a page
// where nothing is wrong, or a silent return to page one.
//
// THE SET IS ASSERTED AS A SET, WITH ITS CARDINALITY. Four separate
// `toBe("...")` assertions would all still pass if somebody renamed two specs
// to the same string, which is the same defect reached from the other side --
// and `lineup-list.test.ts` § 1 had to add a second assertion by hand to cover
// exactly that between two specs. The set + count covers it between all of
// them at once and keeps covering it when a fifth arrives.

describe("§ 1. the prefixes, as a set, with its denominator", () => {
  /**
   * Every list spec in the product that owns a query-string namespace, plus
   * the two that deliberately do not and share a page with one that does.
   *
   * `undefined` IS A VALUE HERE, not an omission: `ARTIST_FEE_LIST` has no
   * prefix and sits on the same route as ARTIST_EVENTS_LIST and ACTIVITY_LIST,
   * so "bare" has to be in the set for the uniqueness assertion to mean what
   * it says. `paramKey()` maps a bare spec's keys to `after`/`sort`/..., which
   * cannot collide with any prefixed key.
   */
  const SPECS_SHARING_A_DETAIL_ROUTE = [
    { name: "ARTIST_FEE_LIST", prefix: ARTIST_FEE_LIST.paramPrefix },
    { name: "ACTIVITY_LIST", prefix: ACTIVITY_LIST.paramPrefix },
    { name: "LINEUP_LIST", prefix: LINEUP_LIST.paramPrefix },
    { name: "VENUE_EVENTS_LIST", prefix: VENUE_EVENTS_LIST.paramPrefix },
    { name: "ARTIST_EVENTS_LIST", prefix: ARTIST_EVENTS_LIST.paramPrefix },
  ] as const;

  it("the two new prefixes are exactly the ones the pages were built on", () => {
    expect(VENUE_EVENTS_LIST.paramPrefix).toBe("venueevents_");
    expect(ARTIST_EVENTS_LIST.paramPrefix).toBe("artistevents_");
  });

  it("every prefix in the set is distinct, and FIVE is the denominator", () => {
    // THE DENOMINATOR IS THE POINT. Without the count this passes by iterating
    // an array somebody emptied; without the distinctness it passes with two
    // specs renamed to one string. `undefined` participates as a value, which
    // is what makes "the fee history is bare and that is fine" an assertion
    // rather than a comment.
    expect(SPECS_SHARING_A_DETAIL_ROUTE).toHaveLength(5);
    const prefixes = SPECS_SHARING_A_DETAIL_ROUTE.map((s) => s.prefix);
    expect(new Set(prefixes).size).toBe(prefixes.length);
    // And the whole set, written out, so a rename is a diff a reader sees
    // rather than a count that still adds up.
    expect(prefixes).toEqual([
      undefined,
      "activity_",
      "lineup_",
      "venueevents_",
      "artistevents_",
    ]);
  });

  it("every key each new spec owns is namespaced, cursor keys included", () => {
    // The DERIVATION, not just the field: `paramKey` is what both
    // `parseListParams` and `buildListHref` call, so this is the property the
    // two halves share. `after` and `before` are named explicitly because they
    // are the two the collision is actually about.
    for (const spec of [VENUE_EVENTS_LIST, ARTIST_EVENTS_LIST] as const) {
      for (const key of RESERVED_PARAMS) {
        expect(paramKey(spec, key)).toBe(`${spec.paramPrefix}${key}`);
      }
    }
    expect(paramKey(VENUE_EVENTS_LIST, "after")).toBe("venueevents_after");
    expect(paramKey(ARTIST_EVENTS_LIST, "before")).toBe("artistevents_before");
    // The denominator, so the loop cannot pass by running zero times.
    expect(RESERVED_PARAMS).toHaveLength(6);
  });

  it("each surface reads its own cursor and nobody else's", () => {
    // The failure written out as behaviour rather than as a field comparison.
    // One raw query string carrying FOUR cursors -- one per surface that can
    // share a detail route -- and each parser must take its own and ignore the
    // other three. Built with the real encoder, so this drives the same
    // `decodeCursor` the request path does rather than a hand-typed string
    // that would fail to decode for reasons unrelated to the namespace.
    const FEE = "11111111-1111-1111-1111-111111111111";
    const TIMELINE = "22222222-2222-2222-2222-222222222222";
    const VENUE = "33333333-3333-3333-3333-333333333333";
    const ARTIST = "44444444-4444-4444-4444-444444444444";
    const raw = {
      after: encodeCursor({ value: "2026-01-01", id: FEE, sort: "occurred" }),
      activity_after: encodeCursor({
        value: "2026-02-02T00:00:00Z",
        id: TIMELINE,
        sort: "occurred",
      }),
      venueevents_after: encodeCursor({
        value: "2026-09-04T21:00:00Z",
        id: VENUE,
        sort: "starts",
      }),
      artistevents_after: encodeCursor({
        value: "2026-07-01T20:00:00Z",
        id: ARTIST,
        sort: "starts",
      }),
    };
    expect(venueEventsParams(raw).cursor).toEqual({
      value: "2026-09-04T21:00:00Z",
      id: VENUE,
      sort: "starts",
    });
    expect(artistEventsParams(raw).cursor).toEqual({
      value: "2026-07-01T20:00:00Z",
      id: ARTIST,
      sort: "starts",
    });

    // AND THE OTHER DIRECTION. A query string carrying only the OTHER
    // surfaces' keys leaves each of these two on page one having looked at
    // nothing -- `cursorDiscarded` false is "there was no key of mine", which
    // is a different fact from "mine was unreadable".
    const foreign = {
      after: raw.venueevents_after,
      activity_after: raw.venueevents_after,
      lineup_after: raw.venueevents_after,
    };
    expect(venueEventsParams(foreign).cursor).toBeNull();
    expect(venueEventsParams(foreign).cursorDiscarded).toBe(false);
    expect(artistEventsParams(foreign).cursor).toBeNull();
    expect(artistEventsParams(foreign).cursorDiscarded).toBe(false);
  });

  it("each surface refuses its own `q`, because it renders no search control", () => {
    // `lineupParams()`'s reason exactly: the spec must declare a REAL
    // `searchColumn` (a fake one is a PostgREST 400 on the first search), and
    // neither of these surfaces has a `ListToolbar`. So a hand-edited
    // `?venueevents_q=zzz` would narrow the panel through `ilike(name, ...)`
    // with no control on screen offering to clear it.
    expect(VENUE_EVENTS_SEARCH_PARAM).toBe(`${VENUE_EVENTS_LIST.paramPrefix}q`);
    expect(ARTIST_EVENTS_SEARCH_PARAM).toBe(`${ARTIST_EVENTS_LIST.paramPrefix}q`);
    expect(venueEventsParams({ venueevents_q: "zzz" }).q).toBe("");
    expect(artistEventsParams({ artistevents_q: "zzz" }).q).toBe("");
    // The control: the same parser DOES read a key it owns, so the two
    // assertions above are not passing because the parser reads nothing.
    expect(venueEventsParams({ venueevents_dir: "asc" }).dir).toBe("asc");
    expect(artistEventsParams({ artistevents_dir: "asc" }).dir).toBe("asc");
  });
});

describe("§ 2. the derived specs' one sort", () => {
  it("each has exactly ONE sort, and it is the date", () => {
    // ONE IS THE DENOMINATOR, and it is a decision rather than a shortcut:
    // EVENT_LIST's `name` and `updated` sorts would render two more column
    // headers on a panel inside a record page, and `when`/`status`/`owner`
    // would be filters with no toolbar to set them -- reachable only by
    // hand-editing a URL, with nothing on screen saying the panel was
    // narrowed. See lib/crm/events-list.ts's header for the full argument.
    expect(Object.keys(VENUE_EVENTS_LIST.sort)).toEqual(["starts"]);
    expect(Object.keys(ARTIST_EVENTS_LIST.sort)).toEqual(["starts"]);
    expect(VENUE_EVENTS_LIST.defaultSort).toBe("starts");
    expect(ARTIST_EVENTS_LIST.defaultSort).toBe("starts");
  });

  it("both sorts are NOT NULL and name the index that really backs them", () => {
    // `notNull` is `true` OF THE COLUMN here, not merely of the rows:
    // `events.starts_at` is NOT NULL by declaration (20260901000000), which is
    // what makes keyset ordering total. `backedBy` names
    // `events_org_starts_at_id_live_idx`, which
    // supabase/tests/rls_phase3_events.sql § EX looks up in pg_class -- so
    // "the index exists" is asserted by Postgres and the NAME is asserted
    // here.
    for (const spec of [VENUE_EVENTS_LIST, ARTIST_EVENTS_LIST] as const) {
      expect(spec.sort.starts.notNull).toBe(true);
      expect(spec.sort.starts.column).toBe("starts_at");
      expect(spec.sort.starts.backedBy).toBe("events_org_starts_at_id_live_idx");
      // The same index EVENT_LIST's default sort names -- one index, three
      // surfaces, and no migration in this task.
      expect(spec.sort.starts.backedBy).toBe(EVENT_LIST.sort.starts.backedBy);
    }
  });

  it("neither is labelled A–Z, and both default to latest first", () => {
    for (const spec of [VENUE_EVENTS_LIST, ARTIST_EVENTS_LIST] as const) {
      const labels = spec.sort.starts.directionLabels;
      expect([labels.asc, labels.desc].join(" ")).not.toMatch(/[A-Z]–[A-Z]/);
      expect(spec.sort.starts.defaultDirection).toBe("desc");
    }
  });

  it("neither declares a filter, so neither has a default state that hides rows", () => {
    expect(Object.keys(VENUE_EVENTS_LIST.filters)).toEqual([]);
    expect(Object.keys(ARTIST_EVENTS_LIST.filters)).toEqual([]);
  });

  it("both read the same table through the same select list", () => {
    // The surfaces differ in HOW the rows are chosen (an equality on
    // `venue_id`; a bounded `id IN (...)` built from `event_lineup`), never in
    // WHAT a row is. `mapEventRow` is the single mapper, so a column added to
    // EVENT_SELECT reaches all three readers or none.
    const columns = EVENT_SELECT.split(",").map((c) => c.trim());
    expect(columns).toContain(VENUE_EVENTS_LIST.sort.starts.column);
    expect(columns).toContain(ARTIST_EVENTS_LIST.sort.starts.column);
    // `venue_id` is what the artist surface's Venue column reads through
    // `loadVenueNames`; `status` is what both surfaces' StatusChip reads.
    expect(columns).toContain("venue_id");
    expect(columns).toContain("status");
  });

  it("mapEventRow is a faithful projection of EVENT_SELECT", () => {
    // The mapper moved out of the events list page in Task 7 because there are
    // now three readers of one literal. This drives it once, so "it still maps
    // every column the select list carries" is measured rather than reviewed.
    const row = mapEventRow({
      id: "11111111-1111-1111-1111-111111111111",
      name: "Warehouse Friday",
      starts_at: "2026-09-04T21:00:00Z",
      ends_at: null,
      status: "confirmed",
      event_type: "club_night",
      venue_id: null,
      owner_user_id: "22222222-2222-2222-2222-222222222222",
      updated_at: "2026-08-31T09:00:00Z",
    });
    expect(row).toEqual({
      id: "11111111-1111-1111-1111-111111111111",
      name: "Warehouse Friday",
      startsAt: "2026-09-04T21:00:00Z",
      endsAt: null,
      status: "confirmed",
      eventType: "club_night",
      venueId: null,
      updatedAt: "2026-08-31T09:00:00Z",
    });
    // `owner_user_id` is SELECTED and deliberately NOT mapped: the "Mine"
    // filter and the RLS record-scope term need it on the wire, and no column
    // renders it. Asserted so that "the row has eight fields, the select has
    // nine" is a decision on the record rather than an apparent oversight.
    expect(Object.keys(row)).toHaveLength(8);
    expect(row).not.toHaveProperty("ownerUserId");
  });
});
