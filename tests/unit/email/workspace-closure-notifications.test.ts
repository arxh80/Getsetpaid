import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The sender half of the workspace-closure notices (Task 9c job 2b), against a
// fake service client and a fake Brevo. The database half is
// supabase/tests/rls_phase8_workspace_closure.sql; the two together against a
// real stack are tests/integration/email/workspace-closure-notifications.test.ts.
// Measured here: send THEN stamp, the stamp naming the right notice and the
// one audit row, the closure going to the support inbox and the decision to
// the resolver's snapshot only, a failed or thrown send stamping nothing, the
// support inbox unset recording nothing, and extra row columns never reaching
// the email.

const events = vi.hoisted(() => ({ log: [] as string[] }));
const send = vi.hoisted(() => ({ fn: vi.fn() }));
const env = vi.hoisted(() => ({ support: "founder@test.local" as string | null }));
const db = vi.hoisted(() => ({
  rpcRows: {} as Record<string, unknown[]>,
  stamps: [] as Array<{ p_notice: string; p_subject_ids: string[] }>,
}));

vi.mock("@/lib/email/send", () => ({
  sendEmail: async (i: { to: { email: string }[]; bcc?: { email: string }[] }) => {
    events.log.push(
      `send:${i.to.map((t) => t.email).join("+")}${i.bcc ? `|bcc:${i.bcc.map((t) => t.email).join("+")}` : ""}`,
    );
    return send.fn(i);
  },
}));
vi.mock("@/lib/email/feedback-notification", () => ({ supportContactEmail: () => env.support }));
vi.mock("@/lib/supabase/env", () => ({ siteUrl: () => "https://app.example.test" }));
vi.mock("@/lib/supabase/service", () => ({
  createServiceClient: () => ({
    rpc(name: string, args: { p_notice: string; p_subject_ids: string[]; p_reason?: string }) {
      if (name === "mark_notices_undeliverable") {
        events.log.push(`refuse:${args.p_notice}:${args.p_subject_ids.join(",")}:${args.p_reason}`);
        return Promise.resolve({ data: 1, error: null });
      }
      if (name === "mark_notices_delivered") {
        events.log.push(`stamp:${args.p_notice}:${args.p_subject_ids.join(",")}`);
        db.stamps.push({ p_notice: args.p_notice, p_subject_ids: args.p_subject_ids });
        return Promise.resolve({ data: 1, error: null });
      }
      events.log.push(`rpc:${name}`);
      return Promise.resolve({ data: db.rpcRows[name] ?? [], error: null });
    },
  }),
}));

import {
  deliverWorkspaceClosureNotifications,
  deliverWorkspaceDecisionNotifications,
} from "@/lib/email/workspace-closure-notifications";

let errors: string[] = [];
beforeEach(() => {
  errors = [];
  env.support = "founder@test.local";
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

const closure = (id: string) => ({
  audit_event_id: id,
  organisation_slug: "neon-nights",
  organisation_name: "Neon Nights Ltd",
  closed_at: "2026-10-04T12:00:00.000Z",
});
const decision = (id: string, notice: string, emails: string[] | null) => ({
  audit_event_id: id,
  notice,
  emails,
  organisation_slug: "neon-nights",
  organisation_name: "Neon Nights Ltd",
  decided_at: "2026-10-05T12:00:00.000Z",
});

describe("workspace-closed notices -> the superuser", () => {
  it("one email per closure to SUPPORT_CONTACT_EMAIL, each stamped workspace_closed AFTER its send", async () => {
    db.rpcRows.pending_workspace_closure_notifications = [closure("a1"), closure("a2")];
    send.fn.mockResolvedValue({ ok: true, messageId: "m" });
    const result = await deliverWorkspaceClosureNotifications();
    expect(result).toEqual({ outcome: "delivered", sent: 2, failed: 0, deferred: 0 });
    expect(events.log).toEqual([
      "rpc:pending_workspace_closure_notifications",
      "send:founder@test.local",
      "stamp:workspace_closed:a1",
      "send:founder@test.local",
      "stamp:workspace_closed:a2",
    ]);
  });

  it("a failed send stamps nothing and the next closure still goes", async () => {
    db.rpcRows.pending_workspace_closure_notifications = [closure("a1"), closure("a2")];
    send.fn.mockResolvedValueOnce({ ok: false, error: "Brevo 503" }).mockResolvedValueOnce({ ok: true, messageId: "m" });
    const result = await deliverWorkspaceClosureNotifications();
    expect(result).toEqual({ outcome: "delivered", sent: 1, failed: 1, deferred: 0 });
    expect(db.stamps).toEqual([{ p_notice: "workspace_closed", p_subject_ids: ["a2"] }]);
  });

  it("a THROWN send is a failure, not a stamp", async () => {
    db.rpcRows.pending_workspace_closure_notifications = [closure("a1")];
    send.fn.mockRejectedValue(new TypeError("boom"));
    await deliverWorkspaceClosureNotifications();
    expect(db.stamps).toHaveLength(0);
  });

  it("SUPPORT_CONTACT_EMAIL unset: nothing sent, nothing stamped, and NOTHING recorded undeliverable", async () => {
    env.support = null;
    db.rpcRows.pending_workspace_closure_notifications = [closure("a1")];
    const result = await deliverWorkspaceClosureNotifications();
    expect(result).toEqual({ outcome: "delivered", sent: 0, failed: 1, deferred: 0 });
    expect(send.fn).not.toHaveBeenCalled();
    expect(events.log).toEqual(["rpc:pending_workspace_closure_notifications"]);
  });

  it("extra row columns never reach the email (the builder takes four named fields)", async () => {
    db.rpcRows.pending_workspace_closure_notifications = [
      { ...closure("a1"), reason: "PLANTED REASON", actor_user_id: "PLANTED-ACTOR" },
    ];
    send.fn.mockResolvedValue({ ok: true, messageId: "m" });
    await deliverWorkspaceClosureNotifications();
    const mail = send.fn.mock.calls[0][0] as { subject: string; text: string; html: string };
    expect(`${mail.subject}${mail.text}${mail.html}`).not.toMatch(/PLANTED/);
    expect(mail.text).toContain("https://app.example.test/super/closures");
  });

  it("a closure its builder refuses is recorded undeliverable, never sent", async () => {
    db.rpcRows.pending_workspace_closure_notifications = [{ ...closure("a1"), organisation_slug: "../x" }];
    await deliverWorkspaceClosureNotifications();
    expect(send.fn).not.toHaveBeenCalled();
    expect(events.log).toContain("refuse:workspace_closed:a1:content_refused");
  });
});

describe("decision notices -> the snapshotted Owners and Admins", () => {
  it("the resolver's snapshot is the WHOLE recipient set, Bcc'd, and the stamp names the decision", async () => {
    db.rpcRows.pending_workspace_decision_notifications = [
      decision("d1", "workspace_reassigned", ["admin@a.test", "owner@a.test"]),
      decision("d2", "workspace_deleted", ["owner@b.test"]),
    ];
    send.fn.mockResolvedValue({ ok: true, messageId: "m" });
    const result = await deliverWorkspaceDecisionNotifications();
    expect(result).toEqual({ outcome: "delivered", sent: 2, failed: 0, deferred: 0 });
    expect(events.log).toEqual([
      "rpc:pending_workspace_decision_notifications",
      "send:|bcc:admin@a.test+owner@a.test",
      "stamp:workspace_reassigned:d1",
      "send:owner@b.test",
      "stamp:workspace_deleted:d2",
    ]);
    // The superuser inbox is never added to the admins' notice.
    expect(events.log.join("\n")).not.toContain("founder@test.local");
  });

  it("an EMPTY snapshot is a terminal no_recipient, never a send to anyone else", async () => {
    db.rpcRows.pending_workspace_decision_notifications = [decision("d1", "workspace_deleted", null)];
    await deliverWorkspaceDecisionNotifications();
    expect(send.fn).not.toHaveBeenCalled();
    expect(events.log).toContain("refuse:workspace_deleted:d1:no_recipient");
  });

  it("a failed send stamps nothing; no address is logged", async () => {
    db.rpcRows.pending_workspace_decision_notifications = [decision("d1", "workspace_reassigned", ["owner@a.test"])];
    send.fn.mockResolvedValue({ ok: false, error: "Brevo 503" });
    await deliverWorkspaceDecisionNotifications();
    expect(db.stamps).toHaveLength(0);
    expect(errors.join("\n")).not.toMatch(/@a\.test/);
  });

  it("extra row columns (the reason, the new Owner) never reach the email", async () => {
    db.rpcRows.pending_workspace_decision_notifications = [
      { ...decision("d1", "workspace_reassigned", ["owner@a.test"]), reason: "PLANTED REASON", new_owner: "PLANTED OWNER" },
    ];
    send.fn.mockResolvedValue({ ok: true, messageId: "m" });
    await deliverWorkspaceDecisionNotifications();
    const mail = send.fn.mock.calls[0][0] as { subject: string; text: string; html: string };
    expect(`${mail.subject}${mail.text}${mail.html}`).not.toMatch(/PLANTED/);
  });
});
