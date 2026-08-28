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

const {
  classifyWrite,
  commitWrite,
  CONFLICT_MESSAGE,
  FAILED_MESSAGE,
  UNKNOWN_MESSAGE,
} = await import("@/lib/crm/write");

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
  it("count null is UNKNOWN, never applied", () => {
    // The shape a caller that forgets `{ count: "exact" }` produces. Resolving
    // it to "applied" would silently restore the old, broken behaviour for
    // every call site that omitted the option -- which is precisely how this
    // defect class comes back.
    const result = classifyWrite({ error: null, count: null }, "update contact");
    expect(result.outcome).toBe("unknown");
    if (result.outcome !== "unknown") throw new Error("unreachable");
    expect(result.message).toContain("count");
  });

  it("...and UNKNOWN is a different outcome from FAILED, on purpose", () => {
    // THE SENTENCE IS THE REASON. `FAILED_MESSAGE` ends "Nothing has been
    // changed"; the review dropped `{ count: "exact" }` from a save, watched
    // every save report exactly that, and then read the row -- which HAD
    // changed. Fail-safe, and false in its second sentence. Collapsing these
    // two outcomes back together brings the false sentence back with them.
    expect(classifyWrite({ error: null, count: null }, "ctx").outcome).not.toBe(
      classifyWrite({ error: { message: "boom", code: "08006" }, count: null }, "ctx")
        .outcome,
    );
    expect(UNKNOWN_MESSAGE).not.toContain("Nothing has been changed");
    expect(FAILED_MESSAGE).toContain("Nothing has been changed");
  });
});

describe("a lost race is not an outage", () => {
  it("23505 is a CONFLICT, not a fault", () => {
    // Measured in the Task 4 review: two overlapping transactions promoting
    // different companies on the same contact. No deadlock, never two
    // primaries, never zero -- the loser's whole transaction rolls back, which
    // is the property set_contact_primary_company() exists for. What the loser
    // got was `duplicate key value violates unique constraint
    // contact_companies_one_primary_per_contact`, rendered as "we couldn't
    // save that just now", which reads as an outage rather than as somebody
    // else having just changed it.
    expect(
      classifyWrite(
        {
          error: {
            message:
              'duplicate key value violates unique constraint "contact_companies_one_primary_per_contact"',
            code: "23505",
          },
          count: null,
        },
        "set primary company",
      ),
    ).toEqual({ outcome: "conflict" });
  });

  it("...and the message tells the user to reload rather than to wait", () => {
    // The two situations have different next moves, which is the whole reason
    // they are different outcomes: a fault is retried, a conflict is re-read.
    expect(CONFLICT_MESSAGE).toContain("Reload");
    expect(CONFLICT_MESSAGE).not.toBe(FAILED_MESSAGE);
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

  it("does not log a conflict -- two people working at once is the product working", async () => {
    const result = await commitWrite("set primary company", async () => ({
      error: { message: "duplicate key value", code: "23505" },
      count: null,
    }));
    expect(result).toEqual({ outcome: "conflict" });
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

  it("logs an UNKNOWN too -- it is this repository's bug, not the database's", async () => {
    // A call site that forgot `{ count: "exact" }`. The user gets a message
    // that does not guess; the developer gets a line naming the call site.
    const result = await commitWrite("update contact 1", async () => ({
      error: null,
      count: null,
    }));
    expect(result.outcome).toBe("unknown");
    expect(vi.mocked(console.error).mock.calls.flat().join(" ")).toContain(
      "update contact 1",
    );
  });
});
