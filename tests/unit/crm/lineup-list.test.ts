import { describe, expect, it } from "vitest";
import { ACTIVITY_LIST } from "@/lib/crm/activity";
import {
  BILLING_LABELS,
  BILLING_VALUES,
  isBilling,
  LINEUP_LIST,
  LINEUP_SEARCH_PARAM,
  LINEUP_SELECT,
  lineupParams,
  mapLineupRow,
  MAX_POSITION,
  MIN_POSITION,
  POSITION_PROBLEM,
  readPosition,
} from "@/lib/crm/lineup-list";
import { paramKey } from "@/lib/list/params";
import { RESERVED_PARAMS } from "@/lib/list/spec";

// THE LINEUP SPEC, ASSERTED WHERE THE COMPILER STOPS.
//
// `lib/list/spec.ts` already makes most of this file's subject a type error --
// `notNull` is the literal `true`, `backedBy` is a required string, the sort
// key union is inferred from the object literal. What is left at runtime is
// the part a type cannot see, and § 1 below is the one that matters most:
//
//   THE PREFIX IS THE ONLY GUARD AGAINST A WRONG PAGE RATHER THAN AN ERROR.
//
// Every other failure this spec can have is loud. Deleting `paramPrefix` is
// not: the event detail page then has two lists reading one `after`, and the
// SYMPTOM depends on which cursor arrives first. Handed the timeline's cursor,
// this spec compares a base64 payload carrying a timestamp against `position`
// -- an integer column -- and PostgREST answers 400, which the panel renders
// as "we couldn't load this event's lineup" on a page where nothing is wrong.
// Handed the lineup's, the timeline silently returns to page one. Neither
// throws in this repository's test suite, and nothing else asserts the value.

describe("§ 1. the prefix, which is the whole reason this spec has one", () => {
  it("LINEUP_LIST.paramPrefix is exactly \"lineup_\"", () => {
    expect(LINEUP_LIST.paramPrefix).toBe("lineup_");
  });

  it("...and it is NOT the timeline's, which is the collision it exists for", () => {
    // A separate assertion from the one above on purpose. `paramPrefix ===
    // "lineup_"` would still pass if somebody renamed ACTIVITY_LIST's to
    // `lineup_` too, which is the same defect reached from the other side.
    expect(ACTIVITY_LIST.paramPrefix).toBe("activity_");
    expect(LINEUP_LIST.paramPrefix).not.toBe(ACTIVITY_LIST.paramPrefix);
  });

  it("every key this spec owns is namespaced, cursor keys included", () => {
    // The derivation, not just the field: `paramKey` is what BOTH
    // `parseListParams` and `buildListHref` call, so this is the property the
    // two halves share. `after` and `before` are named explicitly because they
    // are the two the collision is actually about.
    for (const key of RESERVED_PARAMS) {
      expect(paramKey(LINEUP_LIST, key)).toBe(`lineup_${key}`);
    }
    expect(paramKey(LINEUP_LIST, "after")).toBe("lineup_after");
    expect(paramKey(LINEUP_LIST, "before")).toBe("lineup_before");
    // The denominator, so this loop cannot pass by running zero times.
    expect(RESERVED_PARAMS).toHaveLength(6);
  });

  it("the timeline's cursor is invisible to this spec, and vice versa", () => {
    // The failure written out as behaviour rather than as a field comparison.
    // A raw query string carrying BOTH lists' cursors must give this spec its
    // own and nothing else.
    const parsed = lineupParams({
      activity_after: "an-activity-cursor",
      lineup_after: "eyJ2IjoiMSIsImkiOiJ4In0",
      after: "an-unprefixed-cursor-belonging-to-nobody",
    });
    // The bare `after` and the timeline's are both ignored. The lineup's own
    // is read -- it decodes to nothing here, which is `cursorDiscarded`, and
    // that is a different fact from "it was never looked at".
    expect(parsed.cursor).toBeNull();
    expect(parsed.cursorDiscarded).toBe(false);
  });
});

describe("§ 2. lineup_q is dropped, for activityParams()'s reason", () => {
  it("LINEUP_SEARCH_PARAM is the prefix plus the search key", () => {
    // Written out in the module rather than derived, so renaming the prefix
    // without renaming this is a mismatch a reader can see. This is the
    // assertion that notices.
    expect(LINEUP_SEARCH_PARAM).toBe(paramKey(LINEUP_LIST, "q"));
  });

  it("a hand-edited ?lineup_q=zzz narrows nothing", () => {
    // Without the drop, `?lineup_q=zzz` reaches `ilike(billing, '%zzz%')` and
    // the panel renders "No lineup yet" about an event with a full bill --
    // Task 3's "No contacts yet" in a 71-contact workspace, reached through a
    // query parameter instead of through a role.
    expect(lineupParams({ lineup_q: "zzz" }).q).toBe("");
  });

  it("the spec still names a REAL column, because a fake one is a 400", () => {
    // `spec.searchColumn` is reached the moment `params.q !== ""`, so the
    // placeholder a reader might be tempted to write ("__none__") would be a
    // PostgREST 400 waiting for whoever removes the drop above.
    expect(LINEUP_LIST.searchColumn).toBe("billing");
    expect(LINEUP_SELECT).toContain("billing");
  });
});

describe("§ 3. the sort, and the index that has to exist for it", () => {
  const sortKeys = Object.keys(LINEUP_LIST.sort);

  it("has exactly one sort", () => {
    // ONE IS THE DENOMINATOR for the loop below. It is also the decision:
    // `created_at` is the tempting second sort and it is not here, because
    // there is no index of the required shape for it -- so `backedBy` would
    // have nowhere honest to point, which lib/list/spec.ts makes a compile
    // error rather than a judgement call.
    expect(sortKeys).toEqual(["order"]);
    expect(LINEUP_LIST.defaultSort).toBe("order");
  });

  it("it is NOT NULL, orders by `position`, and names the real index", () => {
    const sort = LINEUP_LIST.sort.order;
    expect(sort.notNull).toBe(true);
    expect(sort.column).toBe("position");
    // The NAME. That an index of this name EXISTS is asserted by
    // supabase/tests/rls_phase3_events.sql § EL, which is the half that needs
    // a database; this is the half that pins which string it has to be, so a
    // rename in either place without the other goes red somewhere.
    expect(sort.backedBy).toBe("event_lineup_org_event_position_id_live_idx");
    // The migration that creates it, matched against the same string.
    expect(sort.backedBy).toMatch(/^event_lineup_org_/);
  });

  it("the direction labels are about ORDER, not the alphabet", () => {
    // lib/list/spec.ts's `directionLabels` exists because the first browser
    // pass produced "sorted by updated (Z-A)" for a date column. "A-Z" applied
    // to a bill position is the same category error.
    expect(LINEUP_LIST.sort.order.directionLabels).toEqual({
      asc: "first to last",
      desc: "last to first",
    });
  });

  it("there are no filters, so nothing can narrow this list by URL", () => {
    expect(Object.keys(LINEUP_LIST.filters)).toEqual([]);
  });
});

describe("§ 4. the billing vocabulary matches the CHECK", () => {
  it("is the six values the column allows, in bill order", () => {
    expect([...BILLING_VALUES]).toEqual([
      "headliner",
      "support",
      "opener",
      "guest",
      "resident",
      "other",
    ]);
  });

  it("every value has a label, and the labels are the brief's", () => {
    expect(BILLING_VALUES).toHaveLength(6);
    expect(Object.keys(BILLING_LABELS).sort()).toEqual([...BILLING_VALUES].sort());
    expect(Object.values(BILLING_LABELS)).toEqual([
      "Headliner",
      "Support",
      "Opener",
      "Guest",
      "Resident",
      "Other",
    ]);
  });

  it("isBilling refuses anything else, null included", () => {
    expect(isBilling(null)).toBe(false);
    expect(isBilling("")).toBe(false);
    expect(isBilling("HEADLINER")).toBe(false);
    expect(isBilling("closer")).toBe(false);
    // The prototype keys, for `parseListParams`' reason: a membership test
    // written with `in` admits every member of Object.prototype.
    expect(isBilling("toString")).toBe(false);
    expect(isBilling("constructor")).toBe(false);
    for (const value of BILLING_VALUES) expect(isBilling(value)).toBe(true);
  });
});

describe("§ 5. readPosition -- three silent failures of Number()", () => {
  // The reason this is a function and not `Number(field(...))`. Each row below
  // is a value a form can really submit, and each one is silent in a different
  // way if `Number` is trusted.
  it("accepts the bounds and everything between", () => {
    expect(readPosition("0")).toBe(MIN_POSITION);
    expect(readPosition("999")).toBe(MAX_POSITION);
    expect(readPosition("7")).toBe(7);
    expect(readPosition("007")).toBe(7);
  });

  it("null in, null out -- the add form may leave it blank", () => {
    // And the action then OMITS the column, so the database default (0)
    // applies rather than this code writing a second copy of it.
    expect(readPosition(null)).toBeNull();
  });

  it("refuses the three Number() traps", () => {
    // `Number("")` is 0: an omitted field would silently become position zero,
    // moving an artist to the top of the bill.
    expect(readPosition("")).toBe("invalid");
    // `Number("1e3")` is 1000: past the CHECK, so the user meets a 23514 as
    // "something went wrong" instead of a sentence beside the field.
    expect(readPosition("1e3")).toBe("invalid");
    // `Number("1.5")` is 1.5 against an integer column: a 22P02.
    expect(readPosition("1.5")).toBe("invalid");
  });

  it("refuses out-of-range, negatives and junk", () => {
    expect(readPosition("1000")).toBe("invalid");
    expect(readPosition("-1")).toBe("invalid");
    expect(readPosition("+1")).toBe("invalid");
    expect(readPosition("0x10")).toBe("invalid");
    expect(readPosition("Infinity")).toBe("invalid");
    expect(readPosition("NaN")).toBe("invalid");
    expect(readPosition(" 7 ")).toBe("invalid");
    expect(readPosition("٧")).toBe("invalid");
  });

  it("the message is the brief's, verbatim", () => {
    expect(POSITION_PROBLEM).toBe(
      "Position must be a whole number between 0 and 999.",
    );
  });
});

describe("§ 6. mapLineupRow is total over what the database can return", () => {
  it("maps a live row", () => {
    expect(
      mapLineupRow({
        id: "ff110000-0000-0000-0000-000000000001",
        artist_id: "44440000-0000-0000-0000-000000000002",
        position: 3,
        billing: "headliner",
        set_starts_at: "2026-10-01T22:00:00+00:00",
        set_ends_at: null,
        notes: "needs two CDJs",
        created_at: "2026-09-01T10:00:00+00:00",
      }),
    ).toEqual({
      id: "ff110000-0000-0000-0000-000000000001",
      artistId: "44440000-0000-0000-0000-000000000002",
      position: 3,
      billing: "headliner",
      rawBilling: "headliner",
      setStartsAt: "2026-10-01T22:00:00+00:00",
      setEndsAt: null,
      notes: "needs two CDJs",
      createdAt: "2026-09-01T10:00:00+00:00",
    });
  });

  it("a billing this build does not know maps to null AND keeps the raw value", () => {
    // REACHABLE, and not only in theory: a migration that widens the CHECK is
    // applied before the deployment that renders the new value, so for the
    // length of a rolling deploy the table holds billings this bundle has
    // never heard of. Dropping the row would make the count line disagree with
    // the list; throwing would take out the record page. The panel renders the
    // raw string instead -- which is why it survives the mapping.
    const row = mapLineupRow({
      id: "a",
      artist_id: "b",
      position: 0,
      billing: "b2b",
      set_starts_at: null,
      set_ends_at: null,
      notes: null,
      created_at: "c",
    });
    expect(row.billing).toBeNull();
    expect(row.rawBilling).toBe("b2b");
  });

  it("selects created_at, which is half the documented tie-break", () => {
    // `public.event_lineup`'s table comment says the ordering is
    // `(position, created_at, id)`. A select list that omitted `created_at`
    // would leave that claim unverifiable from the row the panel renders.
    expect(LINEUP_SELECT).toContain("created_at");
    // And NOT `deleted_at`: `fetchListPage` writes `deleted_at is null` on
    // every live list, so the column is always null in these rows.
    expect(LINEUP_SELECT).not.toContain("deleted_at");
  });
});
