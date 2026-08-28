import { describe, expect, it } from "vitest";

// The regression test for a defect nothing but a browser could have found.
//
// React 19 RESETS a `<form action={...}>` once the action resolves. Every form
// in this codebase is uncontrolled -- deliberately, so it works with
// JavaScript disabled -- so the reset puts each input back to its
// `defaultValue`, which on a create form is the empty string. Measured on the
// new-contact form: type a name and a malformed phone number, submit, and the
// phone error renders correctly while `name`, `email`, `title`, `location`,
// `website`, `tags` and both social fields all come back "".
//
// One mistyped character, and the whole record the user just entered is gone.
// Invisible to tsc, lint, build and all 512 tests -- the same profile as the
// three defects Task 3 shipped past a source-only review.
//
// The fix makes the reset HARMLESS instead of fighting it: the action returns
// what it was given, the form uses that as `defaultValue`, so the reset
// restores the submitted values. These are the two functions that carry it.

const { echoedValues, splitEchoed, groupMarkerName, selectedInGroup } =
  await import("@/lib/forms");
// Task 4b. At module scope, not inside a `describe` callback -- top-level
// await is what this file uses and a `describe` body is an ordinary
// synchronous function, so an await in there is a transform error rather than
// a failing test.
const { parseGenres, formatTags } = await import("@/lib/crm/validate");

function formOf(pairs: [string, string][]): FormData {
  const data = new FormData();
  for (const [k, v] of pairs) data.append(k, v);
  return data;
}

describe("echoedValues", () => {
  it("returns every submitted field, keyed by input name", () => {
    const data = formOf([
      ["name", "Wilhelmina Okonkwo"],
      ["phone", "not a phone number"],
      ["social_instagram", "@nightshift"],
    ]);
    expect(echoedValues(data)).toEqual({
      name: "Wilhelmina Okonkwo",
      phone: "not a phone number",
      social_instagram: "@nightshift",
    });
  });

  it("returns what was TYPED, not what validation would make of it", () => {
    // Handing back a normalised value silently rewrites the field the user is
    // being asked to correct -- so the raw FormData is the source, including
    // the whitespace and the mistake.
    expect(echoedValues(formOf([["website", "  nightshift.co.uk  "]]))).toEqual({
      website: "  nightshift.co.uk  ",
    });
  });

  it("drops Server Action internals, which travel in the same FormData", () => {
    // $ACTION_ID_*, $ACTION_REF_*, $ACTION_KEY. Echoing them into a form field
    // would put React's own plumbing into an input the user can see.
    const data = formOf([
      ["$ACTION_ID_abc123", "whatever"],
      ["$ACTION_KEY", "k"],
      ["name", "Real Field"],
    ]);
    expect(echoedValues(data)).toEqual({ name: "Real Field" });
  });

  it("joins a repeated name -- the checkbox group -- and splitEchoed inverts it", () => {
    const data = formOf([
      ["type", "promoter"],
      ["type", "venue"],
      ["name", "Two Types Ltd"],
    ]);
    const echoed = echoedValues(data);
    expect(splitEchoed(echoed.type)).toEqual(["promoter", "venue"]);
    // The round trip is what the company form relies on to re-tick the boxes.
    expect(splitEchoed(echoedValues(data).type)).toEqual(["promoter", "venue"]);
  });

  it("a single checked box round-trips as a one-element array", () => {
    expect(splitEchoed(echoedValues(formOf([["type", "venue"]])).type)).toEqual([
      "venue",
    ]);
  });

  it("no checked boxes means the key is absent, and splitEchoed says empty", () => {
    // The PRECONDITION only. What the form then does with it is the next
    // describe block -- and the first version of this file stopped here, said
    // in a comment that clearing every box "has to survive a failed submit as
    // CLEARED", and asserted nothing about that. It did not survive. See the
    // CompanyForm block below.
    const echoed = echoedValues(formOf([["name", "Untyped Ltd"]]));
    expect(echoed.type).toBeUndefined();
    expect(splitEchoed(echoed.type)).toEqual([]);
    expect(splitEchoed("")).toEqual([]);
  });

  it("an empty text field is echoed as empty, not dropped", () => {
    // Also a state that must survive: the user cleared a field on purpose, and
    // falling back to the stored value would put it back.
    expect(echoedValues(formOf([["email", ""]]))).toEqual({ email: "" });
  });
});

// ===========================================================================
// I-2: WHAT THE COMPANY FORM DOES WITH AN EMPTIED CHECKBOX GROUP
// ===========================================================================
// The defect this block exists for was reproduced in a browser: a company with
// types `promoter` + `venue`, both unticked, the name blanked to force a
// refusal, submitted -- and both came back ticked. Retrying with a name
// re-saved the types the user had removed.
//
// The previous test suite named that exact case in a COMMENT and asserted
// `echoed.type === undefined` instead, which is the bug's precondition rather
// than its consequence. These assertions drive `selectedInGroup`, which is the
// expression `CompanyForm` renders `defaultChecked` from, so a regression in
// the derivation is red here rather than in a browser six weeks later. The
// hidden marker input itself is bound by
// tests/unit/crm/source-shape.test.ts, because no assertion on a pure
// function can see a `<input>` deleted from a .tsx file.

describe("a cleared checkbox group survives a failed submit as CLEARED", () => {
  /** What `useActionState` hands the form back after a refused submit. */
  const echoOf = (pairs: [string, string][]) => echoedValues(formOf(pairs));

  const STORED = ["promoter", "venue"];

  it("shows NOTHING ticked when the group was submitted with nothing ticked", () => {
    // THE CASE. `companies.type` accepts the empty array and 20260827232510
    // calls an untyped company "a legitimate half-entered record", so this is
    // a state the user is entitled to be in.
    const echoed = echoOf([
      ["name", ""],
      [groupMarkerName("type"), "1"],
    ]);
    expect(echoed.type).toBeUndefined();
    expect(selectedInGroup(echoed, "type", STORED)).toEqual([]);
  });

  it("shows exactly what was ticked when something was", () => {
    const echoed = echoOf([
      ["name", ""],
      [groupMarkerName("type"), "1"],
      ["type", "agency"],
    ]);
    expect(selectedInGroup(echoed, "type", STORED)).toEqual(["agency"]);
  });

  it("round-trips a multi-tick through the join and back", () => {
    const echoed = echoOf([
      [groupMarkerName("type"), "1"],
      ["type", "promoter"],
      ["type", "venue"],
    ]);
    expect(selectedInGroup(echoed, "type", [])).toEqual(["promoter", "venue"]);
  });

  it("falls back to the stored record when the form has NOT been submitted", () => {
    // The first render of an edit form: `state.values` is undefined, so the
    // record is what the boxes come from.
    expect(selectedInGroup(undefined, "type", STORED)).toEqual(STORED);
  });

  it("falls back to the stored record when the echo carries no marker", () => {
    // The safe direction, and the one the old code took in every case: a form
    // that does not carry the marker cannot distinguish "none" from "not
    // asked", so it must not claim the user cleared anything.
    expect(selectedInGroup(echoOf([["name", "x"]]), "type", STORED)).toEqual(STORED);
  });
});

// ===========================================================================
// TASK 4b: THE TWO MULTI-VALUE FIELDS THE NEW FORMS ADD
// ===========================================================================
// The brief asks for this block in as many words: "Multi-value fields
// (`genres`, `socials`) must survive a failed submit -- Task 4's
// `form-echo.test.ts` covers tags and a checkbox group; extend it to genres."
//
// They survive by two DIFFERENT mechanisms, and the difference is the point of
// testing both.

describe("genres survive a failed submit", () => {
  it("a comma-separated text field needs NO marker, and this is why", () => {
    // `genres` is ONE text input. An emptied text input still submits -- as ""
    // -- so `echoedValues` has an entry for it and the echo can be trusted
    // directly. That is the whole difference from a checkbox group, where an
    // emptied group submits NOTHING and "none" collides with "not asked".
    expect(echoedValues(formOf([["genres", ""]]))).toEqual({ genres: "" });
    expect(echoedValues(formOf([["genres", "techno, house"]]))).toEqual({
      genres: "techno, house",
    });
  });

  it("the echo is what was TYPED, so a refused submit does not re-punctuate it", () => {
    // The artist form renders `state.values.genres ?? stored`. If the action
    // echoed the PARSED value instead, a user correcting one field would find
    // their genre list silently rewritten -- "Techno,techno" collapsed, spacing
    // normalised -- while they were being asked to fix something else.
    const typed = "Techno,  techno , House";
    expect(echoedValues(formOf([["genres", typed]])).genres).toBe(typed);
    // ...and the parsed form really is different, so the assertion above is
    // not vacuous.
    expect(formatTags(parseGenres(typed).genres)).not.toBe(typed);
  });

  it("an emptied genres field survives as EMPTY, not reverted to the record", () => {
    // The same state the checkbox group needed a marker to express. Here the
    // form reads `state.values?.genres ?? values.genres`, and "" is not
    // undefined -- so `??` keeps the empty string and the artist really does
    // end up with no genres.
    const echoed = echoedValues(formOf([["name", ""], ["genres", ""]]));
    expect(echoed.genres).toBe("");
    expect(echoed.genres ?? "techno").toBe("");
  });
});

describe("a lone checkbox needs the marker too (is_exclusive)", () => {
  // A GROUP OF ONE IS STILL A GROUP. `artist_representations.is_exclusive` is
  // a single checkbox, and HTML submits a checkbox only when it is ticked --
  // so an unticked box is absent from the FormData exactly as an emptied group
  // of six is. Without the marker, a user who unticks "Exclusive" and then
  // trips a date validation error gets it silently re-ticked, and the next
  // submit saves an exclusivity they removed.
  //
  // The vocabulary is `["1"]` / `[]` because the input's `value` is "1".
  const echoOf = (pairs: [string, string][]) => echoedValues(formOf(pairs));

  it("shows it UNTICKED when the form was submitted with it unticked", () => {
    const echoed = echoOf([
      ["role", "booking agent"],
      [groupMarkerName("isExclusive"), "1"],
    ]);
    expect(echoed.isExclusive).toBeUndefined();
    expect(selectedInGroup(echoed, "isExclusive", ["1"])).toEqual([]);
  });

  it("shows it TICKED when it was submitted ticked", () => {
    const echoed = echoOf([
      [groupMarkerName("isExclusive"), "1"],
      ["isExclusive", "1"],
    ]);
    expect(selectedInGroup(echoed, "isExclusive", [])).toEqual(["1"]);
  });

  it("falls back to the stored row on a first render", () => {
    expect(selectedInGroup(undefined, "isExclusive", ["1"])).toEqual(["1"]);
    expect(selectedInGroup(undefined, "isExclusive", [])).toEqual([]);
  });

  it("falls back to the stored row when no marker was carried", () => {
    // The safe direction: a form that does not carry the marker cannot tell
    // "not exclusive" from "not asked", so it must not claim the user cleared
    // anything.
    expect(selectedInGroup(echoOf([["role", "x"]]), "isExclusive", ["1"])).toEqual([
      "1",
    ]);
  });
});
