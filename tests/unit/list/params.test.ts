import { describe, expect, it } from "vitest";
import {
  buildListHref,
  isNarrowed,
  parseListParams,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  MAX_SEARCH_LENGTH,
} from "@/lib/list/params";
import { defineListSpec, RESERVED_PARAMS } from "@/lib/list/spec";
import { encodeCursor } from "@/lib/list/cursor";

// The allowlist. This is one of the two places in the list surface where a bug
// is a security bug rather than a display bug, so the tests here are written
// as attacks on the allowlist rather than as examples of it working.

const SPEC = defineListSpec({
  entity: "test",
  noun: { one: "row", many: "rows" },
  searchColumn: "name",
  searchLabel: "Search by name",
  sort: {
    name: {
      column: "name",
      label: "Name",
      defaultDirection: "asc",
      directionLabels: { asc: "A–Z", desc: "Z–A" },
      notNull: true,
      backedBy: "test_name_idx",
    },
    updated: {
      column: "updated_at",
      label: "Updated",
      defaultDirection: "desc",
      directionLabels: { asc: "oldest first", desc: "newest first" },
      notNull: true,
      backedBy: "test_updated_idx",
    },
  },
  defaultSort: "name",
  filters: {
    owner: {
      label: "Owner",
      choices: [
        { value: "anyone", label: "Anyone" },
        { value: "mine", label: "Mine" },
      ],
    },
  },
});

describe("parseListParams: the sort allowlist", () => {
  it("accepts a declared sort key", () => {
    expect(parseListParams(SPEC, { sort: "updated" }).sort).toBe("updated");
  });

  it("falls back to the default for an undeclared key", () => {
    expect(parseListParams(SPEC, { sort: "email" }).sort).toBe("name");
  });

  // THE PROTOTYPE-CHAIN BYPASS. `"toString" in spec.sort` is true for every
  // object in JavaScript, so an allowlist written with `in` admits every
  // member of Object.prototype -- and `spec.sort.toString.column` is
  // undefined, which reaches the query builder as `order(undefined)`.
  //
  // These are the exact strings that break the naive implementation. If
  // lib/list/params.ts is ever "simplified" back to `in`, every one of them
  // fails.
  it.each([
    "__proto__",
    "constructor",
    "prototype",
    "toString",
    "valueOf",
    "hasOwnProperty",
    "isPrototypeOf",
    "propertyIsEnumerable",
    "toLocaleString",
  ])("refuses the prototype key %s", (key) => {
    const params = parseListParams(SPEC, { sort: key });
    expect(params.sort).toBe("name");
    expect(SPEC.sort[params.sort].column).toBe("name");
  });

  it("refuses a SQL-shaped sort value", () => {
    expect(
      parseListParams(SPEC, { sort: "name; drop table contacts" }).sort,
    ).toBe("name");
    expect(parseListParams(SPEC, { sort: "name.desc,id" }).sort).toBe("name");
    expect(parseListParams(SPEC, { sort: "(select 1)" }).sort).toBe("name");
  });

  it("takes the first of a repeated parameter rather than erroring", () => {
    expect(parseListParams(SPEC, { sort: ["updated", "name"] }).sort).toBe(
      "updated",
    );
    expect(parseListParams(SPEC, { sort: [] }).sort).toBe("name");
  });

  it("uses the column's own default direction, not a global one", () => {
    expect(parseListParams(SPEC, {}).dir).toBe("asc");
    expect(parseListParams(SPEC, { sort: "updated" }).dir).toBe("desc");
  });

  it("refuses a direction outside asc/desc", () => {
    expect(parseListParams(SPEC, { dir: "asc" }).dir).toBe("asc");
    expect(parseListParams(SPEC, { dir: "desc" }).dir).toBe("desc");
    expect(parseListParams(SPEC, { dir: "ASC" }).dir).toBe("asc");
    expect(parseListParams(SPEC, { dir: "asc nulls last" }).dir).toBe("asc");
    expect(parseListParams(SPEC, { dir: "" }).dir).toBe("asc");
  });
});

describe("parseListParams: the filter allowlist", () => {
  it("accepts a declared choice", () => {
    expect(parseListParams(SPEC, { owner: "mine" }).filters.owner).toBe("mine");
  });

  // Two allowlists, not one. Checking only that `owner` is a known FILTER
  // would let any value through to whatever the entity does with it.
  it("refuses an undeclared value for a declared filter", () => {
    expect(parseListParams(SPEC, { owner: "everyone" }).filters.owner).toBe(
      "anyone",
    );
    expect(parseListParams(SPEC, { owner: "__proto__" }).filters.owner).toBe(
      "anyone",
    );
  });

  it("ignores a filter the spec does not declare", () => {
    const params = parseListParams(SPEC, { tier: "pro", owner: "mine" });
    expect(Object.keys(params.filters)).toEqual(["owner"]);
  });

  it("defaults to the first choice, which must filter nothing", () => {
    expect(parseListParams(SPEC, {}).filters.owner).toBe(
      SPEC.filters.owner.choices[0].value,
    );
  });
});

describe("parseListParams: the page-size ceiling", () => {
  it("defaults", () => {
    expect(parseListParams(SPEC, {}).pageSize).toBe(DEFAULT_PAGE_SIZE);
  });

  it.each([
    ["51", MAX_PAGE_SIZE],
    ["1000", MAX_PAGE_SIZE],
    ["999999999", MAX_PAGE_SIZE],
    // Review M-2. These used to clamp parseInt's PREFIX and render a
    // one-row page with a full pager, which reads as a rendering fault. A
    // value that is not a plain positive integer is now absent, not a 1.
    ["1e9", DEFAULT_PAGE_SIZE],
    ["0", DEFAULT_PAGE_SIZE],
    ["-1", DEFAULT_PAGE_SIZE],
    ["-99999", DEFAULT_PAGE_SIZE],
    ["abc", DEFAULT_PAGE_SIZE],
    ["", DEFAULT_PAGE_SIZE],
    ["25abc", DEFAULT_PAGE_SIZE],
    [" 25 ", DEFAULT_PAGE_SIZE],
    ["+25", DEFAULT_PAGE_SIZE],
    ["0x40", DEFAULT_PAGE_SIZE],
    ["25", 25],
    ["1", 1],
    ["NaN", DEFAULT_PAGE_SIZE],
    ["Infinity", DEFAULT_PAGE_SIZE],
  ])("clamps size=%s to %i", (raw, expected) => {
    expect(parseListParams(SPEC, { size: raw }).pageSize).toBe(expected);
  });

  it("never returns a size above the ceiling for any input", () => {
    for (const raw of ["50", "51", "9007199254740993", "0x40", "+80", " 80 ", "1e9", "0", "-1"]) {
      const size = parseListParams(SPEC, { size: raw }).pageSize;
      expect(size).toBeGreaterThanOrEqual(1);
      expect(size).toBeLessThanOrEqual(MAX_PAGE_SIZE);
    }
  });
});

describe("parseListParams: the search term", () => {
  it("trims", () => {
    expect(parseListParams(SPEC, { q: "  ada  " }).q).toBe("ada");
  });

  it("caps the length", () => {
    const long = "a".repeat(500);
    expect(parseListParams(SPEC, { q: long }).q).toHaveLength(
      MAX_SEARCH_LENGTH,
    );
  });

  it("keeps grammar characters intact -- escaping belongs at the query", () => {
    // parseListParams must NOT sanitise. Stripping characters here would
    // make a contact called "O'Brien, Sean" unfindable and would hide the
    // fact that lib/list/postgrest.ts is what makes them safe.
    expect(parseListParams(SPEC, { q: `O'Brien, "S")` }).q).toBe(
      `O'Brien, "S")`,
    );
  });
});

describe("parseListParams: the cursor", () => {
  const cursor = {
    value: "Ada Ali",
    id: "11111111-1111-1111-1111-111111111111",
    sort: "name" as const,
  };

  it("reads an `after` cursor", () => {
    const params = parseListParams(SPEC, { after: encodeCursor(cursor) });
    expect(params.cursor).toEqual(cursor);
    expect(params.cursorDirection).toBe("after");
  });

  it("reads a `before` cursor", () => {
    const params = parseListParams(SPEC, { before: encodeCursor(cursor) });
    expect(params.cursor).toEqual(cursor);
    expect(params.cursorDirection).toBe("before");
  });

  it("prefers `after` when both are present rather than erroring", () => {
    const params = parseListParams(SPEC, {
      after: encodeCursor(cursor),
      before: encodeCursor({ ...cursor, value: "Zoe" }),
    });
    expect(params.cursorDirection).toBe("after");
    expect(params.cursor?.value).toBe("Ada Ali");
  });

  // ------------------------------------------------------------------
  // Review I-2. A cursor made under one sort, sent with another, used to
  // reach the query as `updated_at >= 'Contact 00100'` -- a PostgREST 400,
  // rendered to the user as "we couldn't load contacts", which says the
  // system is broken when the URL is merely stale.
  // ------------------------------------------------------------------
  it("discards a cursor made under a DIFFERENT sort", () => {
    const nameCursor = encodeCursor({ ...cursor, sort: "name" });
    const params = parseListParams(SPEC, {
      sort: "updated",
      after: nameCursor,
    });
    expect(params.sort).toBe("updated");
    expect(params.cursor).toBeNull();
    expect(params.cursorDirection).toBeNull();
  });

  it("discards a `before` cursor made under a different sort too", () => {
    const params = parseListParams(SPEC, {
      sort: "updated",
      before: encodeCursor({ ...cursor, sort: "name" }),
    });
    expect(params.cursor).toBeNull();
    expect(params.cursorDirection).toBeNull();
  });

  it("keeps a cursor whose sort matches, including a non-default sort", () => {
    const params = parseListParams(SPEC, {
      sort: "updated",
      after: encodeCursor({ ...cursor, sort: "updated" }),
    });
    expect(params.cursor).toEqual({ ...cursor, sort: "updated" });
    expect(params.cursorDirection).toBe("after");
  });

  it("discards a name cursor when the sort param is absent and the DEFAULT differs", () => {
    // The default sort is `name`, so a cursor tagged `updated` must be
    // dropped even though the request named no sort at all.
    const params = parseListParams(SPEC, {
      after: encodeCursor({ ...cursor, sort: "updated" }),
    });
    expect(params.sort).toBe("name");
    expect(params.cursor).toBeNull();
  });

  it("treats an unreadable cursor as page one", () => {
    for (const raw of ["", "!!!!", "e30", "bnVsbA", "W10"]) {
      const params = parseListParams(SPEC, { after: raw });
      expect(params.cursor).toBeNull();
      expect(params.cursorDirection).toBeNull();
    }
  });
});

describe("isNarrowed", () => {
  it("is false for the bare list", () => {
    expect(isNarrowed(SPEC, parseListParams(SPEC, {}))).toBe(false);
  });
  it("is false when a filter is at its no-op default", () => {
    expect(isNarrowed(SPEC, parseListParams(SPEC, { owner: "anyone" }))).toBe(
      false,
    );
  });
  it("is true for a search", () => {
    expect(isNarrowed(SPEC, parseListParams(SPEC, { q: "ada" }))).toBe(true);
  });
  it("is true for a non-default filter", () => {
    expect(isNarrowed(SPEC, parseListParams(SPEC, { owner: "mine" }))).toBe(
      true,
    );
  });
  // Sorting is not narrowing: the same rows in a different order. If this
  // flipped, every sorted list would offer "Clear search and filters" and the
  // "no matches" empty state would replace "no records yet".
  it("is false for a sort", () => {
    expect(
      isNarrowed(SPEC, parseListParams(SPEC, { sort: "updated", dir: "asc" })),
    ).toBe(false);
  });
});

describe("buildListHref", () => {
  const base = "/acme/contacts";

  it("omits every default, so the canonical list is a bare path", () => {
    expect(buildListHref(SPEC, base, parseListParams(SPEC, {}))).toBe(base);
  });

  // THE CURSOR MUST NOT SURVIVE A CHANGE OF SET OR ORDER. It names a row in
  // one particular ordering of one particular filtered set; carried across, it
  // pages from a boundary that need not exist in the new list -- which is not
  // an error, just a page that starts somewhere arbitrary.
  it("drops the cursor when the search changes", () => {
    const withCursor = parseListParams(SPEC, {
      after: encodeCursor({
        value: "Ada",
        id: "11111111-1111-1111-1111-111111111111",
        sort: "name",
      }),
    });
    const href = buildListHref(SPEC, base, withCursor, { q: "zoe" });
    expect(href).toBe("/acme/contacts?q=zoe");
    expect(href).not.toContain("after");
  });

  it("drops the cursor when the sort changes", () => {
    const withCursor = parseListParams(SPEC, {
      after: encodeCursor({
        value: "Ada",
        id: "11111111-1111-1111-1111-111111111111",
        sort: "name",
      }),
    });
    expect(
      buildListHref(SPEC, base, withCursor, { sort: "updated" }),
    ).not.toContain("after");
  });

  it("drops the cursor when a filter changes", () => {
    const withCursor = parseListParams(SPEC, {
      after: encodeCursor({
        value: "Ada",
        id: "11111111-1111-1111-1111-111111111111",
        sort: "name",
      }),
    });
    expect(
      buildListHref(SPEC, base, withCursor, { filters: { owner: "mine" } }),
    ).not.toContain("after");
  });

  it("gives a new sort column its own natural direction", () => {
    // Clicking "Updated" from a name-ascending list must not carry `asc`
    // across: a date column's useful first order is newest first.
    const params = parseListParams(SPEC, {});
    expect(buildListHref(SPEC, base, params, { sort: "updated" })).toBe(
      "/acme/contacts?sort=updated",
    );
    expect(
      buildListHref(SPEC, base, params, { sort: "updated", dir: "asc" }),
    ).toBe("/acme/contacts?sort=updated&dir=asc");
  });

  it("round-trips through parseListParams", () => {
    const original = parseListParams(SPEC, {
      q: "ada",
      sort: "updated",
      dir: "asc",
      owner: "mine",
      size: "40",
    });
    const href = buildListHref(SPEC, base, original);
    const query = Object.fromEntries(
      new URLSearchParams(href.split("?")[1] ?? ""),
    );
    expect(parseListParams(SPEC, query)).toEqual(original);
  });

  it("preserves a search term's grammar characters through the URL", () => {
    const params = parseListParams(SPEC, { q: `O'Brien, "S") & co` });
    const href = buildListHref(SPEC, base, params);
    const query = Object.fromEntries(
      new URLSearchParams(href.split("?")[1] ?? ""),
    );
    expect(parseListParams(SPEC, query).q).toBe(`O'Brien, "S") & co`);
  });
});

describe("defineListSpec guards", () => {
  it("refuses a filter key that shadows a reserved query parameter", () => {
    for (const reserved of RESERVED_PARAMS) {
      expect(() =>
        defineListSpec({
          entity: "bad",
          noun: { one: "row", many: "rows" },
          searchColumn: "name",
          searchLabel: "Search",
          sort: SPEC.sort,
          defaultSort: "name",
          filters: {
            [reserved]: {
              label: "X",
              choices: [{ value: "a", label: "A" }] as const,
            },
          } as never,
        }),
      ).toThrow(/reserved query parameter/);
    }
  });

  it("refuses a defaultSort that is not a declared sort", () => {
    expect(() =>
      defineListSpec({
        entity: "bad",
        noun: { one: "row", many: "rows" },
        searchColumn: "name",
        searchLabel: "Search",
        sort: SPEC.sort,
        defaultSort: "nope" as never,
        filters: {},
      }),
    ).toThrow(/not one of the declared sorts/);
  });
});
