// The activity timeline's reader.
//
// Everything asserted here is about a jsonb payload the DATABASE builds, which
// is exactly why it is asserted: jsonb has no schema, the view's `detail`
// column will grow branches in Phase 3, 4 and 5, and every renderer in
// components/crm/activity-timeline.tsx reads it. A reader that assumes a
// string is one property access away from taking out a record page.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ACTIVITY_KINDS,
  ACTIVITY_LIST,
  ACTIVITY_SEARCH_PARAM,
  activityParams,
  detailStrings,
  detailText,
  detailUuid,
  isActivityKind,
  mapActivity,
  otherHref,
  SUBJECT_NOUN,
} from "@/lib/crm/activity";
import { CUSTOM_FIELD_ENTITY_TYPES } from "@/lib/crm/custom-fields";

const UUID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";

describe("mapActivity", () => {
  it("reads a well-formed row", () => {
    const row = mapActivity({
      id: UUID,
      occurred_at: "2026-08-29T03:00:00+00:00",
      kind: "merge_absorbed",
      actor_name: "Jo Smith",
      detail: { other_id: UUID, other_name: "Old Record", fields: ["email"] },
    });
    expect(row.kind).toBe("merge_absorbed");
    expect(row.actorName).toBe("Jo Smith");
    expect(row.detail.other_name).toBe("Old Record");
  });

  // THE ROLLING-DEPLOY CASE. A migration that adds a source is applied before
  // the build that renders it, so for the length of a deploy the view emits
  // kinds this code has never heard of. The row must survive: dropping it puts
  // the count line, the pager and the list into disagreement, and the pager's
  // cursors are built from rows this page actually rendered.
  it("keeps a row whose kind this build does not know", () => {
    const row = mapActivity({
      id: UUID,
      occurred_at: "2026-08-29T03:00:00+00:00",
      kind: "note_added",
      actor_name: null,
      detail: {},
    });
    expect(row.kind).toBeNull();
    expect(row.rawKind).toBe("note_added");
  });

  it("survives a null, a scalar and an array where an object is expected", () => {
    for (const detail of [null, undefined, "text", 7, ["a"]]) {
      const row = mapActivity({
        id: UUID,
        occurred_at: "2026-08-29T03:00:00+00:00",
        kind: "record_created",
        detail,
      });
      expect(row.detail).toEqual({});
    }
  });

  it("treats an empty actor_name as no actor, so the copy says 'someone'", () => {
    const row = mapActivity({
      id: UUID,
      occurred_at: "2026-08-29T03:00:00+00:00",
      kind: "merge_into",
      actor_name: "",
      detail: {},
    });
    expect(row.actorName).toBeNull();
  });
});

describe("isActivityKind", () => {
  it("accepts every kind the view emits", () => {
    for (const kind of ACTIVITY_KINDS) expect(isActivityKind(kind)).toBe(true);
  });

  // `Array.prototype.includes` is used rather than a lookup in an object
  // literal, so the prototype-chain hole params.ts closes with Object.hasOwn
  // does not exist here -- but assert it, because the next person may swap the
  // implementation for a Record and reintroduce it.
  it("does not accept a prototype key", () => {
    for (const key of ["toString", "constructor", "__proto__", "valueOf"]) {
      expect(isActivityKind(key)).toBe(false);
    }
  });
});

describe("detailText / detailStrings", () => {
  it("returns null for a missing, empty or non-string value", () => {
    expect(detailText({}, "name")).toBeNull();
    expect(detailText({ name: "" }, "name")).toBeNull();
    expect(detailText({ name: 7 }, "name")).toBeNull();
    expect(detailText({ name: null }, "name")).toBeNull();
    expect(detailText({ name: { a: 1 } }, "name")).toBeNull();
  });

  it("drops non-strings out of a fields array rather than rendering them", () => {
    expect(detailStrings({ fields: ["email", 7, null, "phone"] }, "fields"))
      .toEqual(["email", "phone"]);
    expect(detailStrings({ fields: "email" }, "fields")).toEqual([]);
    expect(detailStrings({}, "fields")).toEqual([]);
  });
});

describe("detailUuid is what stands between jsonb and an href", () => {
  it("accepts a uuid", () => {
    expect(detailUuid({ other_id: UUID }, "other_id")).toBe(UUID);
  });

  // Every value the SHIPPED view puts in `other_id` comes from a uuid column,
  // so none of these can be produced today. The guard is for the next branch:
  // `detail` is jsonb, and `otherHref` interpolates this value into a path.
  it("refuses anything that is not one, including a path traversal", () => {
    for (const hostile of [
      "../../evil",
      "..%2f..%2fevil",
      "3f2504e0-4f89-41d3-9a0c-0305e82c3301/../../x",
      "not-a-uuid",
      "",
      7,
      null,
      { id: UUID },
    ]) {
      expect(detailUuid({ other_id: hostile }, "other_id")).toBeNull();
    }
  });
});

// THE TIMELINE HAS NO SEARCH CONTROL, so a search parameter must not narrow
// it. Not cosmetic: this surface renders ONE empty state, so a narrowed
// timeline would tell a reader "Nothing has been recorded against this contact
// yet" about a record with a full history -- the same lie Task 3 found on the
// contacts list, reached through a URL instead of through a role.
describe("activityParams refuses a search it has no control for", () => {
  it("names the key the spec would actually read", () => {
    // Bound to the spec rather than hardcoded twice: renaming the prefix
    // without renaming the constant would leave a guard that guards nothing.
    expect(ACTIVITY_SEARCH_PARAM).toBe(`${ACTIVITY_LIST.paramPrefix}q`);
  });

  it("drops activity_q, so the timeline cannot be narrowed by URL", () => {
    expect(activityParams({ activity_q: "zzz" }).q).toBe("");
    expect(activityParams({ activity_q: ["zzz", "yyy"] }).q).toBe("");
  });

  it("still reads the parameters it does own", () => {
    const params = activityParams({ activity_q: "zzz", activity_size: "10" });
    expect(params.pageSize).toBe(10);
  });

  it("ignores an unprefixed q belonging to another list on the page", () => {
    expect(activityParams({ q: "someone else's search" }).q).toBe("");
  });
});

describe("otherHref", () => {
  it("builds a record's own page for the six entity types", () => {
    expect(otherHref("acme", "company", UUID)).toBe(`/acme/companies/${UUID}`);
    expect(otherHref("acme", "contact", UUID)).toBe(`/acme/contacts/${UUID}`);
    expect(otherHref("acme", "agency", UUID)).toBe(`/acme/agencies/${UUID}`);
    expect(otherHref("acme", "artist", UUID)).toBe(`/acme/artists/${UUID}`);
    expect(otherHref("acme", "venue", UUID)).toBe(`/acme/venues/${UUID}`);
  });

  // `event` MOVED SIDES IN PHASE 3 TASK 1, and the move is the assertion.
  //
  // It used to sit in the "unknown type" case below -- the natural choice at
  // the time, because there was no event entity. 20260901001000 added it to
  // CUSTOM_FIELD_ENTITY_TYPES and lib/crm/custom-fields.ts gave
  // ENTITY_PATH_SEGMENT an `event: "events"` entry, so otherHref now resolves
  // it. Asserted here on its own rather than folded into the five above,
  // because the ROUTE DOES NOT EXIST until Phase 3 Task 3: this link is
  // deliberately dangling for one task. Omitting the ENTITY_PATH_SEGMENT entry
  // instead would have put `undefined` in the URL rather than produce a 404,
  // which is why the entry is there. Nothing reaches it today -- the only way
  // in is a timeline entry on an event, and public.activity_events does not
  // union public.events until Task 3 either.
  it("resolves an event too, at a route Task 3 has not shipped yet", () => {
    expect(otherHref("acme", "event", UUID)).toBe(`/acme/events/${UUID}`);
  });

  // A ROOM HAS NO PAGE. The view emits `other_type: 'room'` for venue_rooms so
  // the timeline can name it; there is nowhere to send a click, and a link to
  // `/acme/undefined/<id>` is worse than plain text.
  it("returns null for a room, an unknown type and a missing id", () => {
    expect(otherHref("acme", "room", UUID)).toBeNull();
    expect(otherHref("acme", "tour", UUID)).toBeNull();
    expect(otherHref("acme", "company", null)).toBeNull();
    expect(otherHref("acme", null, UUID)).toBeNull();
  });

  it("does not resolve a prototype key to a path segment", () => {
    // `Object.hasOwn`, not `in`: `ENTITY_PATH_SEGMENT["toString"]` is a
    // function on the prototype, and an `in` check would pass it through to
    // `/acme/function toString() { [native code] }/<id>`.
    expect(otherHref("acme", "toString", UUID)).toBeNull();
    expect(otherHref("acme", "constructor", UUID)).toBeNull();
  });
});

// ===========================================================================
// PHASE 3 TASK 6: the event sources
// ===========================================================================
// Five branches landed on public.activity_events (20260901030000: events in
// the subjects CTE, both directions of event_lineup, the venue side of
// events.venue_id; 20260901031000: event_status_changes) and exactly ONE new
// kind came with them. Everything below is a DENOMINATOR assertion -- a count
// or an exact set -- because the failure this file is guarding against is a
// later phase adding a source and leaving one of the three totals behind, and
// a "contains" assertion cannot see that.

describe("SUBJECT_NOUN is total over the subject types", () => {
  it("has one entry per entity type, and six of them", () => {
    // SIX IS THE DENOMINATOR. `ActivitySubjectType` is an alias of
    // `CustomFieldEntityType`, so a seventh entity type in Phase 4 widens the
    // union and TypeScript makes the missing noun a compile error -- but a
    // `Record` type assertion passes vacuously against `{}` once something
    // casts, which is the hole event-status.test.ts's key counts also close.
    expect(Object.keys(SUBJECT_NOUN).sort()).toEqual(
      [...CUSTOM_FIELD_ENTITY_TYPES].sort(),
    );
    expect(Object.keys(SUBJECT_NOUN)).toHaveLength(6);
  });

  it("every noun is a non-empty singular used in prose", () => {
    for (const type of CUSTOM_FIELD_ENTITY_TYPES) {
      const noun = SUBJECT_NOUN[type];
      expect(noun, type).toBeTruthy();
      // Singular: the component writes "this ${noun}" and "against this
      // ${noun} yet". A plural here reads as a grammar bug on six pages.
      expect(noun.endsWith("s"), `${type} noun is plural`).toBe(false);
    }
  });

  it("names an event 'event'", () => {
    expect(SUBJECT_NOUN.event).toBe("event");
  });
});

describe("ACTIVITY_KINDS gained exactly one member in Task 6", () => {
  it("is nine kinds, and status_changed is the ninth", () => {
    // EIGHT BEFORE, NINE NOW. The number is written out so that a tenth kind
    // arrives with a decision rather than by accident: every kind is a string
    // the database can emit and a sentence somebody has to write.
    expect(ACTIVITY_KINDS).toHaveLength(9);
    expect(ACTIVITY_KINDS).toContain("status_changed");
    expect(isActivityKind("status_changed")).toBe(true);
  });

  it("did NOT gain a lineup-shaped kind", () => {
    // The rule 20260829040000's venue_rooms branch set, asserted rather than
    // trusted: both lineup branches and the venue branch REUSE link_added /
    // link_removed. These are the names a later author would reach for.
    for (const invented of [
      "lineup_added",
      "lineup_removed",
      "artist_booked",
      "venue_booked",
      "event_linked",
    ]) {
      expect(isActivityKind(invented), invented).toBe(false);
    }
  });
});

describe("the renderer record is total over ACTIVITY_KINDS", () => {
  // THE COMPILER IS THE REAL GUARD -- `Record<ActivityKind, KindRenderer>` in
  // components/crm/activity-timeline.tsx makes a missing entry a `tsc` error,
  // and `pnpm typecheck` is the gate that runs it. This is the runtime half,
  // and it reads the SOURCE rather than importing it because vitest's
  // `include` is `tests/**/*.test.ts` and this project's unit suite is pure
  // TypeScript with no JSX transform -- the same reason source-shape.test.ts
  // asserts over text.
  const component = readFileSync(
    new URL("../../../components/crm/activity-timeline.tsx", import.meta.url),
    "utf8",
  );
  const record = component.slice(
    component.indexOf("> = {", component.indexOf("const RENDER")),
  );

  it("has a key for every kind", () => {
    for (const kind of ACTIVITY_KINDS) {
      expect(record.includes(`
  ${kind}: (`), kind).toBe(true);
    }
  });

  it("renders status_changed through STATUS_LABELS, as text", () => {
    // DESIGN.md § Working palette: "status must never be colour-only". The
    // entry names both statuses in words; there is no chip on this surface and
    // no tone token in this component.
    expect(component).toContain('import { STATUS_LABELS');
    expect(component).toContain("Status changed from");
    expect(component).not.toContain("STATUS_TONE");
  });
});

describe("ACTIVITY_LIST.sort.occurred.backedBy names the new branches' indexes", () => {
  // `backedBy` is "required to be a real index name" (lib/list/spec.ts), and a
  // view has no index of its own -- so this spec names the PER-BRANCH set. A
  // unit test can only check the strings are there; whether an index of that
  // name exists is rls_phase3_events.sql's job (§§ EX, EL) because only a
  // database can answer it.
  const backedBy = ACTIVITY_LIST.sort.occurred.backedBy;

  it("carries all four Phase 3 Task 6 names", () => {
    for (const name of [
      "event_lineup_event_id_org_idx",
      "event_lineup_artist_id_org_idx",
      "events_venue_id_org_idx",
      "event_status_changes_event_id_org_changed_at_idx",
    ]) {
      expect(backedBy, name).toContain(name);
    }
  });

  it("still carries every Phase 2 name, so this was an addition and not a rewrite", () => {
    for (const name of [
      "merges_entity_winner_idx",
      "merges_entity_loser_idx",
      "contact_companies_contact_company_unique",
      "contact_companies_company_id_idx",
      "artist_representations_artist_id_idx",
      "artist_representations_agency_id_idx",
      "venue_rooms_venue_id_idx",
      "custom_field_values_entity_idx",
    ]) {
      expect(backedBy, name).toContain(name);
    }
  });
});
