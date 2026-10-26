import { describe, expect, it, vi } from "vitest";

// Phase 10 Task 14 (G8). The members page read `.limit(200)` and showed the
// first 200 with no sign there were more. listMembers now reads one row past
// MEMBERS_LIMIT and returns `more`, which the page renders as "Showing the
// first 200 members". The client is faked: a recording proxy per `.from()`.

interface Call {
  table: string;
  ops: [string, unknown[]][];
}
let calls: Call[] = [];
let memberships = 0;

function fakeClient() {
  return {
    from(table: string) {
      const call: Call = { table, ops: [] };
      calls.push(call);
      const chain: unknown = new Proxy({} as Record<string, unknown>, {
        get(_t, key) {
          if (key === "then") {
            const data =
              table === "organisation_memberships"
                ? Array.from({ length: memberships }, (_, i) => ({
                    id: `m-${i}`,
                    user_id: `u-${i}`,
                    role: "standard_user",
                    status: "active",
                    invited_at: "2026-01-01T00:00:00Z",
                    joined_at: null,
                  }))
                : [];
            return (resolve: (v: unknown) => unknown) => resolve({ data, error: null });
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
const { listMembers, MEMBERS_LIMIT } = await import("@/lib/org/members");

describe("the members list says when it stops (G8)", () => {
  it("201 memberships: 200 rows and `more`, from a read of 201", async () => {
    calls = [];
    memberships = MEMBERS_LIMIT + 1;
    const list = await listMembers("org");
    expect(list.outcome === "loaded" && [list.members.length, list.more]).toEqual([200, true]);
    expect(calls[0]!.ops.find(([op]) => op === "limit")?.[1][0]).toBe(201);
    // The profile names are looked up for the 200 shown, not the 201st.
    expect((calls[1]!.ops.find(([op]) => op === "in")?.[1][1] as string[]).length).toBe(200);
  });

  it("exactly 200: all of them, and no notice", async () => {
    calls = [];
    memberships = MEMBERS_LIMIT;
    const list = await listMembers("org");
    expect(list.outcome === "loaded" && [list.members.length, list.more]).toEqual([200, false]);
  });
});
