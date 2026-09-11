import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// THE TWO SENDERS' STAMPING CONTRACT, against a fake service client and a fake
// Brevo: `notified_at` is written ONLY after `sendEmail` answers ok:true, a
// failed send writes nothing, and a missing recipient sends nothing. The real
// grant that bounds the service client (select + update(notified_at) only) is
// measured in supabase/tests/rls_phase7_feedback.sql § FP and
// rls_phase7_rate_limits.sql § RA19-RA23; what is measured here is the ORDER,
// which a database cannot see.

const send = vi.hoisted(() => ({ fn: vi.fn() }));
const db = vi.hoisted(() => ({
  selectRows: [] as unknown[],
  selectError: null as null | { message: string },
  updateError: null as null | { message: string },
  updates: [] as Array<{ table: string; values: unknown; filters: unknown[] }>,
}));

vi.mock("@/lib/email/send", () => ({ sendEmail: (i: unknown) => send.fn(i) }));
vi.mock("@/lib/supabase/env", () => ({ siteUrl: () => "https://app.example.test" }));
vi.mock("@/lib/supabase/service", () => ({
  createServiceClient: () => ({
    from(table: string) {
      const filters: unknown[] = [];
      let verb: "select" | "update" = "select";
      let values: unknown;
      const q: Record<string, unknown> = {
        select() { verb = "select"; return q; },
        update(v: unknown) { verb = "update"; values = v; return q; },
        is(...a: unknown[]) { filters.push(["is", ...a]); return q; },
        in(...a: unknown[]) { filters.push(["in", ...a]); return q; },
        eq(...a: unknown[]) { filters.push(["eq", ...a]); return q; },
        order() { return q; },
        limit() { return q; },
        then(resolve: (v: unknown) => void) {
          if (verb === "update") {
            db.updates.push({ table, values, filters });
            resolve({ data: null, error: db.updateError });
          } else {
            resolve({ data: db.selectRows, error: db.selectError });
          }
        },
      };
      return q;
    },
  }),
}));

import { notifyFounderOfFeedback } from "@/lib/email/feedback-notification";
import { deliverPendingIncidentAlerts } from "@/lib/email/incident-alerts";

beforeEach(() => {
  process.env.SUPPORT_CONTACT_EMAIL = "founder@example.test";
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  send.fn.mockReset();
  db.selectRows = [];
  db.selectError = null;
  db.updateError = null;
  db.updates.length = 0;
  delete process.env.SUPPORT_CONTACT_EMAIL;
  vi.restoreAllMocks();
});

const feedback = {
  feedbackId: "11111111-2222-4333-8444-555555555555",
  category: "bug" as const,
  message: "m",
  route: "/x",
  submitterEmail: "u@example.test",
  organisationName: "Alpha",
  organisationSlug: "alpha",
  organisationRole: "manager",
  userAgent: null,
  screenshot: "none" as const,
};

describe("notifyFounderOfFeedback", () => {
  it("stamps notified_at only after a successful send, guarded on it still being null", async () => {
    send.fn.mockResolvedValue({ ok: true, messageId: "id" });
    await notifyFounderOfFeedback(feedback);
    expect(send.fn).toHaveBeenCalledOnce();
    expect(db.updates).toHaveLength(1);
    expect(db.updates[0].table).toBe("feedback");
    expect(db.updates[0].values).toHaveProperty("notified_at");
    expect(db.updates[0].filters).toEqual([
      ["eq", "id", feedback.feedbackId],
      ["is", "notified_at", null],
    ]);
  });

  it("stamps NOTHING when the send fails, and never throws", async () => {
    send.fn.mockResolvedValue({ ok: false, error: "Brevo 401" });
    await expect(notifyFounderOfFeedback(feedback)).resolves.toBeUndefined();
    expect(db.updates).toHaveLength(0);
    expect(console.error).toHaveBeenCalled();
  });

  it("sends nothing and stamps nothing without a recipient", async () => {
    delete process.env.SUPPORT_CONTACT_EMAIL;
    await notifyFounderOfFeedback(feedback);
    expect(send.fn).not.toHaveBeenCalled();
    expect(db.updates).toHaveLength(0);
  });

  it("swallows a thrown sender into a log line rather than failing the submission", async () => {
    send.fn.mockRejectedValue(new Error("boom"));
    await expect(notifyFounderOfFeedback(feedback)).resolves.toBeUndefined();
    expect(db.updates).toHaveLength(0);
  });

  it("sets reply-to to the submitter", async () => {
    send.fn.mockResolvedValue({ ok: true, messageId: "id" });
    await notifyFounderOfFeedback(feedback);
    expect(send.fn.mock.calls[0][0]).toMatchObject({
      to: [{ email: "founder@example.test" }],
      replyTo: { email: "u@example.test" },
    });
  });
});

describe("deliverPendingIncidentAlerts", () => {
  const pending = [
    { id: "a1", alert_type: "rate_limit_tripped", summary: "s1", created_at: "t1", organisation_id: null },
    { id: "a2", alert_type: "upload_quarantined", summary: "s2", created_at: "t2", organisation_id: "o" },
  ];

  it("reports nothing_pending and sends nothing when the seam is empty", async () => {
    db.selectRows = [];
    await expect(deliverPendingIncidentAlerts()).resolves.toEqual({ outcome: "nothing_pending" });
    expect(send.fn).not.toHaveBeenCalled();
  });

  it("sends ONE digest for every pending row and stamps exactly those ids, only after ok:true", async () => {
    db.selectRows = pending;
    send.fn.mockResolvedValue({ ok: true, messageId: "mid" });
    await expect(deliverPendingIncidentAlerts()).resolves.toEqual({
      outcome: "sent",
      count: 2,
      messageId: "mid",
    });
    expect(send.fn).toHaveBeenCalledOnce();
    expect(db.updates).toHaveLength(1);
    expect(db.updates[0].table).toBe("incident_alerts");
    expect(db.updates[0].filters).toEqual([
      ["in", "id", ["a1", "a2"]],
      ["is", "notified_at", null],
    ]);
  });

  it("a failed send stamps NOTHING and returns failed with the count -- the rows stay re-sendable", async () => {
    db.selectRows = pending;
    send.fn.mockResolvedValue({ ok: false, error: "Brevo 503" });
    await expect(deliverPendingIncidentAlerts()).resolves.toEqual({
      outcome: "failed",
      count: 2,
      error: "Brevo 503",
    });
    expect(db.updates).toHaveLength(0);
  });

  it("no recipient: nothing sent, nothing stamped, failed", async () => {
    db.selectRows = pending;
    delete process.env.SUPPORT_CONTACT_EMAIL;
    const result = await deliverPendingIncidentAlerts();
    expect(result.outcome).toBe("failed");
    expect(send.fn).not.toHaveBeenCalled();
    expect(db.updates).toHaveLength(0);
  });

  it("a read failure is unavailable, not a send", async () => {
    db.selectError = { message: "permission denied for table incident_alerts" };
    const result = await deliverPendingIncidentAlerts();
    expect(result.outcome).toBe("unavailable");
    expect(send.fn).not.toHaveBeenCalled();
  });

  it("a send that went but could not be stamped is reported as failed, not sent", async () => {
    db.selectRows = pending;
    send.fn.mockResolvedValue({ ok: true, messageId: "mid" });
    db.updateError = { message: "permission denied" };
    const result = await deliverPendingIncidentAlerts();
    expect(result.outcome).toBe("failed");
  });
});
