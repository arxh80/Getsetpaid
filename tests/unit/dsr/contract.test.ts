import { describe, expect, it } from "vitest";
import {
  DSR_ALERT_LEAD_DAYS,
  DSR_DETAIL_MAX,
  DSR_NOTE_MAX,
  DSR_REJECTION_REASON_MAX,
  DSR_RESPONSE_DAYS,
  DSR_RIGHTS,
  DSR_RIGHT_COPY,
  DSR_SCOPES,
  DSR_STATUSES,
  DSR_STATUS_LABELS,
  DSR_TRANSITIONS,
  daysUntil,
  describeDeadline,
  dsrTransitionAllowed,
  dsrUrgency,
  isDsrRight,
  isDsrScope,
  isDsrStatus,
  isDsrTerminal,
  operatorTransitionsFrom,
} from "@/lib/dsr/contract";
import { latestFunctionDefinition } from "../support/sql-definitions";

// THE TYPESCRIPT HALF OF THE DSR CONTRACT, BOUND TO THE SQL HALF.
//
// Runs in CI with no database, so it reads each function's LATEST body from
// the migrations (the walk tests/unit/support/sql-definitions.ts provides, and
// which tests/integration/legal/catalogue-bindings-match-db.test.ts binds to
// pg_proc.prosrc against a real Postgres). A migration that changes the six
// rights, the thirty days, the seven days or the transition table without
// changing lib/dsr/contract.ts is a red test here.

describe("the rights catalogue matches private.dsr_rights()", () => {
  const body = latestFunctionDefinition("private.dsr_rights").body;

  it("names all six rights and nothing else", () => {
    // Every `('<right>', ...` in the VALUES list, in order.
    const named = [...body.matchAll(/\('([a-z]+)'(?:::text)?,/g)].map((m) => m[1]);
    expect(named.length, "the SQL body was not parsed").toBe(6);
    expect([...named].sort()).toEqual([...DSR_RIGHTS].sort());
  });

  it("agrees on which rights need a job before they can be marked fulfilled", () => {
    for (const right of DSR_RIGHTS) {
      const kind = DSR_RIGHT_COPY[right].fulfilmentKind;
      // `('access'::text, 'export'::text)` / `('rectification', null)`
      const row = new RegExp(`\\('${right}'(?:::text)?,\\s*(null|'[a-z]+')`).exec(body);
      expect(row, `private.dsr_rights() has no row for ${right}`).not.toBeNull();
      const sqlKind = row![1] === "null" ? null : row![1].replace(/'/g, "");
      expect(sqlKind, `fulfilment kind for ${right}`).toBe(kind);
    }
  });

  it("every right has copy a person could act on", () => {
    for (const right of DSR_RIGHTS) {
      const copy = DSR_RIGHT_COPY[right];
      expect(copy.label.length, right).toBeGreaterThan(5);
      expect(copy.blurb.length, right).toBeGreaterThan(30);
    }
  });
});

describe("the clocks match the database", () => {
  it("the response window is the one private.dsr_response_days() returns", () => {
    const body = latestFunctionDefinition("private.dsr_response_days").body;
    const match = /select\s+(\d+)/i.exec(body);
    expect(match, "private.dsr_response_days() was not parsed").not.toBeNull();
    expect(Number(match![1])).toBe(DSR_RESPONSE_DAYS);
  });

  it("the early warning is the one private.dsr_alert_lead_days() returns", () => {
    const body = latestFunctionDefinition("private.dsr_alert_lead_days").body;
    const match = /select\s+(\d+)/i.exec(body);
    expect(match, "private.dsr_alert_lead_days() was not parsed").not.toBeNull();
    expect(Number(match![1])).toBe(DSR_ALERT_LEAD_DAYS);
  });

  it("the early warning is inside the response window, or it could never fire", () => {
    expect(DSR_ALERT_LEAD_DAYS).toBeGreaterThan(0);
    expect(DSR_ALERT_LEAD_DAYS).toBeLessThan(DSR_RESPONSE_DAYS);
  });
});

describe("the transition table matches private.dsr_transition_allowed()", () => {
  const body = latestFunctionDefinition("private.dsr_transition_allowed").body;
  // `('open',        'in_progress'),`
  const pairs = [...body.matchAll(/\('([a-z_]+)',\s*'([a-z_]+)'\)/g)].map(
    (m) => `${m[1]}->${m[2]}`,
  );

  it("the SQL body was parsed", () => {
    expect(pairs.length).toBeGreaterThan(0);
  });

  it("names exactly the same pairs, in both directions", () => {
    const ts: string[] = [];
    for (const [from, tos] of Object.entries(DSR_TRANSITIONS)) {
      for (const to of tos) ts.push(`${from}->${to}`);
    }
    expect([...pairs].sort()).toEqual([...ts].sort());
  });

  it("every state named in a transition is a known status", () => {
    for (const pair of pairs) {
      const [from, to] = pair.split("->");
      expect(isDsrStatus(from), from).toBe(true);
      expect(isDsrStatus(to), to).toBe(true);
    }
  });

  it("the three terminal states have no way out", () => {
    for (const terminal of ["fulfilled", "rejected", "withdrawn"]) {
      expect(isDsrTerminal(terminal)).toBe(true);
      for (const status of DSR_STATUSES) {
        expect(dsrTransitionAllowed(terminal, status), `${terminal}->${status}`).toBe(false);
      }
    }
  });

  it("a state cannot transition to itself", () => {
    for (const status of DSR_STATUSES) {
      expect(dsrTransitionAllowed(status, status), status).toBe(false);
    }
  });

  it("withdrawal is reachable from every open state, and is never the operator's", () => {
    for (const open of ["open", "in_progress", "routed"]) {
      expect(dsrTransitionAllowed(open, "withdrawn"), open).toBe(true);
      expect(operatorTransitionsFrom(open)).not.toContain("withdrawn");
    }
  });
});

describe("the allowlists use own keys, not Object.prototype", () => {
  // The incident-alert filter's lesson: `"toString" in LABELS` is true, and a
  // query-string value that passes an allowlist that way is a filter nobody
  // wrote.
  for (const probe of ["toString", "constructor", "__proto__", "hasOwnProperty"]) {
    it(`${probe} is not a right, a scope or a status`, () => {
      expect(isDsrRight(probe)).toBe(false);
      expect(isDsrScope(probe)).toBe(false);
      expect(isDsrStatus(probe)).toBe(false);
      expect(dsrTransitionAllowed(probe, "fulfilled")).toBe(false);
      expect(operatorTransitionsFrom(probe)).toEqual([]);
    });
  }

  it("every real value passes its own guard", () => {
    for (const r of DSR_RIGHTS) expect(isDsrRight(r)).toBe(true);
    for (const s of DSR_SCOPES) expect(isDsrScope(s)).toBe(true);
    for (const s of DSR_STATUSES) expect(isDsrStatus(s)).toBe(true);
    for (const s of DSR_STATUSES) expect(DSR_STATUS_LABELS[s].length).toBeGreaterThan(2);
  });
});

describe("the deadline arithmetic", () => {
  const now = new Date("2026-10-01T12:00:00.000Z");

  it("counts whole days, and goes negative once the deadline passes", () => {
    expect(daysUntil("2026-10-08T12:00:00.000Z", now)).toBe(7);
    expect(daysUntil("2026-10-01T12:00:00.000Z", now)).toBe(0);
    expect(daysUntil("2026-09-30T11:59:00.000Z", now)).toBe(-1);
    expect(daysUntil("2026-09-29T11:00:00.000Z", now)).toBe(-2);
  });

  it("throws rather than guessing on a value that is not a timestamp", () => {
    expect(() => daysUntil("soon", now)).toThrow();
  });

  it("is urgent exactly when the database's alert would fire", () => {
    expect(dsrUrgency("open", "2026-09-30T12:00:00.000Z", now)).toBe("overdue");
    expect(dsrUrgency("open", "2026-10-08T11:00:00.000Z", now)).toBe("due_soon");
    // Seven days and an hour: one hour outside the alert's own window.
    expect(dsrUrgency("open", "2026-10-08T13:00:00.000Z", now)).toBe("on_track");
    // An hour past the deadline is past it, not "0 days" and on track.
    expect(dsrUrgency("open", "2026-10-01T11:00:00.000Z", now)).toBe("overdue");
    expect(dsrUrgency("open", "2026-10-25T12:00:00.000Z", now)).toBe("on_track");
  });

  it("a closed request has no urgency, however old", () => {
    for (const terminal of ["fulfilled", "rejected", "withdrawn"]) {
      expect(dsrUrgency(terminal, "2026-01-01T00:00:00.000Z", now)).toBe("closed");
      expect(describeDeadline(terminal, "2026-01-01T00:00:00.000Z", now)).toBe("Closed");
    }
  });

  it("says how late or how long is left, in words, singular and plural", () => {
    // Later the same day is still "due today"; the exact instant, and
    // anything past it, is already overdue -- the same boundary dsrUrgency
    // uses, so the two can never disagree on one row.
    expect(describeDeadline("open", "2026-10-01T23:00:00.000Z", now)).toBe("Due today");
    expect(describeDeadline("open", "2026-10-01T12:00:00.000Z", now)).toBe("Overdue today");
    expect(describeDeadline("open", "2026-10-02T12:00:00.000Z", now)).toBe("1 day left");
    expect(describeDeadline("open", "2026-10-09T12:00:00.000Z", now)).toBe("8 days left");
    expect(describeDeadline("open", "2026-09-30T11:00:00.000Z", now)).toBe("1 day overdue");
    expect(describeDeadline("open", "2026-09-20T11:00:00.000Z", now)).toBe("11 days overdue");
    expect(describeDeadline("open", "2026-10-01T11:00:00.000Z", now)).toBe("Overdue today");
  });
});

describe("the column limits match the CHECK constraints", () => {
  // Read from the migration rather than mirrored by hand: a widened column
  // that the form still caps at the old number is a form that refuses valid
  // input, and a narrowed one is a 23514 the person cannot act on.
  const migrations = latestFunctionDefinition("private.data_subject_requests_before_insert").file;

  it("the binding reads the migration this task added", () => {
    expect(migrations).toContain("20260924000000");
  });

  it("detail, rejection reason and note caps are the shipped ones", () => {
    expect(DSR_DETAIL_MAX).toBe(4000);
    expect(DSR_REJECTION_REASON_MAX).toBe(2000);
    expect(DSR_NOTE_MAX).toBe(4000);
  });
});
