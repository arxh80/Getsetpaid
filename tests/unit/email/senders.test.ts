import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// THE TWO SENDERS' STAMPING CONTRACT, against a fake service client and a fake
// Brevo: `notified_at` is written ONLY after `sendEmail` answers ok:true, a
// failed send writes nothing, and a missing recipient sends nothing. The real
// grant that bounds the service client (select + update(notified_at) only) is
// measured in supabase/tests/rls_phase7_feedback.sql § FP and
// rls_phase7_rate_limits.sql § RA19-RA23; what is measured here is the ORDER,
// which a database cannot see.

const send = vi.hoisted(() => ({ fn: vi.fn(), telegram: vi.fn() }));
const db = vi.hoisted(() => ({
  selectRows: [] as unknown[],
  selectError: null as null | { message: string },
  updateError: null as null | { message: string },
  updates: [] as Array<{ table: string; values: unknown; filters: unknown[] }>,
  selects: [] as Array<{ table: string; columns: unknown; filters: unknown[] }>,
}));

vi.mock("@/lib/email/send", () => ({ sendEmail: (i: unknown) => send.fn(i) }));
// THE TELEGRAM TRANSPORT IS STUBBED -- no test sends a real message. The real
// telegramConfig() is kept, so the missing-env no-op is the shipped one.
vi.mock("@/lib/telegram/send", async (importActual) => ({
  ...(await importActual<typeof import("@/lib/telegram/send")>()),
  sendTelegramMessage: (c: unknown, t: unknown) => send.telegram(c, t),
}));
vi.mock("@/lib/supabase/env", () => ({ siteUrl: () => "https://app.example.test" }));
vi.mock("@/lib/supabase/service", () => ({
  createServiceClient: () => ({
    from(table: string) {
      const filters: unknown[] = [];
      let verb: "select" | "update" = "select";
      let values: unknown;
      let columns: unknown;
      const q: Record<string, unknown> = {
        select(c: unknown) { verb = "select"; columns = c; return q; },
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
            db.selects.push({ table, columns, filters });
            resolve({ data: db.selectRows, error: db.selectError });
          }
        },
      };
      return q;
    },
  }),
}));

import { notifyFounderOfFeedback } from "@/lib/email/feedback-notification";
import {
  deliverPendingIncidentAlerts,
  deliverPendingIncidentAlertsToTelegram,
} from "@/lib/email/incident-alerts";

beforeEach(() => {
  process.env.SUPPORT_CONTACT_EMAIL = "founder@example.test";
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  send.fn.mockReset();
  send.telegram.mockReset();
  db.selects.length = 0;
  delete process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.TELEGRAM_ALERT_CHAT_ID;
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

// ===========================================================================
// THE TELEGRAM CHANNEL (founder 2026-09-30, Q111) -- its own stamp, its own
// failure, and nothing it does reaches the email seam.
// ===========================================================================
describe("deliverPendingIncidentAlertsToTelegram", () => {
  const pending = [
    { id: "a1", alert_type: "rate_limit_tripped" },
    { id: "a2", alert_type: "rate_limit_tripped" },
    { id: "a3", alert_type: "upload_quarantined" },
  ];
  const configure = () => {
    process.env.TELEGRAM_BOT_TOKEN = "123:fake";
    process.env.TELEGRAM_ALERT_CHAT_ID = "-100";
  };

  it.each([
    ["neither variable", () => {}],
    ["only the token", () => { process.env.TELEGRAM_BOT_TOKEN = "123:fake"; }],
    ["only the chat id", () => { process.env.TELEGRAM_ALERT_CHAT_ID = "-100"; }],
  ])("is a no-op with %s set: reads nothing, sends nothing, stamps nothing", async (_l, setup) => {
    setup();
    db.selectRows = pending;
    await expect(deliverPendingIncidentAlertsToTelegram()).resolves.toEqual({ outcome: "disabled" });
    expect(db.selects).toHaveLength(0);
    expect(send.telegram).not.toHaveBeenCalled();
    expect(db.updates).toHaveLength(0);
  });

  it("reads ONLY id and alert_type, from its own pending set", async () => {
    configure();
    db.selectRows = [];
    await expect(deliverPendingIncidentAlertsToTelegram()).resolves.toEqual({ outcome: "nothing_pending" });
    expect(db.selects).toEqual([
      { table: "incident_alerts", columns: "id, alert_type", filters: [["is", "telegram_notified_at", null]] },
    ]);
    expect(send.telegram).not.toHaveBeenCalled();
  });

  it("sends ONE counts-only message and stamps telegram_notified_at -- never notified_at -- only after ok:true", async () => {
    configure();
    db.selectRows = pending;
    send.telegram.mockResolvedValue({ ok: true });
    await expect(deliverPendingIncidentAlertsToTelegram()).resolves.toEqual({ outcome: "sent", count: 3 });
    expect(send.telegram).toHaveBeenCalledOnce();
    const text = send.telegram.mock.calls[0][1] as string;
    expect(text).toContain("Rate limit tripped: 2");
    expect(text).toContain("https://app.example.test/super/health");
    expect(text).not.toMatch(/a1|a2|a3/);
    expect(db.updates).toHaveLength(1);
    expect(Object.keys(db.updates[0].values as object)).toEqual(["telegram_notified_at"]);
    expect(db.updates[0].filters).toEqual([
      ["in", "id", ["a1", "a2", "a3"]],
      ["is", "telegram_notified_at", null],
    ]);
  });

  it("a failed send stamps NOTHING (the email seam included) and is re-sendable", async () => {
    configure();
    db.selectRows = pending;
    send.telegram.mockResolvedValue({ ok: false, error: "Telegram 502: Bad Gateway" });
    await expect(deliverPendingIncidentAlertsToTelegram()).resolves.toEqual({
      outcome: "failed",
      count: 3,
      error: "Telegram 502: Bad Gateway",
    });
    expect(db.updates).toHaveLength(0);
    expect(send.fn).not.toHaveBeenCalled();
  });

  it("a THROWN transport is a failure, not an exception, and stamps nothing", async () => {
    configure();
    db.selectRows = pending;
    send.telegram.mockRejectedValue(new TypeError("boom"));
    const result = await deliverPendingIncidentAlertsToTelegram();
    expect(result.outcome).toBe("failed");
    expect(db.updates).toHaveLength(0);
  });

  it("a send that went but could not be stamped is failed, not sent", async () => {
    configure();
    db.selectRows = pending;
    send.telegram.mockResolvedValue({ ok: true });
    db.updateError = { message: "permission denied" };
    expect((await deliverPendingIncidentAlertsToTelegram()).outcome).toBe("failed");
  });
});

describe("channel independence, at the seam", () => {
  it("the EMAIL half writes notified_at and nothing of the Telegram seam", async () => {
    process.env.TELEGRAM_BOT_TOKEN = "123:fake";
    process.env.TELEGRAM_ALERT_CHAT_ID = "-100";
    db.selectRows = [
      { id: "a1", alert_type: "rate_limit_tripped", summary: "s", created_at: "t", organisation_id: null },
    ];
    send.fn.mockResolvedValue({ ok: true, messageId: "mid" });
    await deliverPendingIncidentAlerts();
    expect(send.telegram).not.toHaveBeenCalled();
    expect(db.updates).toHaveLength(1);
    expect(Object.keys(db.updates[0].values as object)).toEqual(["notified_at"]);
    expect(db.selects[0].filters).toEqual([["is", "notified_at", null]]);
  });
});
