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

const { echoedValues, splitEchoed } = await import("@/lib/forms");

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
    // NOT the same as "unchanged". `companies.type` accepts the empty array
    // and 20260827232510 calls an untyped company "a legitimate half-entered
    // record", so clearing every box has to survive a failed submit as
    // CLEARED rather than reverting to what was stored.
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
