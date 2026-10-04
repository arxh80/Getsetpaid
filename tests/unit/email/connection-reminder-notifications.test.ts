import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The sender half of the connection-request and task-reminder notices (job 3),
// against a fake service client and a fake Brevo. The database half is
// supabase/tests/rls_phase8_notification_stamps.sql § NL/NX; the two together
// against a real stack are tests/integration/email/connection-reminder-notifications.test.ts.
// Measured here: send THEN stamp, the stamp naming the right notice and the
// one subject, every resolved recipient on the one message, a failed or
// thrown send stamping nothing, extra row columns never reaching the email,
// and no address in a log line.

const events = vi.hoisted(() => ({ log: [] as string[] }));
const send = vi.hoisted(() => ({ fn: vi.fn() }));
const db = vi.hoisted(() => ({
  rpcRows: {} as Record<string, unknown[]>,
  stamps: [] as Array<{ p_notice: string; p_subject_ids: string[] }>,
  stampAnswer: 1 as number,
}));

vi.mock("@/lib/email/send", () => ({
  sendEmail: async (i: { to: { email: string }[] }) => {
    events.log.push(`send:${i.to.map((t) => t.email).join("+")}`);
    return send.fn(i);
  },
}));
vi.mock("@/lib/email/feedback-notification", () => ({ supportContactEmail: () => "founder@test.local" }));
vi.mock("@/lib/supabase/env", () => ({ siteUrl: () => "https://app.example.test" }));
vi.mock("@/lib/supabase/service", () => ({
  createServiceClient: () => ({
    rpc(name: string, args: { p_notice: string; p_subject_ids: string[] }) {
      if (name === "mark_notices_undeliverable") {
        const r = args as unknown as { p_notice: string; p_subject_ids: string[]; p_reason: string };
        events.log.push(`refuse:${r.p_notice}:${r.p_subject_ids.join(",")}:${r.p_reason}`);
        return Promise.resolve({ data: 1, error: null });
      }
      if (name === "mark_notices_delivered") {
        events.log.push(`stamp:${args.p_notice}:${args.p_subject_ids.join(",")}`);
        db.stamps.push(args);
        return Promise.resolve({ data: db.stampAnswer, error: null });
      }
      events.log.push(`rpc:${name}`);
      return Promise.resolve({ data: db.rpcRows[name] ?? [], error: null });
    },
  }),
}));

import { deliverConnectionRequestNotifications } from "@/lib/email/network-notifications";
import { deliverTaskReminderNotifications } from "@/lib/email/task-reminder-notifications";

let errors: string[] = [];
beforeEach(() => {
  errors = [];
  db.stampAnswer = 1;
  vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
    errors.push(a.map(String).join(" "));
  });
});
afterEach(() => {
  send.fn.mockReset();
  events.log = [];
  db.rpcRows = {};
  db.stamps = [];
  vi.restoreAllMocks();
});

const TASK = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const conn = (id: string, notice: string, emails: string[]) => ({
  request_id: id,
  notice,
  emails,
  organisation_slug: "world-promo",
  counterparty_name: "Neon Rooms",
});

describe("connection-request notices", () => {
  it("one message to every resolved recipient, then the stamp for that notice and request only", async () => {
    db.rpcRows.pending_connection_request_notifications = [
      conn("r1", "connection_received", ["admin@b.test", "owner@b.test"]),
      conn("r2", "connection_declined", ["sender@a.test"]),
    ];
    send.fn.mockResolvedValue({ ok: true, messageId: "m" });
    const result = await deliverConnectionRequestNotifications();
    expect(result).toEqual({ outcome: "delivered", sent: 2, failed: 0, deferred: 0 });
    expect(events.log).toEqual([
      "rpc:pending_connection_request_notifications",
      "send:admin@b.test+owner@b.test",
      "stamp:connection_received:r1",
      "send:sender@a.test",
      "stamp:connection_declined:r2",
    ]);
  });

  it("a failed send stamps nothing and the next notice still goes; no address is logged", async () => {
    db.rpcRows.pending_connection_request_notifications = [
      conn("r1", "connection_received", ["owner@b.test"]),
      conn("r2", "connection_accepted", ["sender@a.test"]),
    ];
    send.fn.mockResolvedValueOnce({ ok: false, error: "Brevo 503" }).mockResolvedValueOnce({ ok: true, messageId: "m" });
    const result = await deliverConnectionRequestNotifications();
    expect(result).toEqual({ outcome: "delivered", sent: 1, failed: 1, deferred: 0 });
    expect(db.stamps).toEqual([{ p_notice: "connection_accepted", p_subject_ids: ["r2"] }]);
    expect(errors.join("\n")).not.toMatch(/@[ab]\.test/);
  });

  it("a THROWN send is a failure, not a stamp", async () => {
    db.rpcRows.pending_connection_request_notifications = [conn("r1", "connection_received", ["owner@b.test"])];
    send.fn.mockRejectedValue(new TypeError("boom"));
    await deliverConnectionRequestNotifications();
    expect(db.stamps).toHaveLength(0);
  });

  it("a notice with no recipient is not sent and not stamped -- it is recorded undeliverable (I2)", async () => {
    db.rpcRows.pending_connection_request_notifications = [conn("r1", "connection_received", [])];
    const result = await deliverConnectionRequestNotifications();
    expect(send.fn).not.toHaveBeenCalled();
    expect(db.stamps).toHaveLength(0);
    expect(result).toMatchObject({ failed: 1 });
    expect(events.log).toContain("refuse:connection_received:r1:no_recipient");
  });

  it("I2: a notice its builder REFUSES is recorded undeliverable once, never sent, and does not hold the queue", async () => {
    db.rpcRows.pending_connection_request_notifications = [
      { ...conn("r1", "connection_received", ["owner@b.test"]), organisation_slug: "../not-a-slug" },
      conn("r2", "connection_received", ["owner@c.test"]),
    ];
    send.fn.mockResolvedValue({ ok: true, messageId: "m" });
    const result = await deliverConnectionRequestNotifications();
    expect(result).toEqual({ outcome: "delivered", sent: 1, failed: 1, deferred: 0 });
    expect(events.log).toEqual([
      "rpc:pending_connection_request_notifications",
      "refuse:connection_received:r1:content_refused",
      "send:owner@c.test",
      "stamp:connection_received:r2",
    ]);
  });

  it("extra row columns never reach the email (the builder takes three named fields)", async () => {
    db.rpcRows.pending_connection_request_notifications = [
      { ...conn("r1", "connection_declined", ["sender@a.test"]), responded_by: "PLANTED-RESPONDER", private_note: "PLANTED NOTE" },
    ];
    send.fn.mockResolvedValue({ ok: true, messageId: "m" });
    await deliverConnectionRequestNotifications();
    const mail = send.fn.mock.calls[0][0] as { subject: string; text: string; html: string };
    expect(`${mail.subject}${mail.text}${mail.html}`).not.toMatch(/PLANTED/);
  });

  it("a stamp that lands on nothing (the request changed state) is reported, not counted as sent", async () => {
    db.rpcRows.pending_connection_request_notifications = [conn("r1", "connection_received", ["owner@b.test"])];
    send.fn.mockResolvedValue({ ok: true, messageId: "m" });
    db.stampAnswer = 0;
    const result = await deliverConnectionRequestNotifications();
    expect(result).toEqual({ outcome: "delivered", sent: 0, failed: 1, deferred: 0 });
  });
});

describe("task reminders", () => {
  it("sends to the assignee and stamps task_reminder for that task AFTER the send", async () => {
    db.rpcRows.pending_task_reminder_notifications = [
      { task_id: TASK, email: "assignee@a.test", organisation_slug: "world-promo", title: "Send the rider", due_at: null, detail: "PLANTED DETAIL" },
    ];
    send.fn.mockResolvedValue({ ok: true, messageId: "m" });
    const result = await deliverTaskReminderNotifications();
    expect(result).toEqual({ outcome: "delivered", sent: 1, failed: 0, deferred: 0 });
    expect(events.log).toEqual([
      "rpc:pending_task_reminder_notifications",
      "send:assignee@a.test",
      `stamp:task_reminder:${TASK}`,
    ]);
    const mail = send.fn.mock.calls[0][0] as { text: string; html: string };
    expect(`${mail.text}${mail.html}`).not.toContain("PLANTED DETAIL");
    expect(mail.text).toContain(`/world-promo/tasks/${TASK}`);
  });

  it("I2: a hostile title is neutralised and SENT, not refused", async () => {
    db.rpcRows.pending_task_reminder_notifications = [
      { task_id: TASK, email: "assignee@a.test", organisation_slug: "world-promo", title: "https://", due_at: null },
    ];
    send.fn.mockResolvedValue({ ok: true, messageId: "m" });
    const result = await deliverTaskReminderNotifications();
    expect(result).toEqual({ outcome: "delivered", sent: 1, failed: 0, deferred: 0 });
    expect(events.log.some((l) => l.startsWith("refuse:"))).toBe(false);
  });

  it("I2: a reminder its builder refuses is recorded undeliverable", async () => {
    db.rpcRows.pending_task_reminder_notifications = [
      { task_id: "not-a-uuid", email: "assignee@a.test", organisation_slug: "world-promo", title: "x", due_at: null },
    ];
    await deliverTaskReminderNotifications();
    expect(send.fn).not.toHaveBeenCalled();
    expect(events.log).toContain("refuse:task_reminder:not-a-uuid:content_refused");
  });

  it("a failed send leaves the reminder owed", async () => {
    db.rpcRows.pending_task_reminder_notifications = [
      { task_id: TASK, email: "assignee@a.test", organisation_slug: "world-promo", title: "Send the rider", due_at: null },
    ];
    send.fn.mockResolvedValue({ ok: false, error: "Brevo 503" });
    await deliverTaskReminderNotifications();
    expect(db.stamps).toHaveLength(0);
    // A transient send failure is retried, never made terminal.
    expect(events.log.some((l) => l.startsWith("refuse:"))).toBe(false);
  });
});
