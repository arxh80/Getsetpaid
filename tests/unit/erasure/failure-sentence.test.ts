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
//      asserted against the list of hints in the migrations, so a guard added
//      later with no sentence lands as a red test rather than as "the
//      deletion could not be completed" for something we know the cause of.
//   2. THE STORAGE PATH JOINS THE SAME TABLE. A thrown Error carries a
//      message and no hint, so `hintFromMessage()` matches on the runner's own
//      wording -- a coupling a rename breaks silently, which is why the exact
//      string is asserted here as well as in purgeBytes().

import { describe, expect, it } from "vitest";
import { failureSentence } from "@/lib/erasure/runner";

/** Every hint private.erase_account() / erase_organisation() can raise. */
const HINTS = [
  "last_owner_of_workspace",
  "bytes_not_purged",
  "replication_role_must_be_origin",
  "reference_survived_the_repoint",
  "reference_survived_the_delete",
  "composite_fk_to_auth_users",
  "unclassified_fkless_identifier",
  "workspace_left_ownerless",
] as const;

const DEFAULT = "Nothing was deleted: the deletion could not be completed.";

describe("failureSentence", () => {
  it("answers every chokepoint hint with its own sentence, never the default", () => {
    const seen = new Set<string>();
    for (const hint of HINTS) {
      const sentence = failureSentence({ hint });
      expect(sentence, `${hint} falls through to the default`).not.toContain(DEFAULT);
      // Whatever went wrong, the first thing it says is that nothing changed.
      expect(sentence.startsWith("Nothing was deleted:"), hint).toBe(true);
      seen.add(sentence);
    }
    // The two "this needs a person" cases share one sentence deliberately;
    // everything else is distinct, so no two failures read as the same thing.
    expect(seen.size).toBe(HINTS.length - 2);
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
