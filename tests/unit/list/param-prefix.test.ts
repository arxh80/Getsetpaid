// TWO LISTS ON ONE PAGE.
//
// `ListSpec.paramPrefix` was added by Task 7 for one concrete reason: the
// artist detail page already carried a list (the fee history) and the activity
// timeline made it two. Both call `parseListParams` on the SAME `searchParams`
// object, so before the prefix both read the same `after`.
//
// The assertions below are written as the failure, not as the feature: § 1
// reproduces what an unprefixed second list does to the first, and everything
// after it is what the prefix and `preserve` change about that.
import { describe, expect, it } from "vitest";
import {
  buildListHref,
  parseListParams,
  toolbarParamNames,
} from "@/lib/list/params";
import { encodeCursor } from "@/lib/list/cursor";
import { defineListSpec } from "@/lib/list/spec";

const FEES = defineListSpec({
  entity: "fees-fixture",
  noun: { one: "fee", many: "fees" },
  searchColumn: "note",
  searchLabel: "Search fees",
  sort: {
    occurred: {
      column: "occurred_on",
      label: "Date",
      defaultDirection: "desc",
      directionLabels: { asc: "oldest first", desc: "newest first" },
      notNull: true,
      backedBy: "fixture_idx",
    },
  },
  defaultSort: "occurred",
  filters: {},
});

const ACTIVITY = defineListSpec({
  entity: "activity-fixture",
  noun: { one: "entry", many: "entries" },
  searchColumn: "kind",
  searchLabel: "Search activity",
  sort: {
    when: {
      column: "occurred_at",
      label: "When",
      defaultDirection: "desc",
      directionLabels: { asc: "oldest first", desc: "newest first" },
      notNull: true,
      backedBy: "fixture_idx",
    },
  },
  defaultSort: "when",
  filters: {},
  paramPrefix: "activity_",
});

const A_CURSOR = {
  value: "2026-08-29T03:00:00+00:00",
  id: "00000000-0000-4000-8000-000000000001",
  sort: "when",
};

describe("1. the collision the prefix exists to close", () => {
  it("an UNPREFIXED second list reads the first list's cursor", () => {
    // Both specs bare. This is the state the artist page would have shipped
    // in, and the assertion is deliberately of the WRONG behaviour so that
    // removing the prefix from ACTIVITY_LIST cannot look harmless.
    const bare = defineListSpec({ ...ACTIVITY, paramPrefix: undefined });
    const raw = { after: encodeCursor({ ...A_CURSOR, sort: "occurred" }) };

    const fees = parseListParams(FEES, raw);
    const activity = parseListParams(bare, raw);

    // The fee list picked up a cursor that was made for the timeline, and it
    // decoded cleanly -- both specs happen to have a sort key the other could
    // have written, so `Cursor.sort` cannot tell them apart.
    expect(fees.cursor).not.toBeNull();
    expect(fees.cursor?.value).toBe(A_CURSOR.value);
    // ...and the timeline, whose sort key is `when`, discarded it.
    expect(activity.cursor).toBeNull();
  });

  it("the PREFIXED spec cannot see the other list's cursor at all", () => {
    const raw = { after: encodeCursor({ ...A_CURSOR, sort: "occurred" }) };
    expect(parseListParams(ACTIVITY, raw).cursor).toBeNull();
    expect(parseListParams(ACTIVITY, raw).cursorDiscarded).toBe(false);
  });

  it("and the other list cannot see the prefixed one's", () => {
    const raw = { activity_after: encodeCursor(A_CURSOR) };
    expect(parseListParams(FEES, raw).cursor).toBeNull();
    expect(parseListParams(ACTIVITY, raw).cursor?.value).toBe(A_CURSOR.value);
  });
});

describe("2. every key the spec owns is namespaced, not just the cursor", () => {
  const raw = {
    q: "not mine",
    sort: "occurred",
    dir: "asc",
    size: "10",
    activity_q: "mine",
    activity_dir: "asc",
    activity_size: "7",
  };

  it("reads its own q, dir and size and ignores the bare ones", () => {
    const params = parseListParams(ACTIVITY, raw);
    expect(params.q).toBe("mine");
    expect(params.dir).toBe("asc");
    expect(params.pageSize).toBe(7);
  });

  it("the bare spec on the same object is unaffected", () => {
    const params = parseListParams(FEES, raw);
    expect(params.q).toBe("not mine");
    expect(params.pageSize).toBe(10);
  });

  it("writes what it reads -- the round trip closes", () => {
    const params = parseListParams(ACTIVITY, raw);
    const href = buildListHref(ACTIVITY, "/x", params, {
      cursor: { direction: "after", cursor: A_CURSOR },
    });
    const back = parseListParams(
      ACTIVITY,
      Object.fromEntries(new URL(href, "http://x").searchParams),
    );
    expect(back.q).toBe("mine");
    expect(back.pageSize).toBe(7);
    expect(back.dir).toBe("asc");
    expect(back.cursor).toEqual(A_CURSOR);
  });

  it("emits prefixed keys and no bare ones", () => {
    const params = parseListParams(ACTIVITY, raw);
    const href = buildListHref(ACTIVITY, "/x", params, {
      cursor: { direction: "after", cursor: A_CURSOR },
    });
    const keys = [...new URL(href, "http://x").searchParams.keys()];
    expect(keys.every((k) => k.startsWith("activity_"))).toBe(true);
    expect(keys).toContain("activity_after");
  });
});

describe("3. `preserve` carries the OTHER list's state and never its own", () => {
  it("keeps a foreign key", () => {
    const params = parseListParams(FEES, {});
    const href = buildListHref(FEES, "/x", params, {
      preserve: { activity_after: "ZZZ", merged: "1" },
      cursor: { direction: "after", cursor: { ...A_CURSOR, sort: "occurred" } },
    });
    const q = new URL(href, "http://x").searchParams;
    expect(q.get("activity_after")).toBe("ZZZ");
    expect(q.get("merged")).toBe("1");
    expect(q.get("after")).not.toBeNull();
  });

  it("STRIPS its own keys out of preserve, so a stale cursor cannot come back", () => {
    // The whole point of handing it the page's raw params is that the caller
    // does not have to filter them. A carried-through `after` would survive a
    // sort change and page from a boundary in an ordering that no longer
    // exists -- the exact thing buildListHref's header refuses to do.
    const params = parseListParams(FEES, {});
    const href = buildListHref(FEES, "/x", params, {
      preserve: { after: "STALE", q: "stale", size: "40" },
    });
    const q = new URL(href, "http://x").searchParams;
    expect(q.get("after")).toBeNull();
    expect(q.get("q")).toBeNull();
    expect(q.get("size")).toBeNull();
  });

  it("strips the PREFIXED spec's own keys too, not just bare ones", () => {
    const params = parseListParams(ACTIVITY, {});
    const href = buildListHref(ACTIVITY, "/x", params, {
      preserve: { activity_after: "STALE", after: "someone else's" },
    });
    const q = new URL(href, "http://x").searchParams;
    expect(q.get("activity_after")).toBeNull();
    expect(q.get("after")).toBe("someone else's");
  });

  it("a repeated foreign parameter carries its first value, not an array", () => {
    const params = parseListParams(FEES, {});
    const href = buildListHref(FEES, "/x", params, {
      preserve: { tab: ["one", "two"] },
    });
    expect(new URL(href, "http://x").searchParams.getAll("tab")).toEqual([
      "one",
    ]);
  });

  it("without preserve, the href is exactly what it was before Task 7", () => {
    const params = parseListParams(FEES, { q: "x" });
    expect(buildListHref(FEES, "/x", params, {})).toBe("/x?q=x");
  });
});

describe("4. defineListSpec refuses a prefix that would not round-trip", () => {
  const base = { ...ACTIVITY };
  for (const bad of ["activity", "Activity_", "activity-", "a b_", "_"]) {
    it(`refuses ${JSON.stringify(bad)}`, () => {
      expect(() => defineListSpec({ ...base, paramPrefix: bad })).toThrow(
        /paramPrefix/,
      );
    });
  }
  it("accepts the shape the timeline uses", () => {
    expect(() =>
      defineListSpec({ ...base, paramPrefix: "activity_" }),
    ).not.toThrow();
  });
  it("accepts a two-part namespace with an internal underscore (Phase 4 Task 3)", () => {
    // The related panel's `rel_tasks_`/`rel_notes_`/`rel_docs_` prefixes carry
    // an internal `_`, which round-trips like every other permitted character.
    // A leading `_` (in the rejection set above) is still refused.
    for (const good of ["rel_tasks_", "rel_notes_", "rel_docs_"]) {
      expect(() => defineListSpec({ ...base, paramPrefix: good })).not.toThrow();
    }
  });
});

// ===========================================================================
// § 5 -- THE TOOLBAR'S OWN `name` ATTRIBUTES (final review I-4 / L1039)
// ===========================================================================
//
// `components/list/list-toolbar.tsx` hardcoded `name="sort"`, `name="dir"`,
// `name="size"`, `name="q"` and `name={key}`, bypassing `paramKey()`. The JS
// submit path was fine -- it calls `buildListHref` -- but the
// `<form method="get">` fallback wrote the un-namespaced keys straight into
// the URL, so a no-JS search on a namespaced list would have rewritten the
// OTHER list's state on the same route. Not live at the time, because
// ACTIVITY_LIST is the only prefixed spec and it renders no toolbar; live the
// moment Phase 3 gives a namespaced list a search box.
//
// The toolbar is a Client Component and there is no React Testing Library
// here, so the derivation is the unit under test and the toolbar consumes it.
// tests/unit/crm/source-shape.test.ts asserts that it actually does.

const FILTERED = defineListSpec({
  entity: "filtered-fixture",
  noun: { one: "row", many: "rows" },
  searchColumn: "name",
  searchLabel: "Search rows",
  sort: {
    name: {
      column: "name",
      label: "Name",
      defaultDirection: "asc",
      directionLabels: { asc: "A–Z", desc: "Z–A" },
      notNull: true,
      backedBy: "fixture_idx",
    },
  },
  defaultSort: "name",
  filters: {
    status: {
      label: "Status",
      choices: [
        { value: "", label: "Any" },
        { value: "live", label: "Live" },
      ],
    },
  },
  paramPrefix: "activity_",
});

describe("§ 5 toolbarParamNames", () => {
  it("prefixes every one of the five names on a namespaced spec", () => {
    expect(toolbarParamNames(FILTERED)).toEqual({
      q: "activity_q",
      sort: "activity_sort",
      dir: "activity_dir",
      size: "activity_size",
      filters: { status: "activity_status" },
    });
  });

  it("leaves them bare on a spec with no prefix, so nothing else changes", () => {
    expect(toolbarParamNames(FEES)).toEqual({
      q: "q",
      sort: "sort",
      dir: "dir",
      size: "size",
      filters: {},
    });
  });

  it("agrees with what parseListParams reads back", () => {
    // THE POINT OF THE WHOLE FIX. A no-JS submit posts these names; the parser
    // reads the prefixed ones. If the two ever disagree the search silently
    // does nothing and the URL grows a key nobody reads -- no error anywhere.
    const names = toolbarParamNames(FILTERED);
    const parsed = parseListParams(FILTERED, {
      [names.q]: "brighton",
      [names.sort]: "name",
      [names.dir]: "desc",
      [names.size]: "50",
      [names.filters.status]: "live",
    });
    expect(parsed.q).toBe("brighton");
    expect(parsed.dir).toBe("desc");
    expect(parsed.pageSize).toBe(50);
    expect(parsed.filters.status).toBe("live");
  });

  it("un-prefixed keys are ignored by a namespaced spec -- the defect, stated", () => {
    // What the old toolbar actually wrote. The prefixed spec does not see it,
    // and the UNPREFIXED list sharing the route does.
    const parsed = parseListParams(FILTERED, {
      q: "brighton",
      status: "live",
    });
    expect(parsed.q).toBe("");
    expect(parsed.filters.status).toBe("");
    expect(parseListParams(FEES, { q: "brighton" }).q).toBe("brighton");
  });

  it("agrees with buildListHref, which is the JS path", () => {
    const names = toolbarParamNames(FILTERED);
    const href = buildListHref(FILTERED, "/acme/artists/1", parseListParams(FILTERED, {}), {
      q: "brighton",
      filters: { status: "live" },
    });
    expect(href).toContain(`${names.q}=brighton`);
    expect(href).toContain(`${names.filters.status}=live`);
  });
});
