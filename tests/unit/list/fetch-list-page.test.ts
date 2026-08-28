import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Tests for `fetchListPage` -- the pagination logic itself, which had none.
//
// Review finding M-7: the allowlist, the cursor codec and the PostgREST
// encoders were covered thoroughly and the function that USES all three was
// not. The untested logic included the `pageSize + 1` sentinel, the
// `hasNext`/`hasPrevious` derivation (the source of I-1), the backward
// read-flip-and-reverse, the boundary-cursor extraction and the independent
// failure of the count. Two of the five Important findings in that review live
// in exactly those lines.
//
// `ListQuery` is declared structurally in lib/list/query.ts precisely so it can
// be faked, so this needs no database: the fake records every filter method it
// is handed and resolves to whatever rows the test supplies. That also makes
// the two PostgREST grammars assertable at the point of use -- the place where
// getting them the wrong way round returns a wrong page with a 200.

const supabaseFrom = vi.fn();
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ from: supabaseFrom }),
}));

const { fetchListPage } = await import("@/lib/list/query");
const { defineListSpec } = await import("@/lib/list/spec");
const { parseListParams } = await import("@/lib/list/params");
const { encodeCursor } = await import("@/lib/list/cursor");

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

const NIL = "00000000-0000-0000-0000-000000000000";
const uuid = (n: number) => `0000000${n}-0000-4000-8000-000000000000`;
const row = (n: number) => ({
  id: uuid(n),
  name: `Row ${n}`,
  updated_at: `2026-01-0${n}`,
});
const cursorFor = (value: string, n: number, sort = "name") =>
  encodeCursor({ value, id: uuid(n), sort });

interface Call {
  method: string;
  args: unknown[];
}
interface FakeResult {
  data?: unknown;
  error?: { message: string } | null;
  count?: number | null;
}

/** One faked PostgREST query: records its calls, resolves to `result`. */
function fakeQuery(result: FakeResult) {
  const calls: Call[] = [];
  const proxy: unknown = new Proxy({} as Record<string, unknown>, {
    get(_t, key) {
      if (key === "then") {
        return (resolve: (v: unknown) => void) =>
          resolve({
            data: result.data ?? null,
            error: result.error ?? null,
            count: result.count ?? null,
          });
      }
      return (...args: unknown[]) => {
        calls.push({ method: String(key), args });
        return proxy;
      };
    },
  });
  return { query: proxy, calls };
}

/**
 * Wires `supabase.from(table).select(...)` to a fake per KIND of query.
 *
 * Dispatching on what each query IS, rather than on the order it was built in.
 * The first version of this helper keyed off creation order and was wrong,
 * because `fetchListPage` builds the count query at its `const` and the page
 * query inside the `Promise.all` -- so the count is built FIRST, every fake was
 * off by one, and twenty tests failed with "the page query returned no data".
 * Dispatching on the select list cannot drift when that order changes.
 */
function stubQueries(results: {
  page?: FakeResult;
  count?: FakeResult;
  probe?: FakeResult;
  /** The re-run without the cursor. Defaults to whatever `page` returns. */
  recovery?: FakeResult;
}) {
  const made = {
    page: [] as { calls: Call[] }[],
    count: [] as { calls: Call[] }[],
    probe: [] as { calls: Call[] }[],
  };
  let pageCalls = 0;
  supabaseFrom.mockImplementation(() => ({
    select: (selectList: string, options?: { count?: string }) => {
      let kind: keyof typeof made;
      let spec: FakeResult | undefined;
      if (options?.count) {
        kind = "count";
        spec = results.count;
      } else if (selectList === "id") {
        kind = "probe";
        spec = results.probe;
      } else {
        kind = "page";
        // The second page query is the recovery re-run.
        spec =
          pageCalls++ === 0 ? results.page : (results.recovery ?? results.page);
      }
      const f = fakeQuery(spec ?? { data: [] });
      made[kind].push({ calls: f.calls });
      return f.query;
    },
  }));
  return made;
}

const baseOptions = {
  spec: SPEC,
  organisationId: "org-1",
  table: "contacts",
  select: "id, name, updated_at",
  mapRow: (raw: Record<string, unknown>) => ({
    id: String(raw.id),
    name: String(raw.name),
  }),
};

interface LoadedPage {
  outcome: "loaded";
  rows: { id: string; name: string }[];
  hasNext: boolean;
  hasPrevious: boolean;
  total: number | null;
  firstCursor: { value: string; id: string; sort: string } | null;
  lastCursor: { value: string; id: string; sort: string } | null;
  recovered: boolean;
}

/** Runs the function and asserts it loaded, so every test reads the same. */
async function load(rawParams: Record<string, string>): Promise<LoadedPage> {
  const page = await fetchListPage({
    ...baseOptions,
    params: parseListParams(SPEC, rawParams),
  });
  if (page.outcome !== "loaded") {
    throw new Error(`expected a loaded page, got "${page.outcome}"`);
  }
  return page as LoadedPage;
}

const arg = (calls: Call[], method: string) =>
  calls.find((c) => c.method === method)?.args;

beforeEach(() => {
  supabaseFrom.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("the pageSize + 1 sentinel", () => {
  it("asks for one more row than the page size", async () => {
    const made = stubQueries({ page: { data: [] }, count: { count: 0 } });
    await load({});
    expect(arg(made.page[0].calls, "limit")).toEqual([26]);
  });

  it("a FULL page (pageSize + 1 rows) reports hasNext and returns pageSize", async () => {
    stubQueries({
      page: { data: Array.from({ length: 26 }, (_, i) => row(i)) },
      count: { count: 100 },
    });
    const page = await load({});
    expect(page.rows).toHaveLength(25);
    expect(page.hasNext).toBe(true);
    expect(page.hasPrevious).toBe(false);
  });

  it("a SHORT page does not report hasNext", async () => {
    stubQueries({ page: { data: [row(1), row(2)] }, count: { count: 2 } });
    const page = await load({});
    expect(page.rows).toHaveLength(2);
    expect(page.hasNext).toBe(false);
  });

  it("an EXACTLY full page (pageSize rows, no spare) does not report hasNext", async () => {
    // The off-by-one that would repeat or skip a row at a page boundary.
    stubQueries({
      page: { data: Array.from({ length: 25 }, (_, i) => row(i)) },
      count: { count: 25 },
    });
    const page = await load({});
    expect(page.rows).toHaveLength(25);
    expect(page.hasNext).toBe(false);
  });

  it("honours a clamped page size", async () => {
    const made = stubQueries({ page: { data: [] }, count: { count: 0 } });
    await load({ size: "1000" });
    expect(arg(made.page[0].calls, "limit")).toEqual([51]);
  });
});

describe("the two PostgREST grammars, at the point of use", () => {
  it("emits the range hint top-level RAW and the tie-break QUOTED", async () => {
    const value = 'O\'Brien, "S")';
    const made = stubQueries({ page: { data: [row(1)] }, count: { count: 1 } });
    await load({ after: cursorFor(value, 3) });

    // Top-level values are LITERAL. Quoting here is what made page 2 return
    // page 1: `"` sorts below every letter, so the cursor matched from the
    // start of the table.
    expect(arg(made.page[0].calls, "filter")).toEqual(["name", "gte", value]);

    // Logic-tree values MUST be quoted, with \ and " escaped.
    expect(arg(made.page[0].calls, "or")?.[0]).toBe(
      `name.gt."O'Brien, \\"S\\")",and(name.eq."O'Brien, \\"S\\")",id.gt.${uuid(3)})`,
    );
  });

  it("flips both operators when reading backwards", async () => {
    const made = stubQueries({
      page: { data: [row(1)] },
      count: { count: 1 },
      probe: { data: [] },
    });
    await load({ before: cursorFor("Row 5", 5) });

    expect(arg(made.page[0].calls, "filter")).toEqual(["name", "lte", "Row 5"]);
    const or = String(arg(made.page[0].calls, "or")?.[0]);
    expect(or).toContain("name.lt.");
    expect(or).toContain(`id.lt.${uuid(5)}`);
  });

  it("orders by the sort column AND by id, in the reading direction", async () => {
    const made = stubQueries({ page: { data: [row(1)] }, count: { count: 1 } });
    await load({ sort: "updated" });
    expect(
      made.page[0].calls.filter((c) => c.method === "order").map((c) => c.args),
    ).toEqual([
      ["updated_at", { ascending: false }],
      ["id", { ascending: false }],
    ]);
  });

  it("always writes the tenant filter and the soft-delete filter, on BOTH queries", async () => {
    const made = stubQueries({ page: { data: [row(1)] }, count: { count: 1 } });
    await load({});
    for (const calls of [made.page[0].calls, made.count[0].calls]) {
      expect(arg(calls, "eq")).toEqual(["organisation_id", "org-1"]);
      expect(arg(calls, "is")).toEqual(["deleted_at", null]);
    }
  });

  it("escapes the search term's LIKE metacharacters", async () => {
    const made = stubQueries({ page: { data: [] }, count: { count: 0 } });
    await load({ q: "50% a_b" });
    expect(arg(made.page[0].calls, "ilike")).toEqual([
      "name",
      "%50\\% a\\_b%",
    ]);
  });

  it("the count carries the search but NOT the cursor", async () => {
    const made = stubQueries({ page: { data: [row(1)] }, count: { count: 7 } });
    await load({ q: "ada", after: cursorFor("Row 5", 5) });

    expect(arg(made.count[0].calls, "ilike")).toEqual(["name", "%ada%"]);
    // A cursored count would shrink as the user pages -- a number that
    // changes when nothing changed.
    expect(made.count[0].calls.some((c) => c.method === "or")).toBe(false);
    expect(made.count[0].calls.some((c) => c.method === "filter")).toBe(false);
  });
});

describe("paging backwards", () => {
  it("reverses the rows so they read in the user's order", async () => {
    // The query reads in reversed order, so the fake returns them reversed.
    stubQueries({
      page: { data: [row(3), row(2), row(1)] },
      count: { count: 9 },
      probe: { data: [{ id: uuid(9) }] },
    });
    const page = await load({ before: cursorFor("Row 9", 9) });
    expect(page.rows.map((r) => r.name)).toEqual(["Row 1", "Row 2", "Row 3"]);
  });

  it("the spare row on a backward page means hasPREVIOUS, not hasNext", async () => {
    stubQueries({
      page: { data: Array.from({ length: 26 }, (_, i) => row(i)) },
      count: { count: 100 },
      probe: { data: [{ id: uuid(9) }] },
    });
    const page = await load({ before: cursorFor("Row 9", 9) });
    expect(page.hasPrevious).toBe(true);
  });

  // ------------------------------------------------------------------
  // Review I-1, second half. `hasNext` was the literal `true` for every
  // backward page -- an assumption about how the page was reached, stated as
  // a fact in a comment. Land on a `before` page that happens to be the end
  // of the list and the app offered a Next into an empty screen.
  // ------------------------------------------------------------------
  it("hasNext comes from a real probe, not from an assumption", async () => {
    stubQueries({
      page: { data: [row(1), row(2)] },
      count: { count: 9 },
      probe: { data: [] }, // nothing at or after the cursor any more
    });
    const page = await load({ before: cursorFor("Row 9", 9) });
    expect(page.hasNext).toBe(false);
  });

  it("...and is true when the probe finds a row", async () => {
    stubQueries({
      page: { data: [row(1), row(2)] },
      count: { count: 9 },
      probe: { data: [{ id: uuid(9) }] },
    });
    const page = await load({ before: cursorFor("Row 9", 9) });
    expect(page.hasNext).toBe(true);
  });

  it("the probe asks at-or-after the cursor, reading FORWARDS", async () => {
    const made = stubQueries({
      page: { data: [row(1)] },
      count: { count: 9 },
      probe: { data: [{ id: uuid(9) }] },
    });
    await load({ before: cursorFor("Row 9", 9) });

    // Forward direction (the list's own `dir`, not the reversed read), and
    // the id comparison is INCLUSIVE: if the row we came back from still
    // exists, there is a next page.
    expect(arg(made.probe[0].calls, "filter")).toEqual(["name", "gte", "Row 9"]);
    expect(String(arg(made.probe[0].calls, "or")?.[0])).toContain(
      `id.gte.${uuid(9)}`,
    );
    expect(arg(made.probe[0].calls, "limit")).toEqual([1]);
  });

  it("no probe is issued on a forward page", async () => {
    const made = stubQueries({ page: { data: [row(1)] }, count: { count: 1 } });
    await load({ after: cursorFor("Row 1", 1) });
    expect(made.probe).toHaveLength(0);
  });

  it("a failed probe stays optimistic and says so", async () => {
    stubQueries({
      page: { data: [row(1)] },
      count: { count: 9 },
      probe: { data: null, error: { message: "probe boom" } },
    });
    const page = await load({ before: cursorFor("Row 9", 9) });
    expect(page.hasNext).toBe(true);
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("next-page probe failed"),
      expect.stringContaining("probe boom"),
    );
  });
});

describe("a cursor that lands past the data", () => {
  // ------------------------------------------------------------------
  // Review I-1. Reproduced three ways in a workspace of 20,220 contacts:
  // "No contacts yet", no table, no pager, no way back. Fixed HERE rather
  // than in the component, so no entity page can get it wrong -- Task 4
  // copies EntityList five times.
  // ------------------------------------------------------------------
  it("re-runs without the cursor and reports that it did", async () => {
    const made = stubQueries({
      page: { data: [] }, // the cursored page: nothing there
      count: { count: 500 },
      recovery: { data: [row(1), row(2), row(3)] },
    });
    const page = await load({ after: cursorFor("zzz", 9) });

    expect(page.rows).toHaveLength(3);
    expect(page.recovered).toBe(true);
    // ...and the recovery query carries NO cursor.
    expect(made.page[1].calls.some((c) => c.method === "or")).toBe(false);
    expect(made.page[1].calls.some((c) => c.method === "filter")).toBe(false);
  });

  it("the recovered page is page one: nothing behind it", async () => {
    stubQueries({
      page: { data: [] },
      count: { count: 500 },
      recovery: { data: [row(1), row(2)] },
    });
    const page = await load({ after: cursorFor("zzz", 9) });
    expect(page.hasPrevious).toBe(false);
    expect(page.hasNext).toBe(false);
  });

  it("recovers from a dead BACKWARD cursor too, discarding the probe", async () => {
    stubQueries({
      page: { data: [] },
      count: { count: 500 },
      probe: { data: [{ id: uuid(9) }] }, // would have said "next exists"
      recovery: { data: [row(1)] },
    });
    const page = await load({ before: cursorFor("aaa", 1) });
    expect(page.recovered).toBe(true);
    expect(page.rows).toHaveLength(1);
    expect(page.hasNext).toBe(false);
    expect(page.hasPrevious).toBe(false);
  });

  it("an EMPTY TENANT is not a recovery -- no cursor, no re-run", async () => {
    // The distinction I-1 turned on: "no records" and "bad cursor" produce
    // the same rows and must not produce the same screen.
    const made = stubQueries({ page: { data: [] }, count: { count: 0 } });
    const page = await load({});
    expect(page.recovered).toBe(false);
    expect(page.rows).toHaveLength(0);
    expect(made.page).toHaveLength(1);
  });
});

describe("boundary cursors", () => {
  it("are the first and last rows, tagged with the sort they came from", async () => {
    stubQueries({ page: { data: [row(1), row(2), row(3)] }, count: { count: 3 } });
    const page = await load({});
    expect(page.firstCursor).toEqual({
      value: "Row 1",
      id: uuid(1),
      sort: "name",
    });
    expect(page.lastCursor).toEqual({
      value: "Row 3",
      id: uuid(3),
      sort: "name",
    });
  });

  // Review M-6: this used to come from a per-entity ternary whose `else`
  // branch was a catch-all, so a sort the entity forgot produced cursors
  // carrying the wrong column's value. It now comes from the spec.
  it("read the SPEC's column, not a hand-written per-entity map", async () => {
    stubQueries({ page: { data: [row(1), row(2)] }, count: { count: 2 } });
    const page = await load({ sort: "updated" });
    expect(page.firstCursor).toEqual({
      value: "2026-01-01",
      id: uuid(1),
      sort: "updated",
    });
  });

  it("are null on an empty page", async () => {
    stubQueries({ page: { data: [] }, count: { count: 0 } });
    const page = await load({});
    expect(page.firstCursor).toBeNull();
    expect(page.lastCursor).toBeNull();
  });

  it("complain loudly when the sort column is missing from the select", async () => {
    // Silently, this produces cursors whose value is the string "undefined"
    // and a list that pages in circles.
    stubQueries({ page: { data: [{ id: uuid(1) }] }, count: { count: 1 } });
    await load({});
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("is not in the select list"),
    );
  });
});

describe("failure is not emptiness", () => {
  it("a failed page query is `unavailable`, never zero rows", async () => {
    stubQueries({
      page: { data: null, error: { message: "boom" } },
      count: { count: 0 },
    });
    const page = await fetchListPage({
      ...baseOptions,
      params: parseListParams(SPEC, {}),
    });
    expect(page.outcome).toBe("unavailable");
  });

  it("a failed COUNT still renders the page, with no total", async () => {
    stubQueries({
      page: { data: [row(1)] },
      count: { data: null, error: { message: "count boom" }, count: null },
    });
    const page = await load({});
    expect(page.rows).toHaveLength(1);
    expect(page.total).toBeNull();
  });

  it("a failed RECOVERY query is `unavailable`, not a silent empty list", async () => {
    stubQueries({
      page: { data: [] },
      count: { count: 500 },
      recovery: { data: null, error: { message: "recovery boom" } },
    });
    const page = await fetchListPage({
      ...baseOptions,
      params: parseListParams(SPEC, { after: cursorFor("zzz", 9) }),
    });
    expect(page.outcome).toBe("unavailable");
  });

  it("logs the message only -- never the rows", async () => {
    stubQueries({
      page: { data: null, error: { message: "boom" } },
      count: { count: 0 },
    });
    await fetchListPage({
      ...baseOptions,
      params: parseListParams(SPEC, {}),
    });
    const logged = vi.mocked(console.error).mock.calls.flat().join(" ");
    expect(logged).toContain("boom");
    expect(logged).not.toContain("Row 1");
  });
});

describe("filters reach both the page and the count", () => {
  it("applyFilters is called for each", async () => {
    const made = stubQueries({ page: { data: [row(1)] }, count: { count: 1 } });
    const seen: string[] = [];
    await fetchListPage({
      ...baseOptions,
      params: parseListParams(SPEC, { owner: "mine" }),
      applyFilters: (q, filters) => {
        seen.push(filters.owner);
        return q.eq("owner_user_id", NIL);
      },
    });
    // Once for the page, once for the count -- a filter applied to only one
    // makes the total disagree with the rows under it.
    expect(seen).toEqual(["mine", "mine"]);
    expect(made.count[0].calls.filter((c) => c.method === "eq")).toHaveLength(2);
  });
});
