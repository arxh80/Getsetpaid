import { describe, expect, it, vi } from "vitest";

// Phase 10 Task 14 (G6, Task 1 re-review). loadPublishableEntities' comment
// always said a failed "already published" read offers NOTHING; the code
// returned an empty exclusion list, which offered EVERY record, including ones
// that already have a live profile. A failed read is faked here because no
// fixture makes a well-formed read fail.

let failTable = "";
function fakeClient() {
  return {
    from(table: string) {
      const chain: unknown = new Proxy({} as Record<string, unknown>, {
        get(_t, key) {
          if (key === "then") {
            const result =
              table === failTable
                ? { data: null, error: { message: "boom" } }
                : { data: table === "network_profiles" ? [] : [{ id: "v1", name: "Venue One" }], error: null };
            return (resolve: (v: unknown) => unknown) => resolve(result);
          }
          return () => chain;
        },
      });
      return chain;
    },
  };
}

vi.mock("@/lib/supabase/server", () => ({ createClient: async () => fakeClient() }));
const { loadPublishableEntities } = await import("@/lib/network/entities");

describe("the publish picker fails closed", () => {
  it("offers a record when both reads succeed (positive control)", async () => {
    failTable = "";
    expect(await loadPublishableEntities("org", "venue")).toEqual([{ id: "v1", name: "Venue One" }]);
  });

  it("offers nothing when the existing-profile read fails", async () => {
    failTable = "network_profiles";
    expect(await loadPublishableEntities("org", "venue")).toEqual([]);
  });

  it("offers nothing when the records read fails", async () => {
    failTable = "venues";
    expect(await loadPublishableEntities("org", "venue")).toEqual([]);
  });
});
