// THE SENTENCE A PERSON READS WHEN THEIR DELETION FAILED.
//
// `failureSentence()` carried the comment "Exported for the unit suite" and
// there was no unit suite (review finding I4). Its mapping is the whole of
// what anybody is ever told about a failed erasure -- Q45 means nothing is
// emailed, so the row's `failure_reason` and the /account/erase page that
// renders it are the entire notification.
//
// Two properties matter here and neither is spelling:
//
//   1. EVERY HINT THE CHOKEPOINT CAN RAISE HAS A SENTENCE. The hints are
//      DERIVED FROM THE MIGRATIONS -- `hint-roll.ts` walks the latest
//      definition of `public.run_erasure_job()` and every function it calls,
//      transitively, and collects each `hint = '<x>'` literal -- so a guard
//      added later with no sentence lands as a red test rather than as "the
//      deletion could not be completed" for something we know the cause of.
//      That claim used to be made over a hand-written array of eight (fix
//      round 2, review finding N5): it was `census-audit.md`'s bug class
//      inside the test written to close the last instance of it, and it was
//      already short by five, one of which -- `reference_survived_the_purge`,
//      reachable from an ACCOUNT erasure through step 8b -- was being
//      answered with "It will be retried", the precise wrong sentence I4 was
//      raised about.
//   2. THE STORAGE PATH JOINS THE SAME TABLE. A thrown Error carries a
//      message and no hint, so `hintFromMessage()` matches on the runner's own
//      wording -- a coupling a rename breaks silently, which is why the exact
//      string is asserted here as well as in purgeBytes().

import { describe, expect, it } from "vitest";
import { failureSentence } from "@/lib/erasure/runner";
import { deriveErasureHints, RUNNER_ENTRY_POINT } from "./hint-roll";

const { hints: HINTS, functions: WALKED } = deriveErasureHints();

const DEFAULT = "Nothing was deleted: the deletion could not be completed.";

describe("the derived hint roll", () => {
  it("really read the erasure chain, so an empty roll cannot pass for want of a subject", () => {
    // The denominator rule (progress.md, standing lesson 1). A walk that
    // resolved nothing would satisfy "every hint has a sentence" perfectly.
    expect(WALKED).toContain(RUNNER_ENTRY_POINT);
    expect(WALKED).toContain("private.erase_account");
    expect(WALKED).toContain("private.erase_organisation");
    expect(WALKED).toContain("private.assert_account_is_erasable");
    expect(WALKED).toContain("private.assert_fkless_identifier_roll");
    expect(HINTS.length).toBeGreaterThanOrEqual(18);
  });

  it("carries the hints the hand-written roll was missing", () => {
    // Named one by one rather than counted: these five are the ones N5 found
    // absent, and a derivation that silently stopped finding them again would
    // otherwise only show up as a number.
    for (const hint of [
      "reference_survived_the_purge",
      "custom_field_values_orphaned",
      "unknown_custom_field_entity_type",
      "workspace_is_live",
      "unknown_job",
      "job_is_not_running",
      // Phase 8 Task 7 fix round 1 (C1): erase_account() step 10b.
      "identifier_survived_in_audit_payload",
    ]) {
      expect(HINTS, `${hint} is no longer derived from the migrations`).toContain(hint);
    }
  });
});

describe("failureSentence", () => {
  it("answers every chokepoint hint with its own sentence, never the default", () => {
    for (const hint of HINTS) {
      const sentence = failureSentence({ hint });
      expect(sentence, `${hint} falls through to the default`).not.toContain(DEFAULT);
      // Whatever went wrong, the first thing it says is that nothing changed.
      expect(sentence.startsWith("Nothing was deleted:"), hint).toBe(true);
    }
  });

  it("keeps the five refusals that ask for different things apart", () => {
    // Sharing a sentence is deliberate for the "this needs a person" family;
    // these five must never collapse into one another, because each asks for
    // a different thing to happen next.
    const distinct = [
      "last_owner_of_workspace",
      "bytes_not_purged",
      "workspace_left_ownerless",
      "replication_role_must_be_origin",
      "workspace_has_no_owner",
    ].map((hint) => failureSentence({ hint }));
    expect(new Set(distinct).size).toBe(distinct.length);
  });

  it("gives reference_survived_the_purge its twin's sentence, not the retry one", () => {
    // The whole of N5: the purge-side twin of reference_survived_the_delete
    // was reading "It will be retried, and nothing has changed in the
    // meantime", which is false -- a failed post-check needs a person.
    expect(failureSentence({ hint: "reference_survived_the_purge" })).toBe(
      failureSentence({ hint: "reference_survived_the_delete" }),
    );
    expect(failureSentence({ hint: "reference_survived_the_purge" })).toContain(
      "needs a person to look at it",
    );
    expect(failureSentence({ hint: "reference_survived_the_purge" })).not.toContain("retried");
  });

  it("tells the last owner what to do, which is the one refusal a person can act on", () => {
    const sentence = failureSentence({ hint: "last_owner_of_workspace" });
    expect(sentence).toContain("last owner");
    expect(sentence).toContain("Transfer ownership");
    // And never the workspace name: the database's message carries it, this
    // column is read by the operator too, and the runner does not relay a
    // PostgreSQL message verbatim.
    expect(sentence).not.toContain("%");
  });

  it("names the way out when the subject is not an owner and cannot transfer anything", () => {
    // N2/Q178: the refusal used to send a non-owner to two doors that are
    // both locked. This is the hint the branched guard raises instead.
    const sentence = failureSentence({ hint: "workspace_has_no_owner" });
    expect(sentence).toContain("no owner");
    expect(sentence).toContain("support");
    expect(sentence).not.toContain("Transfer ownership");
    expect(sentence).not.toBe(failureSentence({ hint: "last_owner_of_workspace" }));
  });

  it("says a bytes failure will be retried rather than that the account is gone", () => {
    expect(failureSentence({ hint: "bytes_not_purged" })).toContain("retried");
  });

  it("maps a THROWN Storage failure onto the same bytes sentence, by its own wording", () => {
    // The exact string purgeBytes() throws. If that wording is changed and
    // this is not, a Storage failure silently becomes the generic sentence.
    const thrown = new Error("2 object(s) could not be removed from exports: boom");
    expect(failureSentence(thrown)).toBe(failureSentence({ hint: "bytes_not_purged" }));
  });

  it("falls back for anything it does not recognise, and never throws", () => {
    for (const cause of [null, undefined, "a string", 42, {}, { hint: "who_knows" }, new Error("x")]) {
      expect(failureSentence(cause)).toContain(DEFAULT);
    }
  });

  it("never quotes the cause, because a PostgreSQL message can carry a row value", () => {
    const leaky = { hint: "who_knows", message: "duplicate key ... (email)=(alice@example.com)" };
    expect(failureSentence(leaky)).not.toContain("alice@example.com");
  });
});
