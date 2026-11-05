import { beforeEach, describe, expect, it, vi } from "vitest";

// Phase 10 Task 14 (G5). The custom-field reads grow with a workspace's
// definitions (Pro is unlimited; removed ones accumulate), and PostgREST cuts
// any response at max_rows (1000) without an error. Each read is bounded, and
// one that reaches its bound refuses (`reason: "too_many"`) rather than
// returning a short list a form would then save over.
//
// The client is faked: a recording proxy that answers each `.from(table)`
// chain from `respond`, so the bound each query carries is asserted directly.

interface Call {
  table: string;
  ops: [string, unknown[]][];
}
interface Answer {
  data?: unknown[] | null;
  error?: { message: string } | null;
  count?: number | null;
}

let calls: Call[] = [];
let respond: (call: Call) => Answer = () => ({ data: [] });

function fakeClient() {
  return {
    from(table: string) {
      const call: Call = { table, ops: [] };
      calls.push(call);
      const chain: unknown = new Proxy({} as Record<string, unknown>, {
        get(_t, key) {
          if (key === "then") {
            const a = respond(call);
            const result = { data: a.data ?? null, error: a.error ?? null, count: a.count ?? null };
            return (resolve: (v: unknown) => unknown) => resolve(result);
          }
          return (...args: unknown[]) => {
            call.ops.push([String(key), args]);
            return chain;
          };
        },
      });
      return chain;
    },
  };
}

vi.mock("@/lib/supabase/server", () => ({ createClient: async () => fakeClient() }));

const {
  CUSTOM_FIELD_READ_CEILING,
  POSTGREST_MAX_ROWS,
  loadCustomFieldCellsForEntities,
  loadCustomFieldCounts,
  loadCustomFieldDefinitions,
  loadCustomFieldPanel,
} = await import("@/lib/crm/custom-field-queries");
const { loadRecordPair } = await import("@/lib/crm/dedup");

const ORG = "11111111-1111-4111-8111-111111111111";
const KEEP = "22222222-2222-4222-8222-222222222222";
const DUP = "33333333-3333-4333-8333-333333333333";

const definitions = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    id: `def-${i}`,
    entity_type: "contact",
    key: `k${i}`,
    label: `Field ${String(i).padStart(4, "0")}`,
    field_type: "text",
    options: null,
    deleted_at: null,
  }));
const values = (n: number) => Array.from({ length: n }, (_, i) => ({ entity_id: KEEP, field_id: `def-${i}`, value: "x" }));
const limitOf = (call: Call | undefined) => call?.ops.find(([op]) => op === "limit")?.[1][0];

beforeEach(() => {
  calls = [];
  respond = () => ({ data: [] });
});

describe("custom field reads are bounded and fail loud (G5)", () => {
  it("definitions: asks for ceiling + 1, and refuses at 501", async () => {
    respond = () => ({ data: definitions(CUSTOM_FIELD_READ_CEILING + 1) });
    expect(await loadCustomFieldDefinitions(ORG, "contact")).toEqual({ outcome: "unavailable", reason: "too_many" });
    expect(limitOf(calls[0])).toBe(501);
  });

  it("definitions: 500 is a whole list", async () => {
    respond = () => ({ data: definitions(CUSTOM_FIELD_READ_CEILING) });
    const result = await loadCustomFieldDefinitions(ORG, "contact");
    expect(result.outcome === "loaded" && result.definitions.length).toBe(500);
  });

  it("counts: one head-only count per entity type, no rows read", async () => {
    respond = () => ({ count: 7 });
    const result = await loadCustomFieldCounts(ORG);
    expect(result.outcome === "loaded" && Object.values(result.counts).every((c) => c === 7)).toBe(true);
    for (const call of calls) {
      expect(call.ops.find(([op]) => op === "select")?.[1][1]).toEqual({ count: "exact", head: true });
    }
  });

  it("counts: a failed count is unavailable, not zero", async () => {
    respond = () => ({ count: null, error: { message: "boom" } });
    expect(await loadCustomFieldCounts(ORG)).toEqual({ outcome: "unavailable" });
  });

  it("panel: one entity's values are capped too", async () => {
    respond = (c) => ({ data: c.table === "custom_field_values" ? values(501) : definitions(3) });
    expect(await loadCustomFieldPanel(ORG, "contact", KEEP)).toEqual({ outcome: "unavailable", reason: "too_many" });
    expect(limitOf(calls.find((c) => c.table === "custom_field_values"))).toBe(501);
  });

  it("panel: too many definitions is too many", async () => {
    respond = (c) => ({ data: c.table === "custom_field_values" ? [] : definitions(501) });
    expect(await loadCustomFieldPanel(ORG, "contact", KEEP)).toEqual({ outcome: "unavailable", reason: "too_many" });
  });

  it("batch: chunks a page so no request can pass max_rows", async () => {
    respond = (c) => ({ data: c.table === "custom_field_values" ? [] : definitions(20) });
    const ids = Array.from({ length: 50 }, (_, i) => `e-${i}`);
    expect((await loadCustomFieldCellsForEntities(ORG, "contact", ids)).outcome).toBe("loaded");
    const reads = calls.filter((c) => c.table === "custom_field_values");
    // floor(999 / 20) = 49 ids per request: 49 + 1.
    expect(reads.map((c) => (c.ops.find(([op]) => op === "in")?.[1][1] as string[]).length)).toEqual([49, 1]);
    for (const c of reads) expect(limitOf(c)).toBe(POSTGREST_MAX_ROWS);
  });

  it("batch: a chunk that fills max_rows was cut short, and is refused", async () => {
    respond = (c) => ({ data: c.table === "custom_field_values" ? values(POSTGREST_MAX_ROWS) : definitions(20) });
    expect(await loadCustomFieldCellsForEntities(ORG, "contact", ["e-1"])).toEqual({ outcome: "unavailable", reason: "too_many" });
  });

  it("merge pair: refuses rather than merge over a truncated field list", async () => {
    const records = [
      { id: KEEP, name: "A", created_at: "2026-01-01", deleted_at: null },
      { id: DUP, name: "B", created_at: "2026-01-02", deleted_at: null },
    ];
    respond = (c) => ({
      data: c.table === "custom_field_definitions" ? definitions(501) : c.table === "custom_field_values" ? [] : records,
    });
    expect(await loadRecordPair(ORG, "contact", KEEP, DUP)).toBeNull();
    expect(limitOf(calls.find((c) => c.table === "custom_field_definitions"))).toBe(501);
    expect(limitOf(calls.find((c) => c.table === "custom_field_values"))).toBe(POSTGREST_MAX_ROWS);

    respond = (c) => ({
      data: c.table === "custom_field_definitions" ? definitions(2) : c.table === "custom_field_values" ? values(POSTGREST_MAX_ROWS) : records,
    });
    expect(await loadRecordPair(ORG, "contact", KEEP, DUP)).toBeNull();

    respond = (c) => ({
      data: c.table === "custom_field_definitions" ? definitions(2) : c.table === "custom_field_values" ? values(2) : records,
    });
    expect((await loadRecordPair(ORG, "contact", KEEP, DUP))?.definitions).toHaveLength(2);
  });
});
