// The activity timeline's reader.
//
// Everything asserted here is about a jsonb payload the DATABASE builds, which
// is exactly why it is asserted: jsonb has no schema, the view's `detail`
// column will grow branches in Phase 3, 4 and 5, and every renderer in
// components/crm/activity-timeline.tsx reads it. A reader that assumes a
// string is one property access away from taking out a record page.
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
} from "@/lib/crm/activity";

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
  it("builds a record's own page for the five entity types", () => {
    expect(otherHref("acme", "company", UUID)).toBe(`/acme/companies/${UUID}`);
    expect(otherHref("acme", "contact", UUID)).toBe(`/acme/contacts/${UUID}`);
    expect(otherHref("acme", "agency", UUID)).toBe(`/acme/agencies/${UUID}`);
    expect(otherHref("acme", "artist", UUID)).toBe(`/acme/artists/${UUID}`);
    expect(otherHref("acme", "venue", UUID)).toBe(`/acme/venues/${UUID}`);
  });

  // A ROOM HAS NO PAGE. The view emits `other_type: 'room'` for venue_rooms so
  // the timeline can name it; there is nowhere to send a click, and a link to
  // `/acme/undefined/<id>` is worse than plain text.
  it("returns null for a room, an unknown type and a missing id", () => {
    expect(otherHref("acme", "room", UUID)).toBeNull();
    expect(otherHref("acme", "event", UUID)).toBeNull();
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
