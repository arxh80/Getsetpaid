import { describe, expect, it } from "vitest";
import {
  buildCustomFieldPayload,
  CUSTOM_FIELD_ENTITY_TYPES,
  CUSTOM_FIELD_TYPES,
  customFieldInputName,
  customFieldLimit,
  customFieldLimitMessage,
  describeCustomFieldValue,
  ENTITY_TYPE_LABELS,
  formatOptionsInput,
  MAX_CUSTOM_FIELD_NUMBER,
  MAX_CUSTOM_FIELD_OPTIONS,
  MAX_CUSTOM_FIELD_TEXT,
  parseOptions,
  parseOptionsInput,
  PERMISSION_FOR_ENTITY,
  readCustomFieldValue,
  slotAvailable,
  type CustomFieldDefinition,
  type CustomFieldType,
} from "@/lib/crm/custom-fields";
import { groupMarkerName } from "@/lib/forms";

// The custom fields engine's pure half, driven directly.
//
// WHAT THIS SUITE IS AND IS NOT. Everything here is a function over strings and
// JSON, so every case is a real call rather than a mock -- including the two
// the brief singles out (the SQL-NULL/JSON-null round trip and `url`
// sanitisation in both directions). What it CANNOT see is a policy, a trigger
// or a row count: those are supabase/tests/rls_phase2_crm.sql § U/§ V and the
// HTTP block in run-rls-tests.sh, and they are where the tier limit and the
// composite-FK breakout are proven.

function definition(
  fieldType: CustomFieldType,
  options: readonly { key: string; label: string }[] = [],
): CustomFieldDefinition {
  return {
    id: "11111111-2222-3333-4444-555555555555",
    entityType: "contact",
    key: "test_field",
    label: "Test field",
    fieldType,
    options,
    deletedAt: null,
  };
}

/** A submitted form carrying one value for `definition`. */
function submitted(
  def: CustomFieldDefinition,
  entries: readonly string[],
  { withMarker = true }: { withMarker?: boolean } = {},
): FormData {
  const data = new FormData();
  const name = customFieldInputName(def.id);
  if (withMarker) data.set(groupMarkerName(name), "1");
  for (const entry of entries) data.append(name, entry);
  return data;
}

describe("the entity-type list is the shape the two CHECK constraints hold", () => {
  // TWO, not three, since Phase 3 Task 1: 20260901001000 added 'event' to the
  // custom_field_definitions and custom_field_values allowlists and left
  // merges_entity_type_allowed and merge_candidates_entity_type_allowed at
  // five, because events are not mergeable at MVP. MERGE_ENTITY_TYPES in
  // lib/crm/dedup.ts is the five-value list now.
  //
  // The value-for-value comparison against the live catalogue is
  // tests/integration/crm/custom-field-entity-types-match-db.test.ts -- this
  // is only the cheap half: the list exists, is six long, and is singular.
  it("is the six singular values, in the migration's order", () => {
    expect([...CUSTOM_FIELD_ENTITY_TYPES]).toEqual([
      "company",
      "contact",
      "agency",
      "artist",
      "venue",
      "event",
    ]);
  });

  it("gives every entity type a permission key", () => {
    for (const type of CUSTOM_FIELD_ENTITY_TYPES) {
      expect(PERMISSION_FOR_ENTITY[type]).toBeTruthy();
    }
  });
});

describe("the field-type list matches the CHECK constraint's seven", () => {
  it("is seven values in the migration's order", () => {
    expect([...CUSTOM_FIELD_TYPES]).toEqual([
      "text",
      "number",
      "date",
      "boolean",
      "single_select",
      "multi_select",
      "url",
    ]);
  });
});

// ===========================================================================
// The tier limit, TypeScript half
// ===========================================================================

describe("customFieldLimit mirrors private.custom_field_limit()", () => {
  // The DEPLOYED function is driven against this one in
  // tests/integration/crm/custom-field-limit-matches-db.test.ts. These are the
  // three branches that have no database in them at all.
  it("reads no subscription as UNLIMITED, not as Free", () => {
    // The escape private.crm_write_organisations() already carries. Reading it
    // as Free would resolve to a limit of 0 for every organisation that exists
    // today -- create_organisation() writes no subscription row -- and ship the
    // feature dead.
    expect(
      customFieldLimit({
        status: "no-subscription",
        entitlements: { customFieldLimit: 0 },
      }),
    ).toBeNull();
  });

  it("fails CLOSED on an indeterminate lookup", () => {
    expect(
      customFieldLimit({
        status: "indeterminate",
        entitlements: { customFieldLimit: null },
      }),
    ).toBe(0);
  });

  it("passes a resolved plan's limit through, including Pro's null", () => {
    expect(
      customFieldLimit({ status: "resolved", entitlements: { customFieldLimit: 5 } }),
    ).toBe(5);
    expect(
      customFieldLimit({ status: "resolved", entitlements: { customFieldLimit: null } }),
    ).toBeNull();
  });
});

describe("customFieldLimitMessage (L855, L856)", () => {
  // Two defects in one sentence, both user-visible copy.
  //
  // L855: it built the plural as `${entityType}s`, with a special case for
  // "company" and nothing else -- so an agency read "agencys". The correct
  // plurals were already sitting in ENTITY_TYPE_LABELS, imported into three
  // components for this exact purpose and not used here.
  //
  // L856: at limit 0 it said "they are all in use. Remove one", which is an
  // instruction the user cannot carry out -- there is nothing to remove, and
  // the only way out is an upgrade. The phase set that rule for
  // DELETED_RECORD_EXPLANATION and did not apply it here.

  it("pluralises every entity type the way ENTITY_TYPE_LABELS does", () => {
    for (const type of CUSTOM_FIELD_ENTITY_TYPES) {
      const message = customFieldLimitMessage(5, type);
      expect(message, type).toContain(ENTITY_TYPE_LABELS[type].toLowerCase());
    }
    // The one that was actually wrong, named so a regression is unmistakable.
    expect(customFieldLimitMessage(5, "agency")).toContain("on agencies");
    expect(customFieldLimitMessage(5, "agency")).not.toContain("agencys");
    // And the special case that WAS handled still is.
    expect(customFieldLimitMessage(5, "company")).toContain("on companies");
  });

  it("does not tell a workspace with no slots at all to remove one", () => {
    // A Free organisation's limit is 0, and so is the indeterminate
    // entitlement case that `customFieldLimit` deliberately floors to 0.
    const free = customFieldLimitMessage(0, "contact");
    expect(free).not.toContain("Remove one");
    expect(free).not.toContain("they are all in use");
    expect(free).toContain("Ask an Owner to upgrade the workspace.");
    expect(free).toContain("on contacts");
  });

  it("still tells a paid workspace that has filled its slots to remove one", () => {
    const starter = customFieldLimitMessage(5, "contact");
    expect(starter).toContain("Your plan allows 5 custom fields on contacts");
    expect(starter).toContain("Remove one, or ask an Owner to upgrade the workspace.");
  });

  it("says `field`, singular, at a limit of one", () => {
    expect(customFieldLimitMessage(1, "venue")).toContain("1 custom field on venues");
  });
});

describe("slotAvailable", () => {
  it("is true at every count when the limit is unlimited", () => {
    expect(slotAvailable(null, 0)).toBe(true);
    expect(slotAvailable(null, 4000)).toBe(true);
  });

  it("closes exactly AT the limit, not one past it", () => {
    expect(slotAvailable(5, 4)).toBe(true);
    expect(slotAvailable(5, 5)).toBe(false);
  });

  it("stays closed in the OVER-limit state a downgrade produces", () => {
    // The state nobody builds a fixture for: 40 definitions on a plan that
    // allows 5. Creating is refused and nothing else is.
    expect(slotAvailable(5, 40)).toBe(false);
  });

  it("is closed for Free's real limit of zero", () => {
    expect(slotAvailable(0, 0)).toBe(false);
  });
});

// ===========================================================================
// options
// ===========================================================================

describe("parseOptionsInput", () => {
  it("reads `key = Label` and a bare line", () => {
    const result = parseOptionsInput("guest_list = Guest list\nvip");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.options).toEqual([
      { key: "guest_list", label: "Guest list" },
      { key: "vip", label: "vip" },
    ]);
  });

  it("ignores blank lines and surrounding whitespace", () => {
    const result = parseOptionsInput("\n  a = Alpha  \n\n  b = Beta\n");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.options.map((o) => o.key)).toEqual(["a", "b"]);
  });

  it("splits on the FIRST = only, so a label may contain one", () => {
    const result = parseOptionsInput("ratio = 1 = 2");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.options).toEqual([{ key: "ratio", label: "1 = 2" }]);
  });

  it("refuses a key that is not identifier-shaped", () => {
    for (const line of ["Guest List = x", "1st = x", "guest-list = x", "GUEST = x"]) {
      expect(parseOptionsInput(line).ok, line).toBe(false);
    }
  });

  it("refuses a duplicate key", () => {
    expect(parseOptionsInput("a = Alpha\na = Beta").ok).toBe(false);
  });

  it("refuses an empty list -- a choice field with no choices cannot be filled in", () => {
    expect(parseOptionsInput("").ok).toBe(false);
    expect(parseOptionsInput(null).ok).toBe(false);
    expect(parseOptionsInput("   \n  ").ok).toBe(false);
  });

  it("accepts exactly MAX_CUSTOM_FIELD_OPTIONS and refuses one more", () => {
    const lines = (n: number) =>
      Array.from({ length: n }, (_, i) => `k${i} = Choice ${i}`).join("\n");
    expect(parseOptionsInput(lines(MAX_CUSTOM_FIELD_OPTIONS)).ok).toBe(true);
    expect(parseOptionsInput(lines(MAX_CUSTOM_FIELD_OPTIONS + 1)).ok).toBe(false);
  });

  it("round-trips through formatOptionsInput", () => {
    const source = "guest_list = Guest list\nvip";
    const parsed = parseOptionsInput(source);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(formatOptionsInput(parsed.options)).toBe(source);
  });
});

describe("parseOptions survives anything a jsonb column can hold", () => {
  // The CHECK constraint added in 20260829010000 guarantees the shape for rows
  // written after it. This function also has to survive a row written before
  // it, so every malformed element is DROPPED rather than rendered.
  it("drops non-objects, missing keys and bad key shapes", () => {
    expect(
      parseOptions([
        1,
        null,
        "a",
        { key: "ok", label: "Fine" },
        { key: "Bad Key", label: "x" },
        { key: "nolabel" },
        { key: "blank", label: "   " },
        { key: "ok", label: "Duplicate" },
      ]),
    ).toEqual([{ key: "ok", label: "Fine" }]);
  });

  it("is empty for a non-array", () => {
    expect(parseOptions(null)).toEqual([]);
    expect(parseOptions({ key: "a", label: "b" })).toEqual([]);
  });
});

// ===========================================================================
// Per-type validation on the way IN
// ===========================================================================

describe("text", () => {
  const def = definition("text");

  it("stores a jsonb STRING", () => {
    expect(readCustomFieldValue(def, submitted(def, ["hello"]))).toEqual({
      ok: true,
      outcome: "set",
      value: "hello",
    });
  });

  it("treats a blank input as CLEAR, not as an empty string", () => {
    // Storing "" would be a third state beside "no row" and "a value".
    expect(readCustomFieldValue(def, submitted(def, ["   "]))).toEqual({
      ok: true,
      outcome: "clear",
    });
  });

  it("accepts exactly the cap and refuses one character more", () => {
    const at = "x".repeat(MAX_CUSTOM_FIELD_TEXT);
    expect(readCustomFieldValue(def, submitted(def, [at]))).toEqual({
      ok: true,
      outcome: "set",
      value: at,
    });
    expect(readCustomFieldValue(def, submitted(def, [at + "x"])).ok).toBe(false);
  });

  it("does NOT strip markup -- it is escaped on the way out, not rewritten on the way in", () => {
    const hostile = "<script>alert(1)</script>";
    expect(readCustomFieldValue(def, submitted(def, [hostile]))).toEqual({
      ok: true,
      outcome: "set",
      value: hostile,
    });
  });
});

describe("number", () => {
  const def = definition("number");

  it("stores a jsonb NUMBER, never a numeric string", () => {
    const result = readCustomFieldValue(def, submitted(def, ["250"]));
    expect(result).toEqual({ ok: true, outcome: "set", value: 250 });
    // Narrowed on the OUTCOME, not merely on `ok`: `clear` and `skip` carry
    // no `value` at all now, which is the point of the three-way union.
    if (!result.ok || result.outcome !== "set") throw new Error("expected a set");
    expect(typeof result.value).toBe("number");
  });

  it("accepts decimals, a sign and a leading dot", () => {
    expect(readCustomFieldValue(def, submitted(def, ["12.5"]))).toEqual({
      ok: true,
      outcome: "set",
      value: 12.5,
    });
    expect(readCustomFieldValue(def, submitted(def, ["-3"]))).toEqual({
      ok: true,
      outcome: "set",
      value: -3,
    });
    expect(readCustomFieldValue(def, submitted(def, [".5"]))).toEqual({
      ok: true,
      outcome: "set",
      value: 0.5,
    });
  });

  it("refuses what Number() would silently accept or mangle", () => {
    // `Number("")` is 0, `Number(" 12 ")` is 12, `parseFloat("1,200")` is 1.
    // None of those is a good way to read a form.
    for (const bad of ["1,200", "12x", "1e5", "Infinity", "0x10", "--3"]) {
      expect(readCustomFieldValue(def, submitted(def, [bad])).ok, bad).toBe(false);
    }
  });

  it("refuses a number past the precision JSON can round-trip", () => {
    expect(
      readCustomFieldValue(def, submitted(def, [String(MAX_CUSTOM_FIELD_NUMBER * 10)]))
        .ok,
    ).toBe(false);
  });

  it("clears on a blank input", () => {
    expect(readCustomFieldValue(def, submitted(def, [""]))).toEqual({
      ok: true,
      outcome: "clear",
    });
  });
});

describe("date", () => {
  const def = definition("date");

  it("stores the ISO STRING, never a Date", () => {
    const result = readCustomFieldValue(def, submitted(def, ["2026-03-03"]));
    expect(result).toEqual({ ok: true, outcome: "set", value: "2026-03-03" });
  });

  it("refuses a shape that is not YYYY-MM-DD", () => {
    for (const bad of ["03/03/2026", "2026-3-3", "2026-03-03T00:00:00Z"]) {
      expect(readCustomFieldValue(def, submitted(def, [bad])).ok, bad).toBe(false);
    }
  });

  it("refuses a date the calendar does not have", () => {
    // 2026-02-30 matches the pattern; Postgres would answer 22008, which
    // reaches a user as a fault rather than as a field error.
    expect(readCustomFieldValue(def, submitted(def, ["2026-02-30"])).ok).toBe(false);
    expect(readCustomFieldValue(def, submitted(def, ["2026-13-01"])).ok).toBe(false);
  });

  it("accepts a real leap day and refuses a fake one", () => {
    expect(readCustomFieldValue(def, submitted(def, ["2028-02-29"])).ok).toBe(true);
    expect(readCustomFieldValue(def, submitted(def, ["2027-02-29"])).ok).toBe(false);
  });

  it("refuses a year outside living memory", () => {
    expect(readCustomFieldValue(def, submitted(def, ["0202-01-01"])).ok).toBe(false);
  });
});

describe("boolean", () => {
  const def = definition("boolean");

  it("stores a jsonb BOOLEAN, never the string 'true'", () => {
    const result = readCustomFieldValue(def, submitted(def, ["true"]));
    expect(result).toEqual({ ok: true, outcome: "set", value: true });
    // Narrowed on the OUTCOME, not merely on `ok`: `clear` and `skip` carry
    // no `value` at all now, which is the point of the three-way union.
    if (!result.ok || result.outcome !== "set") throw new Error("expected a set");
    expect(typeof result.value).toBe("boolean");
  });

  it("an unticked box with the marker present CLEARS", () => {
    // A checkbox expresses two states and the field has three (yes / no / not
    // answered). Clearing keeps "no" and "not answered" the same thing on a
    // control that cannot tell them apart.
    expect(readCustomFieldValue(def, submitted(def, []))).toEqual({
      ok: true,
      outcome: "clear",
    });
  });

  it("NO MARKER means the form never asked, so the stored value is UNTOUCHED", () => {
    // I-2. This test's title said "nothing is written" and it asserted
    // `{ ok: true, value: null }` -- which the RPC reads as the CLEAR verb and
    // which DELETES the row. It passed while the opposite happened. `skip` is
    // the outcome that means what the title always said, and
    // buildCustomFieldPayload() omits it from the payload entirely (asserted
    // below); the database half is rls_phase2_crm.sql § V, which proves the
    // deployed RPC leaves a key it is not given alone.
    expect(
      readCustomFieldValue(def, submitted(def, [], { withMarker: false })),
    ).toEqual({ ok: true, outcome: "skip" });
  });
});

describe("single_select", () => {
  const def = definition("single_select", [
    { key: "a", label: "Alpha" },
    { key: "b", label: "Beta" },
  ]);

  it("accepts an option key", () => {
    expect(readCustomFieldValue(def, submitted(def, ["b"]))).toEqual({
      ok: true,
      outcome: "set",
      value: "b",
    });
  });

  it("REFUSES a value that is not one of the definition's option keys", () => {
    expect(readCustomFieldValue(def, submitted(def, ["c"])).ok).toBe(false);
    // The LABEL is not the key, and posting one is the obvious hand-built
    // request.
    expect(readCustomFieldValue(def, submitted(def, ["Alpha"])).ok).toBe(false);
  });

  it("clears on the empty option", () => {
    expect(readCustomFieldValue(def, submitted(def, [""]))).toEqual({
      ok: true,
      outcome: "clear",
    });
  });
});

describe("multi_select", () => {
  const def = definition("multi_select", [
    { key: "a", label: "Alpha" },
    { key: "b", label: "Beta" },
    { key: "c", label: "Gamma" },
  ]);

  it("stores an ARRAY of option keys in DEFINITION order, not submission order", () => {
    // Stable across saves, so an unchanged answer does not look changed.
    expect(readCustomFieldValue(def, submitted(def, ["c", "a"]))).toEqual({
      ok: true,
      outcome: "set",
      value: ["a", "c"],
    });
  });

  it("drops duplicates rather than refusing them", () => {
    // A checkbox group cannot produce one; ["a","a"] means the same as ["a"],
    // so a sentence about it would be a sentence about nothing.
    expect(readCustomFieldValue(def, submitted(def, ["a", "a"]))).toEqual({
      ok: true,
      outcome: "set",
      value: ["a"],
    });
  });

  it("refuses any element that is not an option key", () => {
    expect(readCustomFieldValue(def, submitted(def, ["a", "zz"])).ok).toBe(false);
  });

  it("an empty group with the marker present CLEARS", () => {
    expect(readCustomFieldValue(def, submitted(def, []))).toEqual({
      ok: true,
      outcome: "clear",
    });
  });

  it("NO MARKER leaves the stored value alone -- and now actually does", () => {
    // I-2, the second of the two mis-titled tests. Same correction as the
    // boolean group's.
    expect(
      readCustomFieldValue(def, submitted(def, [], { withMarker: false })),
    ).toEqual({ ok: true, outcome: "skip" });
  });
});

describe("url -- the write-side protocol allowlist", () => {
  const def = definition("url");

  it("REFUSES javascript: and data:, which is the non-negotiable rule", () => {
    for (const bad of [
      "javascript:alert(1)",
      "JaVaScRiPt:alert(1)",
      "data:text/html;base64,PHNjcmlwdD4=",
      "vbscript:msgbox(1)",
      // Control characters inside the scheme are stripped before parsing, so
      // this is caught for the same reason it is caught on render.
      "java\tscript:alert(1)",
    ]) {
      expect(readCustomFieldValue(def, submitted(def, [bad])).ok, bad).toBe(false);
    }
  });

  it("upgrades a bare host, once, where the user can see what it became", () => {
    expect(readCustomFieldValue(def, submitted(def, ["getsetpaid.com"]))).toEqual({
      ok: true,
      outcome: "set",
      value: "https://getsetpaid.com/",
    });
  });

  it("stores the URL parser's normalised output, not the raw string", () => {
    const result = readCustomFieldValue(def, submitted(def, ["HTTPS://Example.com/A"]));
    expect(result).toEqual({ ok: true, outcome: "set", value: "https://example.com/A" });
  });
});

// ===========================================================================
// Classification on the way OUT
// ===========================================================================

describe("describeCustomFieldValue: empty", () => {
  it("SQL NULL and JSON null are the SAME empty state, because PostgREST cannot tell them apart", () => {
    // MEASURED, NOT ASSUMED: `select row_to_json(t) from (select null::jsonb a,
    // 'null'::jsonb b) t` is {"a":null,"b":null} on this stack, so both reach
    // JavaScript as `null`. They stay distinct IN THE DATABASE, and the write
    // path stores NEITHER -- clearing deletes the row -- so a round trip can
    // never convert one into the other. rls_phase2_crm.sql § V is that half.
    const def = definition("text");
    expect(describeCustomFieldValue(def, null).state).toBe("empty");
    expect(describeCustomFieldValue(def, undefined).state).toBe("empty");
  });

  it("an empty cell offers an empty input rather than crashing", () => {
    const cell = describeCustomFieldValue(definition("multi_select"), null);
    expect(cell.inputKeys).toEqual([]);
    expect(cell.inputValue).toBe("");
    expect(cell.problem).toBeNull();
  });
});

describe("describeCustomFieldValue: valid", () => {
  it("renders a number with UK grouping and prefills the raw digits", () => {
    const cell = describeCustomFieldValue(definition("number"), 1234.5);
    expect(cell.state).toBe("valid");
    expect(cell.display).toBe("1,234.5");
    expect(cell.inputValue).toBe("1234.5");
  });

  it("renders a date from its PARTS, so no timezone can move the day", () => {
    // `new Date("2026-03-03")` is UTC midnight; formatting that in
    // Europe/London during BST renders "2 March".
    const cell = describeCustomFieldValue(definition("date"), "2026-07-03");
    expect(cell.state).toBe("valid");
    expect(cell.display).toBe("03 Jul 2026");
    expect(cell.inputValue).toBe("2026-07-03");
  });

  it("renders a boolean as a word, and a stored false is VALID rather than empty", () => {
    expect(describeCustomFieldValue(definition("boolean"), true).display).toBe("Yes");
    const off = describeCustomFieldValue(definition("boolean"), false);
    expect(off.state).toBe("valid");
    expect(off.display).toBe("No");
    expect(off.inputChecked).toBe(false);
  });

  it("resolves select keys to their labels", () => {
    const def = definition("multi_select", [
      { key: "a", label: "Alpha" },
      { key: "b", label: "Beta" },
    ]);
    const cell = describeCustomFieldValue(def, ["b", "a"]);
    expect(cell.state).toBe("valid");
    expect(cell.chips).toEqual(["Beta", "Alpha"]);
    expect(cell.inputKeys).toEqual(["b", "a"]);
  });
});

describe("url -- the RENDER-side protocol allowlist", () => {
  const def = definition("url");

  it("a stored javascript: value is VALID text with NO href", () => {
    // Reachable by an import, a merge, or a direct PostgREST call that never
    // met normaliseWebsite(). It is a string, so it is not "needs fixing" --
    // it is rendered as inert text, which is exactly what venues.website
    // already does.
    const cell = describeCustomFieldValue(def, "javascript:alert(1)");
    expect(cell.state).toBe("valid");
    expect(cell.href).toBeNull();
    expect(cell.display).toBe("javascript:alert(1)");
  });

  it("a stored data: value likewise gets no href", () => {
    expect(describeCustomFieldValue(def, "data:text/html,<script>").href).toBeNull();
  });

  it("an http(s) value gets the parser's normalised href, not the raw string", () => {
    const cell = describeCustomFieldValue(def, "https://example.com/a?b=1");
    expect(cell.href).toBe("https://example.com/a?b=1");
  });

  it("a bare handle is not linkified and is not an error", () => {
    const cell = describeCustomFieldValue(def, "@nightshift");
    expect(cell.state).toBe("valid");
    expect(cell.href).toBeNull();
  });
});

describe("describeCustomFieldValue: invalid -- the state a field_type change creates", () => {
  it("a string on a number field is inert, not a crash", () => {
    const cell = describeCustomFieldValue(definition("number"), "12x");
    expect(cell.state).toBe("invalid");
    expect(cell.inputValue).toBe("");
    expect(cell.rawText).toBe("12x");
    expect(cell.problem).toBeTruthy();
  });

  it("every type refuses every OTHER type's shape without throwing", () => {
    const shapes: readonly unknown[] = [
      "a string",
      42,
      true,
      ["a"],
      { nested: 1 },
      "null",
    ];
    for (const type of CUSTOM_FIELD_TYPES) {
      const def = definition(type, [{ key: "a", label: "Alpha" }]);
      for (const shape of shapes) {
        // The whole point: nothing here may throw, whatever is in the column.
        const cell = describeCustomFieldValue(def, shape);
        expect(["empty", "valid", "invalid"]).toContain(cell.state);
        if (cell.state === "invalid") expect(cell.problem).toBeTruthy();
      }
    }
  });

  it("a jsonb OBJECT on a text field shows its JSON so the user can see it", () => {
    const cell = describeCustomFieldValue(definition("text"), { a: 1 });
    expect(cell.state).toBe("invalid");
    expect(cell.rawText).toBe('{"a":1}');
  });

  it("a REMOVED option is invalid and says so differently from a type mismatch", () => {
    const def = definition("single_select", [{ key: "a", label: "Alpha" }]);
    const mismatch = describeCustomFieldValue(definition("single_select"), 42);
    const removed = describeCustomFieldValue(def, "gone");
    expect(removed.state).toBe("invalid");
    expect(mismatch.state).toBe("invalid");
    expect(removed.problem).not.toBe(mismatch.problem);
    expect(removed.rawText).toBe("gone");
  });

  it("a multi_select with ONE removed option is invalid as a whole", () => {
    // Partially rendering it would silently drop a value the user chose.
    const def = definition("multi_select", [{ key: "a", label: "Alpha" }]);
    expect(describeCustomFieldValue(def, ["a", "gone"]).state).toBe("invalid");
  });
});

describe("customFieldInputName", () => {
  it("is keyed by the definition ID, so it cannot collide with the panel's own inputs", () => {
    const name = customFieldInputName("abc");
    expect(name).toBe("cf_abc");
    for (const reserved of ["orgSlug", "entityType", "entityId", "fieldId"]) {
      expect(name).not.toBe(reserved);
    }
  });
});

// ===========================================================================
// FIX ROUND 1, I-2 — "the form did not ask" is a third answer
// ===========================================================================

describe("a field the form did not carry is SKIPPED, not cleared", () => {
  // THE FINDING. Three comments and two test names said an absent group marker
  // "leaves the value exactly as it was". The branch returned
  // `{ ok: true, value: null }`, the action put that in the payload
  // unconditionally, and in the RPC's payload JSON `null` is the CLEAR verb
  // that DELETES the row. So the documented behaviour and the implemented
  // behaviour were opposites, and both tests passed.
  //
  // The rule now covers all seven types, not only the two with a marker: an
  // `<input>` that is on the form submits its name even when empty, and one
  // that is not on the form submits nothing, so `formData.has()` separates
  // "the user cleared it" from "this form did not ask" for the five
  // single-value types exactly as the marker does for the two group ones.

  it("every single-value type skips when its key is absent", () => {
    for (const type of ["text", "number", "date", "url", "single_select"] as const) {
      const def = definition(type, [{ key: "a", label: "Alpha" }]);
      const data = new FormData();
      // Deliberately NOT empty: another field's key is present, so this is a
      // real partial submission rather than an empty FormData that would skip
      // for the wrong reason.
      data.set("orgSlug", "walk-co");
      expect(readCustomFieldValue(def, data), type).toEqual({
        ok: true,
        outcome: "skip",
      });
    }
  });

  it("...and CLEARS when the key is present and blank -- the two are different", () => {
    for (const type of ["text", "number", "date", "url", "single_select"] as const) {
      const def = definition(type, [{ key: "a", label: "Alpha" }]);
      const data = new FormData();
      data.set(customFieldInputName(def.id), "");
      expect(readCustomFieldValue(def, data), type).toEqual({
        ok: true,
        outcome: "clear",
      });
    }
  });

  it("both checkbox groups skip without their marker and clear with it", () => {
    for (const type of ["boolean", "multi_select"] as const) {
      const def = definition(type, [{ key: "a", label: "Alpha" }]);
      expect(
        readCustomFieldValue(def, submitted(def, [], { withMarker: false })),
        `${type} without marker`,
      ).toEqual({ ok: true, outcome: "skip" });
      expect(
        readCustomFieldValue(def, submitted(def, [])),
        `${type} with marker`,
      ).toEqual({ ok: true, outcome: "clear" });
    }
  });
});

describe("buildCustomFieldPayload: what actually reaches the RPC", () => {
  // THE HALF THAT MATTERS, and the half the two mis-titled tests never
  // reached. `readCustomFieldValue` returning "skip" is only useful if the
  // payload then OMITS the field -- the RPC deletes the ids it is given a null
  // for and upserts the ids it is given a value for, so an absent key is the
  // only representation of "leave it alone". This was inline in a Server
  // Action, which tests/unit cannot drive; it is a pure function now so the
  // claim is an assertion about KEYS.
  const text = { ...definition("text"), id: "aaaaaaaa-0000-0000-0000-000000000001" };
  const num = { ...definition("number"), id: "bbbbbbbb-0000-0000-0000-000000000002" };
  const flag = { ...definition("boolean"), id: "cccccccc-0000-0000-0000-000000000003" };
  const defs = [text, num, flag];

  it("omits a skipped field entirely -- no key, so the RPC cannot touch it", () => {
    const data = new FormData();
    // Only `text` is on this form. `num` and `flag` are not.
    data.set(customFieldInputName(text.id), "kept");
    const built = buildCustomFieldPayload(defs, data);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(Object.keys(built.payload)).toEqual([text.id]);
    expect(built.payload[text.id]).toBe("kept");
    // The assertion the finding is about: NOT `{[num.id]: null}`, which would
    // delete a value the form never showed anybody.
    expect(num.id in built.payload).toBe(false);
    expect(flag.id in built.payload).toBe(false);
  });

  it("sends null -- the CLEAR verb -- only for a field that was submitted blank", () => {
    const data = new FormData();
    data.set(customFieldInputName(text.id), "   ");
    data.set(customFieldInputName(num.id), "7");
    data.set(groupMarkerName(customFieldInputName(flag.id)), "1");
    const built = buildCustomFieldPayload(defs, data);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.payload).toEqual({
      [text.id]: null, // present and blank -> clear
      [num.id]: 7, // present with a value -> set
      [flag.id]: null, // marker present, box unticked -> clear
    });
  });

  it("reports every field error at once, keyed by input name, and sends nothing", () => {
    const data = new FormData();
    data.set(customFieldInputName(text.id), "x".repeat(MAX_CUSTOM_FIELD_TEXT + 1));
    data.set(customFieldInputName(num.id), "12x");
    const built = buildCustomFieldPayload(defs, data);
    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(Object.keys(built.fieldErrors).sort()).toEqual(
      [customFieldInputName(num.id), customFieldInputName(text.id)].sort(),
    );
  });

  it("an entirely empty submission changes nothing", () => {
    // The degenerate case, and the one where "skip" earns its keep: a form
    // that carried no custom field at all must not delete every value on the
    // record.
    const built = buildCustomFieldPayload(defs, new FormData());
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.payload).toEqual({});
  });
});
