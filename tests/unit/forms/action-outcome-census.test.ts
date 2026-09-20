import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// THE SURFACES THAT HAVE HAD THE VANISHING-CONFIRMATION BUG, HELD TO THE RULE.
//
// components/ui/action-outcome.tsx carries the account of the bug class: a
// Server Action that calls revalidatePath() re-renders the page into a tree
// that may no longer contain the component whose `useActionState` holds the
// result, so the message is thrown away and the person is told nothing. It has
// shipped THREE times in one phase (Task 1's I1, Task 3's requester side,
// Task 3's operator side -- review finding I6), which is why the fix is a
// shared component and this file is the guard rather than a note in a header.
//
// WHAT THIS ASSERTS, per surface:
//
//   1. it imports useReportedAction, so its outcomes reach the page-level
//      region;
//   2. EVERY useActionState on it takes a reported action -- `useActionState(
//      someAction, ...)` with a Server Action passed straight in is the exact
//      shape of the defect, and a second form added to a fixed file is how it
//      would come back;
//   3. it does not render `state.message` itself. A file that reports its
//      outcome AND renders it shows one message twice, in two places, one of
//      which can still disappear.
//
// NOT A CENSUS OF EVERY FORM IN THE PRODUCT (there are fifty-one), and
// deliberately not: most of them navigate away on success or are rendered by
// something an action cannot unmount, and a blanket rule would be fifty
// justifications nobody reads. This is the list of surfaces where the bug has
// actually been found, plus the one surface that solved it another way and
// says so.

const REPORTED_SURFACES = [
  "components/admin/legal-editor-forms.tsx",
  "components/admin/dsr-transition-forms.tsx",
  "components/admin/dsr-note-form.tsx",
  // Phase 8 Task 4. Starting an export revalidates the page into a tree where
  // this form's own button may now be disabled and a list that did not exist
  // is rendered, so a message held by its useActionState is thrown away by
  // exactly the re-render it caused.
  "components/account/export-start-form.tsx",
];

/**
 * Surfaces that keep their own outcome, with the structural reason it cannot
 * be unmounted by the action that produced it. A reason, not an exemption:
 * removing one is a diff somebody reads.
 */
const KEEPS_ITS_OWN_OUTCOME: Record<string, { reason: string; marker: string }> = {
  "components/account/data-request-withdraw-form.tsx": {
    reason:
      "The requester's list renders this component for EVERY request, open or closed, and " +
      "withdrawing only closes one -- so the component that holds the message is still " +
      "mounted after the revalidation. It hides its own BUTTON rather than itself, which is " +
      "the same fix arrived at from the other side (commit 53c861e).",
    marker: "THE OUTCOME OUTLIVES THE BUTTON",
  },
};

function read(path: string): string {
  return readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8");
}

/** Every `useActionState(<first argument>` on a surface. */
function useActionStateArguments(source: string): string[] {
  return [...source.matchAll(/useActionState\(\s*([A-Za-z0-9_]+)/g)].map((m) => m[1]);
}

describe("the surfaces that have had the vanishing-confirmation bug", () => {
  for (const path of REPORTED_SURFACES) {
    describe(path, () => {
      const source = read(path);

      it("imports useReportedAction", () => {
        expect(source).toMatch(/useReportedAction/);
      });

      it("passes a REPORTED action to every useActionState, not a Server Action", () => {
        const args = useActionStateArguments(source);
        expect(args.length, "no useActionState found -- has this file moved?").toBeGreaterThan(0);
        for (const arg of args) {
          // The convention: `const action = useReportedAction(theServerAction)`
          // immediately above the hook. The argument must therefore be a local
          // produced by useReportedAction, never the imported action itself.
          expect(
            source,
            `useActionState(${arg}, ...) does not take a reported action: its outcome ` +
              `is held by this component and dies with it`,
          ).toMatch(new RegExp(`const\\s+${arg}\\s*=\\s*useReportedAction\\(`));
        }
      });

      it("does not render its own state.message", () => {
        expect(
          source.includes("state.message"),
          "this surface reports its outcome to the page region AND renders it here",
        ).toBe(false);
      });
    });
  }

  for (const [path, { reason, marker }] of Object.entries(KEEPS_ITS_OWN_OUTCOME)) {
    it(`${path} keeps its own outcome, with the reason recorded`, () => {
      expect(reason.length).toBeGreaterThan(40);
      const source = read(path);
      expect(
        source,
        "the header that justifies keeping the outcome here is gone; either the " +
          "justification moved or the surface did, and either way this needs re-reading",
      ).toContain(marker);
    });
  }
});
