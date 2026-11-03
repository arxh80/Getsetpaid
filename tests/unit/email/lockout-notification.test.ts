import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// THE PER-ACCOUNT LOCKOUT NOTIFICATION (founder ruling Q114), against a fake
// service client and a fake Brevo.
//
// What is measured here is what a database cannot see: that the stamp comes
// only after ok:true, that a failed send leaves the alerts pending, that a
// failing account does not take the run down for the others, and that NO
// ADDRESS reaches a log line. The cap itself is structural and is measured
// where it lives -- supabase/tests/rls_phase7_rate_limits.sql § RD proves one
// alert per lockout window and one row per account out of
// public.pending_lockout_notifications().

const send = vi.hoisted(() => ({ fn: vi.fn() }));
const db = vi.hoisted(() => ({
  rpcRows: [] as unknown[],
  rpcError: null as null | { message: string },
  rpcCalls: [] as Array<{ name: string; args: unknown }>,
  updateError: null as null | { message: string },
  updates: [] as Array<{ table: string; values: unknown; filters: unknown[] }>,
}));

vi.mock("@/lib/email/send", () => ({ sendEmail: (i: unknown) => send.fn(i) }));
vi.mock("@/lib/supabase/env", () => ({ siteUrl: () => "https://app.example.test" }));
vi.mock("@/lib/supabase/service", () => ({
  createServiceClient: () => ({
    rpc(name: string, args: unknown) {
      db.rpcCalls.push({ name, args });
      return Promise.resolve({ data: db.rpcRows, error: db.rpcError });
    },
    from(table: string) {
      const filters: unknown[] = [];
      let values: unknown;
      const q: Record<string, unknown> = {
        update(v: unknown) { values = v; return q; },
        is(...a: unknown[]) { filters.push(["is", ...a]); return q; },
        in(...a: unknown[]) { filters.push(["in", ...a]); return q; },
        then(resolve: (v: unknown) => void) {
          db.updates.push({ table, values, filters });
          resolve({ data: null, error: db.updateError });
        },
      };
      return q;
    },
  }),
}));

import {
  LOCKOUT_NOTIFICATION_BUDGET_MS,
  deliverLockoutNotifications,
} from "@/lib/email/lockout-notification";

const ACCOUNT_A = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const ACCOUNT_B = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";

function pending(account: string, email: string, alertIds: string[]) {
  return {
    account_user_id: account,
    email,
    alert_ids: alertIds,
    latest_at: "2026-09-16T09:30:00.000Z",
    max_requests: 5,
    window_seconds: 900,
  };
}

let errorLog: string[] = [];

beforeEach(() => {
  errorLog = [];
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    errorLog.push(args.map(String).join(" "));
  });
});
afterEach(() => {
  send.fn.mockReset();
  db.rpcRows = [];
  db.rpcError = null;
  db.rpcCalls = [];
  db.updateError = null;
  db.updates = [];
  vi.restoreAllMocks();
});

describe("deliverLockoutNotifications", () => {
  it("sends nothing and stamps nothing when no account is pending", async () => {
    await expect(deliverLockoutNotifications()).resolves.toEqual({ outcome: "nothing_pending" });
    expect(send.fn).not.toHaveBeenCalled();
    expect(db.updates).toHaveLength(0);
  });

  it("is unavailable, not silently empty, when the pending read fails", async () => {
    db.rpcError = { message: "permission denied" };
    await expect(deliverLockoutNotifications()).resolves.toEqual({
      outcome: "unavailable",
      error: "permission denied",
    });
    expect(send.fn).not.toHaveBeenCalled();
  });

  it("emails the account's OWN address and stamps every alert id it covered", async () => {
    db.rpcRows = [pending(ACCOUNT_A, "victim@example.test", ["alert-1", "alert-2"])];
    send.fn.mockResolvedValue({ ok: true, messageId: "m1" });

    await expect(deliverLockoutNotifications()).resolves.toEqual({
      outcome: "delivered",
      sent: 1,
      failed: 0,
      deferred: 0,
    });

    expect(send.fn).toHaveBeenCalledOnce();
    const input = send.fn.mock.calls[0]![0] as {
      to: Array<{ email: string }>;
      subject: string;
      text: string;
    };
    // ONE recipient, and it is the account's own address -- never a cc, never
    // the support contact, never anyone else.
    expect(input.to).toEqual([{ email: "victim@example.test" }]);
    expect(input.subject).toBe("Someone is trying to sign in to your GetSetPaid account");

    // A BACKLOG OF WINDOWS IS ONE EMAIL AND ONE STAMP OVER ALL OF THEM.
    expect(db.updates).toHaveLength(1);
    expect(db.updates[0]!.table).toBe("incident_alerts");
    expect(db.updates[0]!.values).toMatchObject({
      account_notified_at: expect.any(String) as unknown as string,
    });
    expect(db.updates[0]!.filters).toContainEqual(["in", "id", ["alert-1", "alert-2"]]);
    // Idempotent stamp, the notified_at precedent: a concurrent run cannot
    // re-stamp what this one already did.
    expect(db.updates[0]!.filters).toContainEqual(["is", "account_notified_at", null]);
  });

  it("stamps NOTHING when the send fails, so the next tick retries the same alerts", async () => {
    db.rpcRows = [pending(ACCOUNT_A, "victim@example.test", ["alert-1"])];
    send.fn.mockResolvedValue({ ok: false, error: "Brevo 500" });

    await expect(deliverLockoutNotifications()).resolves.toEqual({
      outcome: "delivered",
      sent: 0,
      failed: 1,
      deferred: 0,
    });
    expect(db.updates).toHaveLength(0);
  });

  it("counts a sent-but-unstamped notice as failed rather than claiming success", async () => {
    db.rpcRows = [pending(ACCOUNT_A, "victim@example.test", ["alert-1"])];
    send.fn.mockResolvedValue({ ok: true, messageId: "m1" });
    db.updateError = { message: "column is read only" };

    await expect(deliverLockoutNotifications()).resolves.toEqual({
      outcome: "delivered",
      sent: 0,
      failed: 1,
      deferred: 0,
    });
  });

  it("one account's failure does not stop the others", async () => {
    db.rpcRows = [
      pending(ACCOUNT_A, "a@example.test", ["alert-1"]),
      pending(ACCOUNT_B, "b@example.test", ["alert-2"]),
    ];
    send.fn
      .mockResolvedValueOnce({ ok: false, error: "Brevo 500" })
      .mockResolvedValueOnce({ ok: true, messageId: "m2" });

    await expect(deliverLockoutNotifications()).resolves.toEqual({
      outcome: "delivered",
      sent: 1,
      failed: 1,
      deferred: 0,
    });
    expect(db.updates).toHaveLength(1);
    expect(db.updates[0]!.filters).toContainEqual(["in", "id", ["alert-2"]]);
  });

  it("NEVER puts the address in a log line -- the account id is what is logged", async () => {
    db.rpcRows = [pending(ACCOUNT_A, "victim@example.test", ["alert-1"])];
    send.fn.mockResolvedValue({ ok: false, error: "Brevo 500" });

    await deliverLockoutNotifications();

    expect(errorLog.join("\n")).toContain(ACCOUNT_A);
    expect(errorLog.join("\n")).not.toContain("victim@example.test");
  });

  // =========================================================================
  // FIX ROUND 1, M1: THE RUN CANNOT OUTLAST THE CLOCK THAT STARTED IT
  // =========================================================================
  // The clock ticks every 600 s (Q118). A sequential loop of N sends against a
  // degraded Brevo costs N x 10 s, so the first cut's 100 accounts could run
  // ~1000 s -- tick 2 firing into tick 1's tail, reading the same unstamped
  // accounts, and sending the account holder the notice twice. Two bounds now
  // make that unreachable, and both are asserted here rather than argued in a
  // comment: the limit asked of the database, and the wall-clock budget.
  it("stops sending when the wall-clock budget is spent, stamping nothing for the rest", async () => {
    db.rpcRows = [
      pending(ACCOUNT_A, "a@example.test", ["alert-1"]),
      pending(ACCOUNT_B, "b@example.test", ["alert-2"]),
    ];
    send.fn.mockResolvedValue({ ok: true, messageId: "m" });

    // A CLOCK THAT JUMPS PAST THE BUDGET AFTER THE FIRST SEND. Date.now is
    // read once at the start and once before each send, so: start, first
    // check (in budget), second check (over).
    const base = Date.parse("2026-09-16T09:30:00.000Z");
    const readings = [base, base + 1_000, base + LOCKOUT_NOTIFICATION_BUDGET_MS + 1];
    let i = 0;
    vi.spyOn(Date, "now").mockImplementation(() => readings[Math.min(i++, readings.length - 1)]!);

    await expect(deliverLockoutNotifications()).resolves.toEqual({
      outcome: "delivered",
      sent: 1,
      failed: 0,
      deferred: 1,
    });

    // THE DENOMINATOR: the second account was pending and reachable -- it is
    // unsent because of the budget, not because the row was missing.
    expect(send.fn).toHaveBeenCalledOnce();
    expect((send.fn.mock.calls[0]![0] as { to: Array<{ email: string }> }).to).toEqual([
      { email: "a@example.test" },
    ]);
    // AND NOTHING WAS STAMPED FOR IT, which is what makes the next tick a
    // retry rather than a loss.
    expect(db.updates).toHaveLength(1);
    expect(db.updates[0]!.filters).toContainEqual(["in", "id", ["alert-1"]]);
  });

  it("asks only for the pending accounts, with a bounded limit and no user argument", async () => {
    db.rpcRows = [];
    await deliverLockoutNotifications(10_000);
    expect(db.rpcCalls).toEqual([
      { name: "pending_lockout_notifications", args: { p_limit: 30 } },
    ]);
  });
});
