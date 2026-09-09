// THE APPLICATION HALF OF SECURITY.md § 5's LIMITER.
//
// ===========================================================================
// WHAT IS TESTED WHERE, AND WHY THE SPLIT FALLS EXACTLY HERE
// ===========================================================================
// The window arithmetic, the atomic increment and the verdict all live in
// Postgres (20260909020000). They are measured where they live, against a real
// database, in `supabase/tests/rls_phase7_rate_limits.sql` -- § RW for the
// boundary and reset behaviour of `private.rate_limit_window_start()`, § RC for
// counter integrity including the concurrent-increment semantics, § RS for the
// wrapper's scope binding. Restating any of that here against a mock would
// prove only that the mock agrees with itself.
//
// What CANNOT be measured there, and is measured here, is the posture this
// module adds on top of the RPC: what it does when the RPC does not answer
// properly. That is pure decision logic over a returned value, it has no
// database in it, and it is exactly the branch a real stack will not enter on
// demand -- you cannot ask a healthy Postgres to return a malformed row.
//
// `tests/integration/security/rate-limit-network-discovery.test.ts` closes the
// third side: the two halves wired together, against the real stack, through
// the real enforcement point.
import { afterEach, describe, expect, it, vi } from "vitest";

const rpc = vi.hoisted(() => ({
  fn: vi.fn(),
  calls: [] as Array<{ name: string; args: unknown }>,
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    rpc: (name: string, args: unknown) => {
      rpc.calls.push({ name, args });
      return rpc.fn(name, args);
    },
  }),
}));

import { consumeRateLimit } from "@/lib/security/rate-limit";

/** The RPC's happy shape: PostgREST returns a `returns table` as an array. */
function returns(rows: unknown) {
  rpc.fn.mockResolvedValue({ data: rows, error: null });
}

function fails(message: string) {
  rpc.fn.mockResolvedValue({ data: null, error: { message } });
}

afterEach(() => {
  rpc.fn.mockReset();
  rpc.calls.length = 0;
  vi.restoreAllMocks();
});

describe("consumeRateLimit — what it asks the database", () => {
  it("names the category and, for a user-scoped one, sends no organisation", async () => {
    returns([{ allowed: true, retry_after_seconds: 0, request_count: 1 }]);
    await consumeRateLimit("search");
    expect(rpc.calls).toHaveLength(1);
    expect(rpc.calls[0].name).toBe("consume_rate_limit");
    // The organisation argument is OMITTED, not sent as null/undefined: the
    // RPC's own default is what decides the scope, and a caller who cannot
    // name an organisation must not look like one who named nothing.
    expect(rpc.calls[0].args).toEqual({ p_category: "search" });
    expect(Object.keys(rpc.calls[0].args as object)).not.toContain(
      "p_organisation_id",
    );
  });

  it("passes an organisation through for the org-scoped category", async () => {
    returns([{ allowed: true, retry_after_seconds: 0, request_count: 1 }]);
    await consumeRateLimit("exports", "11111111-2222-4333-8444-555555555555");
    expect(rpc.calls[0].args).toEqual({
      p_category: "exports",
      p_organisation_id: "11111111-2222-4333-8444-555555555555",
    });
  });

  it("sends an ORGANISATION for the connection-request budget, never a user", async () => {
    // Q79/Q112. The budget binds the workspace, not the person: a per-user
    // budget is bypassed by inviting a colleague. If a refactor ever dropped
    // the organisation argument here the RPC would refuse with 22023 rather
    // than fall back to the caller -- but it would refuse EVERY request, so
    // the failure would be loud. This pins the intended shape anyway.
    returns([{ allowed: true, retry_after_seconds: 0, request_count: 1 }]);
    await consumeRateLimit(
      "network_connection_request",
      "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    );
    expect(rpc.calls[0].args).toEqual({
      p_category: "network_connection_request",
      p_organisation_id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    });
  });

  it("meters the NAMED network-discovery category under its own name", async () => {
    // SECURITY.md § 5's network-discovery row is deliberately not folded into
    // 'search' (FOLLOW-UPS:3408-3419). If a refactor ever collapsed the two,
    // the budget would silently become 60/min over an O(platform) path.
    returns([{ allowed: true, retry_after_seconds: 0, request_count: 1 }]);
    await consumeRateLimit("network_discovery");
    expect(rpc.calls[0].args).toEqual({ p_category: "network_discovery" });
  });
});

describe("consumeRateLimit — reading a well-formed verdict", () => {
  it("allows when the database allows", async () => {
    returns([{ allowed: true, retry_after_seconds: 0, request_count: 4 }]);
    await expect(consumeRateLimit("search")).resolves.toEqual({
      allowed: true,
    });
  });

  it("refuses when the database refuses, carrying the real remainder", async () => {
    returns([{ allowed: false, retry_after_seconds: 37, request_count: 61 }]);
    await expect(consumeRateLimit("search")).resolves.toEqual({
      allowed: false,
      retryAfterSeconds: 37,
    });
  });

  it("accepts a single object as well as a one-row array", async () => {
    // supabase-js unwraps a `returns table` differently depending on whether
    // the RPC is declared as returning a set; both shapes are handled, and a
    // change in that behaviour must not read as a limiter outage.
    returns({ allowed: false, retry_after_seconds: 12, request_count: 31 });
    await expect(consumeRateLimit("network_discovery")).resolves.toEqual({
      allowed: false,
      retryAfterSeconds: 12,
    });
  });

  it("takes a zero remainder literally — the window is turning over now", async () => {
    returns([{ allowed: false, retry_after_seconds: 0, request_count: 31 }]);
    await expect(consumeRateLimit("search")).resolves.toEqual({
      allowed: false,
      retryAfterSeconds: 0,
    });
  });
});

describe("consumeRateLimit — FAILING CLOSED", () => {
  // The posture the module's header commits to, and the reason it is a
  // separate decision from the verdict: an outage in the limiter must not
  // become the unmetered state § 5 exists to close. Every branch below has to
  // refuse, and each one is a different way for the RPC not to answer.
  const FAIL_CLOSED = { allowed: false, retryAfterSeconds: 60 };

  it("refuses when the RPC errors", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    fails('permission denied for function consume_rate_limit');
    await expect(consumeRateLimit("search")).resolves.toEqual(FAIL_CLOSED);
    // Logged loudly: a real outage must read as a spike in the server log,
    // not as a mystery wave of refusals with no cause recorded anywhere.
    expect(err).toHaveBeenCalledOnce();
    expect(String(err.mock.calls[0][0])).toContain("failing CLOSED");
  });

  it("refuses when the RPC returns no row", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    returns([]);
    await expect(consumeRateLimit("search")).resolves.toEqual(FAIL_CLOSED);
    expect(err).toHaveBeenCalledOnce();
  });

  it("refuses when the RPC returns null", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    returns(null);
    await expect(consumeRateLimit("feedback")).resolves.toEqual(FAIL_CLOSED);
  });

  it("refuses when `allowed` is missing", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    returns([{ retry_after_seconds: 5 }]);
    await expect(consumeRateLimit("search")).resolves.toEqual(FAIL_CLOSED);
  });

  it("refuses when `allowed` is a TRUTHY non-boolean", async () => {
    // The nastiest shape: `"true"`, `1` and `{}` are all truthy, so a
    // permissive read would wave the request through on a contract break.
    // The check is `typeof === "boolean"` precisely so it cannot.
    vi.spyOn(console, "error").mockImplementation(() => {});
    for (const truthy of ["true", 1, {}, []]) {
      rpc.fn.mockResolvedValue({
        data: [{ allowed: truthy, retry_after_seconds: 0 }],
        error: null,
      });
      await expect(consumeRateLimit("search")).resolves.toEqual(FAIL_CLOSED);
    }
  });
});

describe("consumeRateLimit — the retry hint is never nonsense", () => {
  // A refusal's remainder reaches a person as "try again in N seconds". A
  // negative, NaN or non-numeric N would render as broken copy, and a null
  // one would render as "try again in null seconds" -- so an unusable value
  // falls back to the honest upper bound rather than being displayed.
  it.each([
    ["negative", -5],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["a string", "30"],
    ["null", null],
    ["absent", undefined],
  ])("falls back to 60 when the remainder is %s", async (_label, value) => {
    returns([{ allowed: false, retry_after_seconds: value }]);
    await expect(consumeRateLimit("network_discovery")).resolves.toEqual({
      allowed: false,
      retryAfterSeconds: 60,
    });
  });

  it("does NOT fall back for a legitimately large remainder", async () => {
    // feedback's window is an hour; a 3599-second remainder is correct there
    // and must survive, or the hint would under-report by a factor of 60.
    returns([{ allowed: false, retry_after_seconds: 3599 }]);
    await expect(consumeRateLimit("feedback")).resolves.toEqual({
      allowed: false,
      retryAfterSeconds: 3599,
    });
  });
});
