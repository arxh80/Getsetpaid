import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The sender half of the DSR / export-ready / erasure-failure notices, against
// a fake service client and a fake Brevo (the database half is
// supabase/tests/rls_phase8_notification_stamps.sql, the two together against
// a real stack are tests/integration/email/requester-notifications.test.ts).
// Measured here: the event ORDER (send, then stamp), the recipient field, a
// failing row not taking the run down, and no address in a log line.

const events = vi.hoisted(() => ({ log: [] as string[] }));
const send = vi.hoisted(() => ({ fn: vi.fn() }));
const db = vi.hoisted(() => ({
  rpcRows: {} as Record<string, unknown[]>,
  selectRows: [] as unknown[],
  updates: [] as Array<{ table: string; values: Record<string, unknown>; filters: unknown[] }>,
}));

vi.mock("@/lib/email/send", () => ({
  sendEmail: async (i: { to: { email: string }[] }) => {
    events.log.push(`send:${i.to[0].email}`);
    return send.fn(i);
  },
}));
vi.mock("@/lib/email/feedback-notification", () => ({ supportContactEmail: () => "founder@test.local" }));
vi.mock("@/lib/supabase/env", () => ({ siteUrl: () => "https://app.example.test" }));
vi.mock("@/lib/supabase/service", () => ({
  createServiceClient: () => ({
    rpc(name: string, args: unknown) {
      events.log.push(`rpc:${name}`);
      if (name === "mark_erasure_failures_notified") {
        db.updates.push({ table: "erasure_jobs", values: { rpc: args }, filters: [] });
        return Promise.resolve({ data: 1, error: null });
      }
      return Promise.resolve({ data: db.rpcRows[name] ?? [], error: null });
    },
    from(table: string) {
      const filters: unknown[] = [];
      let values: Record<string, unknown> | undefined;
      const q: Record<string, unknown> = {
        select() { return q; },
        update(v: Record<string, unknown>) { values = v; return q; },
        eq(...a: unknown[]) { filters.push(["eq", ...a]); return q; },
        is(...a: unknown[]) { filters.push(["is", ...a]); return q; },
        order() { return q; },
        limit() { return q; },
        then(resolve: (v: unknown) => void) {
          if (values) {
            events.log.push(`stamp:${table}:${Object.keys(values).join(",")}`);
            db.updates.push({ table, values, filters });
            resolve({ data: null, error: null });
          } else {
            resolve({ data: db.selectRows, error: null });
          }
        },
      };
      return q;
    },
  }),
}));

import {
  deliverDsrNotifications,
  deliverErasureFailureNotifications,
  deliverExportReadyNotifications,
} from "@/lib/email/requester-notifications";

let errors: string[] = [];
beforeEach(() => {
  errors = [];
  vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
    errors.push(a.map(String).join(" "));
  });
});
afterEach(() => {
  send.fn.mockReset();
  events.log = [];
  db.rpcRows = {};
  db.selectRows = [];
  db.updates = [];
  vi.restoreAllMocks();
});

const dsrRow = (id: string, notice: "received" | "closed", email: string) => ({
  request_id: id,
  notice,
  email,
  reference: 7,
  right_type: "access",
  status: notice === "closed" ? "withdrawn" : "open",
  requested_at: "2026-10-04T10:00:00.000Z",
  due_by: "2026-11-03T10:00:00.000Z",
});

describe("DSR notices", () => {
  it("sends to the row's resolved address and stamps that row's column AFTER the send", async () => {
    db.rpcRows.pending_dsr_notifications = [dsrRow("r1", "received", "a@test.local"), dsrRow("r1", "closed", "a@test.local")];
    send.fn.mockResolvedValue({ ok: true, messageId: "m" });
    const result = await deliverDsrNotifications();
    expect(result).toEqual({ outcome: "delivered", sent: 2, failed: 0, deferred: 0 });
    expect(events.log).toEqual([
      "rpc:pending_dsr_notifications",
      "send:a@test.local",
      "stamp:data_subject_requests:received_notified_at",
      "send:a@test.local",
      "stamp:data_subject_requests:closed_notified_at",
    ]);
    expect(db.updates[0].filters).toEqual([["eq", "id", "r1"], ["is", "received_notified_at", null]]);
  });

  it("a failed send stamps nothing, and the next row still goes", async () => {
    db.rpcRows.pending_dsr_notifications = [dsrRow("r1", "received", "a@test.local"), dsrRow("r2", "received", "b@test.local")];
    send.fn.mockResolvedValueOnce({ ok: false, error: "Brevo 503" }).mockResolvedValueOnce({ ok: true, messageId: "m" });
    const result = await deliverDsrNotifications();
    expect(result).toEqual({ outcome: "delivered", sent: 1, failed: 1, deferred: 0 });
    expect(db.updates).toHaveLength(1);
    expect(db.updates[0].filters).toContainEqual(["eq", "id", "r2"]);
    expect(errors.join("\n")).not.toMatch(/@test\.local/);
  });

  it("a THROWN send is a failure, not a stamp", async () => {
    db.rpcRows.pending_dsr_notifications = [dsrRow("r1", "received", "a@test.local")];
    send.fn.mockRejectedValue(new TypeError("boom"));
    await deliverDsrNotifications();
    expect(db.updates).toHaveLength(0);
  });
});

describe("export-ready notice", () => {
  it("builds from four named fields only -- extra row columns never reach the builder", async () => {
    db.rpcRows.pending_export_ready_notifications = [
      {
        job_id: "j1",
        email: "a@test.local",
        kind: "account",
        organisation_slug: null,
        expires_at: "2026-10-11T10:00:00.000Z",
        storage_key: "exports/j1.zip",
      },
    ];
    send.fn.mockResolvedValue({ ok: true, messageId: "m" });
    const result = await deliverExportReadyNotifications();
    expect(result).toEqual({ outcome: "delivered", sent: 1, failed: 0, deferred: 0 });
    const mail = send.fn.mock.calls[0][0] as { to: { email: string }[]; text: string; html: string };
    expect(mail.to).toEqual([{ email: "a@test.local" }]);
    expect(`${mail.text}${mail.html}`).not.toContain("exports/j1.zip");
    expect(events.log.indexOf("send:a@test.local")).toBeLessThan(events.log.indexOf("stamp:export_jobs:ready_notified_at"));
  });
});

describe("erasure-failure notice", () => {
  it("one email to the superuser, then the stamp RPC with exactly the ids it counted", async () => {
    db.selectRows = [{ id: "e1" }, { id: "e2" }];
    send.fn.mockResolvedValue({ ok: true, messageId: "m" });
    const result = await deliverErasureFailureNotifications();
    expect(result).toEqual({ outcome: "sent", count: 2 });
    expect(events.log).toEqual(["send:founder@test.local", "rpc:mark_erasure_failures_notified"]);
    expect(db.updates[0].values).toEqual({ rpc: { p_job_ids: ["e1", "e2"] } });
  });

  it("a failed send calls no stamp", async () => {
    db.selectRows = [{ id: "e1" }];
    send.fn.mockResolvedValue({ ok: false, error: "Brevo 503" });
    const result = await deliverErasureFailureNotifications();
    expect(result).toMatchObject({ outcome: "failed", count: 1 });
    expect(events.log).not.toContain("rpc:mark_erasure_failures_notified");
  });
});
