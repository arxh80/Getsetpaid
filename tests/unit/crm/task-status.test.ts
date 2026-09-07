import { describe, expect, it } from "vitest";
import {
  MEETING_STATUSES,
  MEETING_STATUS_LABELS,
  MEETING_STATUS_TONE,
  NOTE_VISIBILITIES,
  NOTE_VISIBILITY_LABELS,
  SCAN_STATUSES,
  SCAN_STATUS_LABELS,
  SCAN_STATUS_TONE,
  TASK_PRIORITIES,
  TASK_PRIORITY_LABELS,
  TASK_PRIORITY_TONE,
  TASK_STATUSES,
  TASK_STATUS_LABELS,
  TASK_STATUS_TONE,
  type OperationsTone,
} from "@/lib/crm/task-status";

// THE OPERATIONS PRESENTATION RECORDS ARE TOTAL OVER THEIR UNIONS.
//
// The exact discipline of tests/unit/crm/event-status.test.ts, one phase
// along. `TASK_STATUS_LABELS` is `Record<TaskStatus, string>`, so a status
// added to `TASK_STATUSES` without a label is a COMPILE error and
// `pnpm typecheck` catches it. This file fills the two gaps the compiler
// leaves: a value that exists but says nothing (`{ open: "" }` type-checks),
// and VACUITY (the moment anything casts, a `for … of Object.keys` loop over an
// emptied object passes with zero iterations). So every loop is PAIRED WITH A
// COUNT — 5, 4, 4, 2 — which is the denominator.
//
// The migration half (each set equals its CHECK constraint) is
// tests/integration/crm/operations-vocabularies-match-db.test.ts (Task 1);
// this is the presentation half.
//
// MUTATION THIS CATCHES, run for real and recorded in the task report: a sixth
// task status added to the CHECK and to `TASK_STATUSES` without a label or a
// tone goes red here (count denominator + the missing-key loop), and a tone
// outside the five `OperationsTone` names is a compile error in the chip and a
// runtime red here.

const OPERATIONS_TONES: readonly OperationsTone[] = [
  "active",
  "muted",
  "success",
  "warning",
  "danger",
];

describe("TASK_STATUS_LABELS and TASK_STATUS_TONE", () => {
  it("each has exactly one entry per status, and the count is the denominator", () => {
    // FIVE. `tasks_status_check`, mirrored by TASK_STATUSES.
    expect(TASK_STATUSES).toHaveLength(5);
    expect(Object.keys(TASK_STATUS_LABELS)).toHaveLength(5);
    expect(Object.keys(TASK_STATUS_TONE)).toHaveLength(5);
    expect(Object.keys(TASK_STATUS_LABELS).sort()).toEqual([...TASK_STATUSES].sort());
    expect(Object.keys(TASK_STATUS_TONE).sort()).toEqual([...TASK_STATUSES].sort());
  });

  it("every label is non-empty and no two share one", () => {
    for (const status of TASK_STATUSES) {
      expect(TASK_STATUS_LABELS[status].trim(), `label for "${status}"`).not.toBe("");
    }
    const labels = TASK_STATUSES.map((s) => TASK_STATUS_LABELS[s]);
    expect(new Set(labels).size).toBe(5);
  });

  it("every tone is one of the five the chip can render", () => {
    for (const status of TASK_STATUSES) {
      expect(OPERATIONS_TONES, `tone for "${status}"`).toContain(TASK_STATUS_TONE[status]);
    }
  });

  it("done is the only success and cancelled the only muted terminal", () => {
    // Pinned because these are the mappings a reader's instinct gets right and
    // the next editor's copy/paste gets wrong. `done` is the good end;
    // `cancelled` is the quiet one; `blocked` is the one with a clock on it.
    expect(TASK_STATUS_TONE.done).toBe("success");
    expect(TASK_STATUS_TONE.cancelled).toBe("muted");
    expect(TASK_STATUS_TONE.blocked).toBe("warning");
    expect(TASK_STATUS_TONE.open).toBe("active");
    expect(TASK_STATUS_TONE.in_progress).toBe("active");
  });
});

describe("TASK_PRIORITY_LABELS and TASK_PRIORITY_TONE", () => {
  it("each has exactly one entry per priority, and the count is the denominator", () => {
    // FOUR. `tasks_priority_check`.
    expect(TASK_PRIORITIES).toHaveLength(4);
    expect(Object.keys(TASK_PRIORITY_LABELS)).toHaveLength(4);
    expect(Object.keys(TASK_PRIORITY_TONE)).toHaveLength(4);
    expect(Object.keys(TASK_PRIORITY_LABELS).sort()).toEqual([...TASK_PRIORITIES].sort());
    expect(Object.keys(TASK_PRIORITY_TONE).sort()).toEqual([...TASK_PRIORITIES].sort());
  });

  it("every label is non-empty", () => {
    for (const p of TASK_PRIORITIES) {
      expect(TASK_PRIORITY_LABELS[p].trim(), `label for "${p}"`).not.toBe("");
    }
  });

  it("low and normal are muted; high warns and urgent is danger", () => {
    // The ordinary case wants no colour, and only the two that should catch the
    // eye down a list carry a tone.
    expect(TASK_PRIORITY_TONE.low).toBe("muted");
    expect(TASK_PRIORITY_TONE.normal).toBe("muted");
    expect(TASK_PRIORITY_TONE.high).toBe("warning");
    expect(TASK_PRIORITY_TONE.urgent).toBe("danger");
  });
});

describe("MEETING_STATUS_LABELS and MEETING_STATUS_TONE", () => {
  it("each has exactly one entry per status, and the count is the denominator", () => {
    // FOUR. `meetings_status_check`.
    expect(MEETING_STATUSES).toHaveLength(4);
    expect(Object.keys(MEETING_STATUS_LABELS)).toHaveLength(4);
    expect(Object.keys(MEETING_STATUS_TONE)).toHaveLength(4);
    expect(Object.keys(MEETING_STATUS_LABELS).sort()).toEqual([...MEETING_STATUSES].sort());
    expect(Object.keys(MEETING_STATUS_TONE).sort()).toEqual([...MEETING_STATUSES].sort());
  });

  it("every label is non-empty and every tone renders", () => {
    for (const status of MEETING_STATUSES) {
      expect(MEETING_STATUS_LABELS[status].trim(), `label for "${status}"`).not.toBe("");
      expect(OPERATIONS_TONES, `tone for "${status}"`).toContain(MEETING_STATUS_TONE[status]);
    }
  });

  it("held is a success and no_show a warning", () => {
    expect(MEETING_STATUS_TONE.held).toBe("success");
    expect(MEETING_STATUS_TONE.no_show).toBe("warning");
  });
});

describe("NOTE_VISIBILITY_LABELS", () => {
  it("has exactly one entry per visibility, and the count is the denominator", () => {
    // TWO. `notes_visibility_check` — PRD § 6.6's binary.
    expect(NOTE_VISIBILITIES).toHaveLength(2);
    expect(Object.keys(NOTE_VISIBILITY_LABELS)).toHaveLength(2);
    expect(Object.keys(NOTE_VISIBILITY_LABELS).sort()).toEqual([...NOTE_VISIBILITIES].sort());
  });

  it("every label is non-empty", () => {
    for (const v of NOTE_VISIBILITIES) {
      expect(NOTE_VISIBILITY_LABELS[v].trim(), `label for "${v}"`).not.toBe("");
    }
  });
});

describe("SCAN_STATUS_LABELS and SCAN_STATUS_TONE", () => {
  it("each has exactly one entry per scan status, and the count is the denominator", () => {
    // FOUR. `documents_scan_status_check` — pending/clean/quarantined/error.
    expect(SCAN_STATUSES).toHaveLength(4);
    expect(Object.keys(SCAN_STATUS_LABELS)).toHaveLength(4);
    expect(Object.keys(SCAN_STATUS_TONE)).toHaveLength(4);
    expect(Object.keys(SCAN_STATUS_LABELS).sort()).toEqual([...SCAN_STATUSES].sort());
    expect(Object.keys(SCAN_STATUS_TONE).sort()).toEqual([...SCAN_STATUSES].sort());
  });

  it("every label is non-empty and no two share one", () => {
    for (const s of SCAN_STATUSES) {
      expect(SCAN_STATUS_LABELS[s].trim(), `label for "${s}"`).not.toBe("");
    }
    const labels = SCAN_STATUSES.map((s) => SCAN_STATUS_LABELS[s]);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("every tone is one of the five the chip can render", () => {
    for (const s of SCAN_STATUSES) {
      expect(OPERATIONS_TONES, `tone for "${s}"`).toContain(SCAN_STATUS_TONE[s]);
    }
  });

  it("only clean is a success; quarantined is danger; pending and error warn", () => {
    // clean is the ONLY downloadable state (SECURITY.md § 6), so it is the only
    // success. pending and error share warning and are told apart by the label.
    expect(SCAN_STATUS_TONE.clean).toBe("success");
    expect(SCAN_STATUS_TONE.quarantined).toBe("danger");
    expect(SCAN_STATUS_TONE.pending).toBe("warning");
    expect(SCAN_STATUS_TONE.error).toBe("warning");
  });
});
