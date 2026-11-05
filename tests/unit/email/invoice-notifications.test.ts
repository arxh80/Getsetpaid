import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const events = vi.hoisted(() => ({ log: [] as string[] }));
const send = vi.hoisted(() => ({ fn: vi.fn() }));
const db = vi.hoisted(() => ({ rows: [] as unknown[] }));

vi.mock("@/lib/email/send", () => ({
  sendEmail: async (i: { to: { email: string }[]; bcc?: { email: string }[] }) => {
    events.log.push(`send:${[...i.to, ...(i.bcc ?? [])].map((t) => t.email).sort().join("+")}`);
    return send.fn(i);
  },
}));
vi.mock("@/lib/supabase/env", () => ({ siteUrl: () => "https://app.example.test" }));
vi.mock("@/lib/supabase/service", () => ({
  createServiceClient: () => ({
    rpc(name: string, args: { p_notice?: string; p_subject_ids?: string[]; p_reason?: string }) {
      if (name === "mark_notices_delivered") {
        events.log.push(`stamp:${args.p_notice}:${args.p_subject_ids?.join(",")}`);
        return Promise.resolve({ data: 1, error: null });
      }
      if (name === "mark_notices_undeliverable") {
        events.log.push(`refuse:${args.p_notice}:${args.p_subject_ids?.join(",")}:${args.p_reason}`);
        return Promise.resolve({ data: 1, error: null });
      }
      events.log.push(`rpc:${name}`);
      return Promise.resolve({ data: db.rows, error: null });
    },
  }),
}));

import { deliverInvoiceBankChangeNotifications } from "@/lib/email/invoice-notifications";

const row = (id: string, emails: string[] | null) => ({
  audit_event_id: id,
  emails,
  organisation_slug: "neon-nights",
  organisation_name: "Neon Nights Ltd",
  account_last4: "4321",
  changed_at: "2026-10-20T12:00:00.000Z",
});

beforeEach(() => vi.spyOn(console, "error").mockImplementation(() => {}));
afterEach(() => {
  send.fn.mockReset();
  events.log = [];
  db.rows = [];
  vi.restoreAllMocks();
});

describe("deliverInvoiceBankChangeNotifications", () => {
  it("emails the resolver's Owners and Admins, THEN stamps the one audit row", async () => {
    db.rows = [row("b1", ["admin@example.test", "owner@example.test"])];
    send.fn.mockResolvedValue({ ok: true, messageId: "m" });
    await expect(deliverInvoiceBankChangeNotifications()).resolves.toEqual({ outcome: "delivered", sent: 1, failed: 0, deferred: 0 });
    expect(events.log).toEqual([
      "rpc:pending_invoice_bank_change_notifications",
      "send:admin@example.test+owner@example.test",
      "stamp:invoice_bank_details_changed:b1",
    ]);
  });
  it("a failed send stamps nothing", async () => {
    db.rows = [row("b1", ["owner@example.test"])];
    send.fn.mockResolvedValue({ ok: false, error: "Brevo 503" });
    await deliverInvoiceBankChangeNotifications();
    expect(events.log.some((l) => l.startsWith("stamp:"))).toBe(false);
  });
  it("nobody to send to is recorded once as undeliverable", async () => {
    db.rows = [row("b1", null)];
    await deliverInvoiceBankChangeNotifications();
    expect(events.log).toContain("refuse:invoice_bank_details_changed:b1:no_recipient");
  });
  it("nothing pending is nothing_pending", async () => {
    await expect(deliverInvoiceBankChangeNotifications()).resolves.toEqual({ outcome: "nothing_pending" });
  });
});
