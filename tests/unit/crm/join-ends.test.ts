import { describe, expect, it } from "vitest";

// WHICH SENTENCE A REFUSED JOIN WRITE GETS.
//
// ===========================================================================
// THE DEFECT: ONE STRING FOR FOUR SITUATIONS, WRONG IN THREE
// ===========================================================================
// `liveInOrg()` returned a boolean and `deletedEndState()` turned every false
// into "This record is deleted, so its links can't be changed. Restore it
// first and these controls come back." (That is the wording AT THE TIME. Task
// 4b's browser pass changed "its links" to "what's attached to it", because a
// venue's ROOMS are not links -- see DELETED_RECORD_EXPLANATION. The defect
// described here is unaffected: it was about which SITUATIONS got the
// sentence, not about the noun in it.) The re-review measured what that means
// in practice: a live `Make primary` form's hidden `companyId` repointed at a
// LIVE company in another workspace was correctly refused, and the user was
// told to restore a record that is not deleted -- an instruction they cannot
// carry out, about a record they cannot see.
//
//   the record really is soft-deleted     "deleted -- restore it first"   OK
//   the record is in another workspace    "deleted -- restore it first"   wrong
//   the record does not exist             "deleted -- restore it first"   wrong
//   the record is outside a record-scoped
//     user's scope                        "deleted -- restore it first"   wrong
//
// ===========================================================================
// AND WHY THE FIX IS NOT AN EXISTENCE ORACLE
// ===========================================================================
// The three wrong rows all collapse into ONE value, `"gone"`, produced by one
// branch of one query run through the CALLER'S OWN client (`data === null`).
// Nothing downstream can tell them apart and nothing tries. `REFUSED_MESSAGE`
// applies exactly the same discipline on purpose -- lib/crm/write.ts's header
// says why. The complaint N-8 makes is the opposite one: the deleted sentence
// GUESSED, and was wrong three times in four.

const { joinEndExplanation, DELETED_RECORD_EXPLANATION } = await import(
  "@/lib/crm/write-access"
);
const { REFUSED_MESSAGE } = await import("@/lib/crm/write");

describe("joinEndExplanation: the three branches", () => {
  it("every end live -> null, and the write goes ahead", () => {
    expect(joinEndExplanation(["live", "live"])).toBeNull();
    expect(joinEndExplanation(["live"])).toBeNull();
  });

  it("a DELETED end -> the sentence with the instruction the user can act on", () => {
    // The one case where "Restore it first and these controls come back" is a
    // promise the product can keep: the record is one click from being back,
    // and the panel says the same sentence where the controls would be.
    expect(joinEndExplanation(["deleted", "live"])).toBe(DELETED_RECORD_EXPLANATION);
    expect(joinEndExplanation(["live", "deleted"])).toBe(DELETED_RECORD_EXPLANATION);
    expect(joinEndExplanation(["deleted"])).toBe(DELETED_RECORD_EXPLANATION);
  });

  it("a GONE end -> the sentence that does not guess", () => {
    expect(joinEndExplanation(["gone", "live"])).toBe(REFUSED_MESSAGE);
    expect(joinEndExplanation(["live", "gone"])).toBe(REFUSED_MESSAGE);
    expect(joinEndExplanation(["gone"])).toBe(REFUSED_MESSAGE);
  });

  it("GONE beats DELETED, because 'restore it' would not help", () => {
    // THE ONE JUDGEMENT CALL IN THIS FUNCTION. If one end is deleted and the
    // other is in another workspace, restoring the deleted one still leaves
    // the write refused -- so the instruction would be true and useless, which
    // is the same failure as it being false.
    expect(joinEndExplanation(["deleted", "gone"])).toBe(REFUSED_MESSAGE);
    expect(joinEndExplanation(["gone", "deleted"])).toBe(REFUSED_MESSAGE);
  });

  it("the two sentences are actually different, so the branches are observable", () => {
    expect(DELETED_RECORD_EXPLANATION).not.toBe(REFUSED_MESSAGE);
    // And the deleted one is the only one that gives an instruction.
    expect(DELETED_RECORD_EXPLANATION).toContain("Restore it first");
    expect(REFUSED_MESSAGE).not.toContain("Restore");
    expect(REFUSED_MESSAGE).not.toContain("deleted");
  });

  it("NO ORACLE: every reason for 'gone' produces one byte-identical answer", () => {
    // There is only one `"gone"` literal to hand this function, which is the
    // structural half of the claim -- lib/crm/contacts.ts's `liveInOrg` has one
    // `data === null` branch covering another workspace, out of scope and
    // never existed, plus one error branch. This asserts the consequence: a
    // caller cannot learn WHICH by reading what it got back.
    const otherWorkspace = joinEndExplanation(["live", "gone"]);
    const doesNotExist = joinEndExplanation(["live", "gone"]);
    const outOfScope = joinEndExplanation(["live", "gone"]);
    expect(otherWorkspace).toBe(doesNotExist);
    expect(doesNotExist).toBe(outOfScope);
    expect(otherWorkspace).toBe(REFUSED_MESSAGE);
  });
});
