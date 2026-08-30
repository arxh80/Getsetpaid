import { describe, expect, it } from "vitest";
import {
  EVENT_STATUSES,
  EVENT_TYPES,
  STATUS_LABELS,
  STATUS_TONE,
  TYPE_LABELS,
  type EventStatusTone,
} from "@/lib/crm/event-status";

// THE THREE PRESENTATION RECORDS ARE TOTAL OVER THEIR UNIONS.
//
// ===========================================================================
// WHAT THE COMPILER ALREADY DOES, AND THE GAP THIS FILE FILLS
// ===========================================================================
// `STATUS_LABELS` is `Record<EventStatus, string>`, so a ninth status added to
// `EVENT_STATUSES` without a label is a COMPILE error at the definition, and
// `pnpm typecheck` is the gate that catches it. That covers most of the risk
// and it is the reason these are Records rather than lookup functions.
//
// Two things it does not cover, which is what is asserted below:
//
//   1. A VALUE THAT EXISTS BUT SAYS NOTHING. `{ draft: "" }` type-checks. An
//      empty label renders an empty chip and an unnamed option in the status
//      filter -- visible only to somebody who opens the page.
//   2. VACUITY. The moment anything casts (`STATUS_LABELS as Record<string,
//      string>`, a `satisfies` dropped in a refactor, a JS caller), the type
//      stops being enforced and a `for (const k of Object.keys(...))` loop
//      over an emptied object passes with zero iterations. So EVERY loop below
//      is paired with a COUNT -- 8, 6 and 8 -- which is the denominator. A
//      test that iterates an unknown number of times proves nothing about the
//      ones it did not visit.
//
// MUTATION THIS CATCHES, run for real and recorded in the task report: a ninth
// status added to the CHECK constraint and to `EVENT_STATUSES` without a label
// or a tone. `tests/integration/crm/event-vocabularies-match-db.test.ts`
// (Task 1) catches the migration half; this catches the presentation half.

describe("STATUS_LABELS", () => {
  it("has exactly one entry per status, and the count is the denominator", () => {
    // EIGHT. PRD § 6.5, mirrored by `events_status_check`. If this number ever
    // needs changing, the migration, EVENT_STATUSES, STATUS_TONE and the
    // status filter's choices in lib/crm/events-list.ts all change with it.
    expect(EVENT_STATUSES).toHaveLength(8);
    expect(Object.keys(STATUS_LABELS)).toHaveLength(8);
    expect(Object.keys(STATUS_LABELS).sort()).toEqual([...EVENT_STATUSES].sort());
  });

  it("every label is non-empty and not just whitespace", () => {
    for (const status of EVENT_STATUSES) {
      expect(STATUS_LABELS[status].trim(), `label for "${status}"`).not.toBe("");
    }
  });

  it("no two statuses share a label", () => {
    // Two statuses rendering the same word is a chip that cannot be read and a
    // filter with two identical options. Not reachable through the type, and
    // exactly the kind of thing a copy/paste of the object produces.
    const labels = EVENT_STATUSES.map((s) => STATUS_LABELS[s]);
    expect(new Set(labels).size).toBe(8);
  });
});

describe("TYPE_LABELS", () => {
  it("has exactly one entry per type, and the count is the denominator", () => {
    // SIX. `events_event_type_check`, widened by 20260901001000.
    expect(EVENT_TYPES).toHaveLength(6);
    expect(Object.keys(TYPE_LABELS)).toHaveLength(6);
    expect(Object.keys(TYPE_LABELS).sort()).toEqual([...EVENT_TYPES].sort());
  });

  it("every label is non-empty and not just whitespace", () => {
    for (const type of EVENT_TYPES) {
      expect(TYPE_LABELS[type].trim(), `label for "${type}"`).not.toBe("");
    }
  });
});

describe("STATUS_TONE", () => {
  const TONES: readonly EventStatusTone[] = [
    "muted",
    "ink",
    "success",
    "warning",
    "danger",
  ];

  it("has exactly one entry per status, and the count is the denominator", () => {
    expect(Object.keys(STATUS_TONE)).toHaveLength(8);
    expect(Object.keys(STATUS_TONE).sort()).toEqual([...EVENT_STATUSES].sort());
  });

  it("every tone is one of the five the chip can render", () => {
    // components/crm/status-chip.tsx maps tone -> a Tailwind token through a
    // `Record<EventStatusTone, string>`. A tone outside this set has no class
    // and renders unstyled -- a compile error there, and this is the runtime
    // half for the same reason the label loop above exists.
    for (const status of EVENT_STATUSES) {
      expect(TONES, `tone for "${status}"`).toContain(STATUS_TONE[status]);
    }
  });

  it("cancelled is the only danger tone", () => {
    // Not decoration: `--danger` is the token that says "this went wrong", and
    // spreading it over `hold` or `sold_out` would make the one status that
    // really did go wrong indistinguishable at a glance. Asserted because it
    // is the mapping most likely to drift when a status is added.
    const danger = EVENT_STATUSES.filter((s) => STATUS_TONE[s] === "danger");
    expect(danger).toEqual(["cancelled"]);
  });

  it("sold_out is a success, not a warning", () => {
    // A promoter selling out is the good outcome. A warning tone would imply
    // "act now", which is false, and this is the tone a reader's instinct gets
    // wrong -- so it is pinned rather than left to the next editor's instinct.
    expect(STATUS_TONE.sold_out).toBe("success");
  });
});
