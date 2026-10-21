import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { notFound, redirect, unstable_rethrow } from "next/navigation";
import { describe, expect, it } from "vitest";
import {
  ACTION_FAILED_MESSAGE,
  nextOutcome,
  runReported,
  type Outcome,
} from "@/components/admin/legal-editor-outcome";
import type { FormState } from "@/lib/forms";

// PHASE 8 TASK 1, FIX ROUND 2: the legal editor's outcome region.
//
// tests/unit has no DOM, so the logic lives in two pure functions the
// component is a thin shell over: nextOutcome() (what the region shows) and
// runReported() (how an action's result, or its rejection, reaches it). The
// real Next.js unstable_rethrow and redirect()/notFound() are used, so "a
// redirect is re-thrown" is proved against Next's own signal, not a stand-in.

/** Replays every report into the region's reducer, as the provider does. */
function region() {
  let outcome: Outcome = null;
  const reports: FormState[] = [];
  return {
    report: (state: FormState) => {
      reports.push(state);
      outcome = nextOutcome(outcome, state);
    },
    get outcome() {
      return outcome;
    },
    reports,
  };
}

const PREV: FormState = { values: { title: "typed" } } as FormState;
const FORM = new FormData();

describe("nextOutcome: every outcome is a fresh announcement", () => {
  it("gives two identical messages different keys, so the second replaces the node", () => {
    const first = nextOutcome(null, { message: "Draft saved." });
    const second = nextOutcome(first, { message: "Draft saved." });
    expect(first).toMatchObject({ tone: "success", text: "Draft saved." });
    expect(second).toMatchObject({ tone: "success", text: "Draft saved." });
    expect(second!.seq).not.toBe(first!.seq);
  });

  it("keys an error the same way, and clears on an empty state", () => {
    const error = nextOutcome(nextOutcome(null, { error: "No." }), { error: "No." });
    expect(error).toMatchObject({ tone: "error", text: "No.", seq: 2 });
    expect(nextOutcome(error, {})).toBeNull();
  });

  it("the component keys each Alert on the sequence number, in both regions", () => {
    const source = readFileSync(
      fileURLToPath(new URL("../../../components/ui/action-outcome.tsx", import.meta.url)),
      "utf8",
    );
    expect(source.match(/<Alert key=\{latest\.seq\}[^>]*live=\{false\}>/g)).toHaveLength(2);
  });
});

describe("runReported: a thrown action never leaves a stale message", () => {
  it("DENOMINATOR: a returned outcome is reported and handed back", async () => {
    const r = region();
    r.report({ error: "An earlier failure." });
    const result = await runReported(async () => ({ message: "Published." }), r.report, unstable_rethrow, PREV, FORM);
    expect(result).toEqual({ message: "Published." });
    expect(r.outcome).toMatchObject({ tone: "success", text: "Published." });
  });

  it("a network failure replaces the previous message with an honest error, and keeps the form's state", async () => {
    const r = region();
    r.report({ message: "Draft saved." });
    const result = await runReported(
      async () => {
        throw new TypeError("Failed to fetch");
      },
      r.report,
      unstable_rethrow,
      PREV,
      FORM,
    );
    expect(result).toBe(PREV);
    expect(r.outcome).toMatchObject({ tone: "error", text: ACTION_FAILED_MESSAGE });
    expect(r.outcome?.text).not.toContain("Draft saved.");
  });

  it.each([
    ["redirect()", () => redirect("/super/legal")],
    ["notFound()", () => notFound()],
  ])("Next's %s signal is re-thrown, and the region is cleared rather than left stale", async (_label, signal) => {
    const r = region();
    r.report({ message: "Draft saved." });
    let thrown: unknown;
    try {
      signal();
    } catch (error) {
      thrown = error;
    }
    // DENOMINATOR: the signal really is one unstable_rethrow recognises.
    expect(() => unstable_rethrow(thrown)).toThrow();

    await expect(
      runReported(
        async () => {
          throw thrown;
        },
        r.report,
        unstable_rethrow,
        PREV,
        FORM,
      ),
    ).rejects.toBe(thrown);
    expect(r.outcome).toBeNull();
    expect(r.reports.at(-1)).toEqual({});
  });
});
