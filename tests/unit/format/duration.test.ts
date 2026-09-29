// formatRetryAfter — the "try again in …" copy every rate-limit refusal shares.
//
// Fix round 1, minor M2: refusals rendered `retryAfterSeconds` raw, which is
// fine for the 60-second budgets and produced "Try again in 3,541 seconds" on
// the hour-long connection-request budget. These tests pin the two things that
// make the sentence trustworthy — the thresholds, and that it never rounds
// DOWN into advice that would be refused again.
import { describe, expect, it } from "vitest";
import { formatRetryAfter } from "@/lib/format/duration";

describe("formatRetryAfter", () => {
  it("keeps seconds while seconds are actionable", () => {
    expect(formatRetryAfter(1)).toBe("1 second");
    expect(formatRetryAfter(45)).toBe("45 seconds");
    expect(formatRetryAfter(119)).toBe("119 seconds");
  });

  it("switches to minutes past two, which is the M2 case", () => {
    expect(formatRetryAfter(120)).toBe("2 minutes");
    // The exact number from the review: one minute into a 3,600-second window.
    expect(formatRetryAfter(3541)).toBe("60 minutes");
    expect(formatRetryAfter(3600)).toBe("60 minutes");
  });

  it("switches to hours only past ninety minutes", () => {
    expect(formatRetryAfter(5399)).toBe("90 minutes");
    expect(formatRetryAfter(5400)).toBe("2 hours");
    expect(formatRetryAfter(7200)).toBe("2 hours");
  });

  it("ALWAYS ROUNDS UP — advice that is early is advice that is refused again", () => {
    expect(formatRetryAfter(121)).toBe("3 minutes");
    expect(formatRetryAfter(180.1)).toBe("4 minutes");
  });

  it("clamps nonsense rather than throwing on a refusal path", () => {
    expect(formatRetryAfter(0)).toBe("0 seconds");
    expect(formatRetryAfter(-5)).toBe("0 seconds");
    expect(formatRetryAfter(Number.NaN)).toBe("0 seconds");
    expect(formatRetryAfter(Number.POSITIVE_INFINITY)).toBe("0 seconds");
  });
});
