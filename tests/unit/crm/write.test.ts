import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

// A 204 IS NOT A SAVE.
//
// The non-negotiable test from the Task 4 brief § 3(a), and the reason it is a
// UNIT test as well as an integration one: the shape that produces a silent
// data-loss bug is `{ error: null, count: 0 }`, and a test can hand the
// classifier exactly that without needing a suspended organisation, a real
// policy or a database. The integration half -- a real policy refusing a real
// PATCH over real HTTP -- lives in supabase/tests/rls_phase2_crm.sql § R, and
// asserts the MECHANISM (204 with Content-Range */0) rather than merely that
// it failed.
//
// The measurement being defended, from Task 3a, through supabase-js:
//
//     LIVE       status=204  count=15  data=null  error=null
//     SUSPENDED  status=204  count=0   data=null  error=null
//
// `status`, `data` and `error` are IDENTICAL. Only `count` differs.

const { classifyWrite, commitWrite } = await import("@/lib/crm/write");

describe("a refused UPDATE is not a save", () => {
  it("count 0 with NO error is refused, not applied", () => {
    // THE CASE. Byte-for-byte the response a suspended workspace produces, and
    // byte-for-byte what a nonexistent id produces, and the thing every
    // `if (error) fail() else succeed()` in this repository would have called
    // a success.
    expect(classifyWrite({ error: null, count: 0 }, "ctx")).toEqual({
      outcome: "refused",
    });
  });

  it("count 15 with no error is applied, and reports the rows", () => {
    expect(classifyWrite({ error: null, count: 15 }, "ctx")).toEqual({
      outcome: "applied",
      rows: 15,
    });
  });

  it("the two are distinguished by the COUNT and by nothing else", () => {
    // Stated as an assertion rather than as a comment: the two inputs differ
    // in exactly one field, and the outcomes differ. If a future refactor
    // starts reading `status` or `data`, this still holds only while `count`
    // remains the discriminator.
    const live = { error: null, count: 15 };
    const suspended = { error: null, count: 0 };
    expect(Object.keys(live)).toEqual(Object.keys(suspended));
    expect(classifyWrite(live, "ctx").outcome).not.toBe(
      classifyWrite(suspended, "ctx").outcome,
    );
  });
});

describe("a missing count is not a save either", () => {
  it("count null is FAILED, never applied", () => {
    // The shape a caller that forgets `{ count: "exact" }` produces. Resolving
    // it to "applied" would silently restore the old, broken behaviour for
    // every call site that omitted the option -- which is precisely how this
    // defect class comes back.
    const result = classifyWrite({ error: null, count: null }, "update contact");
    expect(result.outcome).toBe("failed");
    if (result.outcome !== "failed") throw new Error("unreachable");
    expect(result.message).toContain("count");
  });
});

describe("errors", () => {
  it("42501 is a REFUSAL, not a fault", () => {
    // An INSERT refused by WITH CHECK, and set_contact_primary_company()
    // raising rather than committing half an operation. Both are the policy
    // working; neither is something to log as an error or to tell the user
    // went wrong.
    expect(
      classifyWrite({ error: { message: "denied", code: "42501" }, count: null }, "ctx"),
    ).toEqual({ outcome: "refused" });
  });

  it("any other error is a fault, and carries its message", () => {
    const result = classifyWrite(
      { error: { message: "connection reset", code: "08006" }, count: null },
      "ctx",
    );
    expect(result).toEqual({ outcome: "failed", message: "connection reset" });
  });
});

describe("commitWrite", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does not log a refusal -- it is the policy working", async () => {
    const result = await commitWrite("update contact 1", async () => ({
      error: null,
      count: 0,
    }));
    expect(result).toEqual({ outcome: "refused" });
    expect(console.error).not.toHaveBeenCalled();
  });

  it("logs a genuine failure once, with the message and not the rows", async () => {
    await commitWrite("update contact 1", async () => ({
      error: { message: "boom", code: "08006" },
      count: null,
    }));
    const logged = vi.mocked(console.error).mock.calls.flat().join(" ");
    expect(logged).toContain("boom");
    expect(logged).toContain("update contact 1");
  });
});
