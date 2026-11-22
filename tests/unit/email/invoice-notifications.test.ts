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

import {
  deliverInvoiceBankChangeNotifications,
  deliverInvoiceDeliveredNotifications,
  deliverInvoiceStripeAccountNotifications,
} from "@/lib/email/invoice-notifications";

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

const stripeRow = (id: string, emails: string[] | null, change: string = "linked") => ({
  audit_event_id: id,
  emails,
  organisation_slug: "neon-nights",
  organisation_name: "Neon Nights Ltd",
  change,
  changed_at: "2026-10-20T12:00:00.000Z",
});

describe("deliverInvoiceStripeAccountNotifications", () => {
  it("emails the resolver's Owners and Admins, THEN stamps the one audit row under its own notice", async () => {
    db.rows = [stripeRow("s1", ["admin@example.test", "owner@example.test"])];
    send.fn.mockResolvedValue({ ok: true, messageId: "m" });
    await expect(deliverInvoiceStripeAccountNotifications()).resolves.toEqual({ outcome: "delivered", sent: 1, failed: 0, deferred: 0 });
    expect(events.log).toEqual([
      "rpc:pending_invoice_stripe_account_notifications",
      "send:admin@example.test+owner@example.test",
      "stamp:invoice_stripe_account_changed:s1",
    ]);
    expect(send.fn.mock.calls[0][0].subject).toContain("connected to neon-nights");
  });
  it("an ended link is worded as a disconnection", async () => {
    db.rows = [stripeRow("s2", ["owner@example.test"], "ended")];
    send.fn.mockResolvedValue({ ok: true, messageId: "m" });
    await deliverInvoiceStripeAccountNotifications();
    expect(send.fn.mock.calls[0][0].subject).toContain("disconnected from neon-nights");
  });
  it("a failed send stamps nothing", async () => {
    db.rows = [stripeRow("s1", ["owner@example.test"])];
    send.fn.mockResolvedValue({ ok: false, error: "Brevo 503" });
    await deliverInvoiceStripeAccountNotifications();
    expect(events.log.some((l) => l.startsWith("stamp:"))).toBe(false);
  });
  it("nobody to send to is recorded once as undeliverable", async () => {
    db.rows = [stripeRow("s1", null)];
    await deliverInvoiceStripeAccountNotifications();
    expect(events.log).toContain("refuse:invoice_stripe_account_changed:s1:no_recipient");
  });
  it("a row with a change it does not know is refused as undeliverable, never sent", async () => {
    db.rows = [stripeRow("s3", ["owner@example.test"], "exploded")];
    await deliverInvoiceStripeAccountNotifications();
    expect(send.fn).not.toHaveBeenCalled();
    expect(events.log).toContain("refuse:invoice_stripe_account_changed:s3:content_refused");
  });
  it("nothing pending is nothing_pending", async () => {
    await expect(deliverInvoiceStripeAccountNotifications()).resolves.toEqual({ outcome: "nothing_pending" });
  });
});

const deliveredRow = (id: string, emails: string[] | null, sender: string | null = "Alpha Promotions Ltd") => ({
  audit_event_id: id,
  emails,
  organisation_slug: "neon-nights",
  organisation_name: "Neon Nights Ltd",
  sender_name: sender,
  delivered_at: "2026-11-17T12:00:00.000Z",
});

describe("deliverInvoiceDeliveredNotifications", () => {
  it("reads the resolver, sends one email per row to the receiver's finance holders, THEN stamps it under invoice_delivered", async () => {
    db.rows = [deliveredRow("a1", ["fin@r.example", "owner@r.example"])];
    send.fn.mockResolvedValue({ ok: true, messageId: "m-1" });
    await expect(deliverInvoiceDeliveredNotifications()).resolves.toEqual({ outcome: "delivered", sent: 1, failed: 0, deferred: 0 });
    expect(events.log).toEqual([
      "rpc:pending_invoice_delivery_notifications",
      "send:fin@r.example+owner@r.example",
      "stamp:invoice_delivered:a1",
    ]);
    expect(send.fn.mock.calls[0][0].subject).toBe("[GetSetPaid] New invoice from Alpha Promotions Ltd");
  });
  it("a snapshot with no seller name still sends, with the neutral sender", async () => {
    db.rows = [deliveredRow("a2", ["fin@r.example"], null)];
    send.fn.mockResolvedValue({ ok: true, messageId: "m" });
    await deliverInvoiceDeliveredNotifications();
    expect(send.fn.mock.calls[0][0].subject).toBe("[GetSetPaid] New invoice from A connected workspace");
  });
  it("a failed send stamps nothing", async () => {
    db.rows = [deliveredRow("a1", ["fin@r.example"])];
    send.fn.mockResolvedValue({ ok: false, error: "Brevo 503" });
    await deliverInvoiceDeliveredNotifications();
    expect(events.log.some((l) => l.startsWith("stamp:"))).toBe(false);
  });
  it("nobody to send to is recorded once as undeliverable", async () => {
    db.rows = [deliveredRow("a1", null)];
    await deliverInvoiceDeliveredNotifications();
    expect(events.log).toContain("refuse:invoice_delivered:a1:no_recipient");
  });
  it("nothing pending is nothing_pending", async () => {
    await expect(deliverInvoiceDeliveredNotifications()).resolves.toEqual({ outcome: "nothing_pending" });
  });
});
