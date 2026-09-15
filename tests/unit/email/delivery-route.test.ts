import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// POST /api/incident-alerts/deliver: the bearer gate. Unset secret and wrong
// secret are both 404 (no endpoint exists for a prober); only the exact secret
// reaches the sender.

const deliver = vi.hoisted(() => ({ fn: vi.fn(), lockouts: vi.fn() }));
vi.mock("@/lib/email/incident-alerts", () => ({
  deliverPendingIncidentAlerts: () => deliver.fn(),
}));
vi.mock("@/lib/email/lockout-notification", () => ({
  deliverLockoutNotifications: () => deliver.lockouts(),
}));

import { POST } from "@/app/api/incident-alerts/deliver/route";

const SECRET = "0123456789abcdef0123456789abcdef";

function post(auth?: string): Request {
  return new Request("http://localhost/api/incident-alerts/deliver", {
    method: "POST",
    headers: auth ? { authorization: auth } : {},
  });
}

beforeEach(() => {
  deliver.fn.mockResolvedValue({ outcome: "nothing_pending" });
  deliver.lockouts.mockResolvedValue({ outcome: "nothing_pending" });
});
afterEach(() => {
  deliver.fn.mockReset();
  deliver.lockouts.mockReset();
  delete process.env.INCIDENT_ALERT_DELIVERY_SECRET;
});

describe("the delivery route's gate", () => {
  it("is a 404 with no secret configured, even with a bearer presented", async () => {
    const res = await POST(post(`Bearer ${SECRET}`));
    expect(res.status).toBe(404);
    expect(deliver.fn).not.toHaveBeenCalled();
  });

  it("refuses a secret shorter than 32 characters as unconfigured", async () => {
    process.env.INCIDENT_ALERT_DELIVERY_SECRET = "short";
    const res = await POST(post("Bearer short"));
    expect(res.status).toBe(404);
    expect(deliver.fn).not.toHaveBeenCalled();
  });

  it("is a 404 for a wrong or missing bearer", async () => {
    process.env.INCIDENT_ALERT_DELIVERY_SECRET = SECRET;
    expect((await POST(post())).status).toBe(404);
    expect((await POST(post("Bearer nope"))).status).toBe(404);
    expect((await POST(post(`Bearer ${SECRET}x`))).status).toBe(404);
    expect(deliver.fn).not.toHaveBeenCalled();
    expect(deliver.lockouts).not.toHaveBeenCalled();
  });

  it("delivers with the right bearer and returns BOTH results", async () => {
    process.env.INCIDENT_ALERT_DELIVERY_SECRET = SECRET;
    deliver.fn.mockResolvedValue({ outcome: "sent", count: 3, messageId: "m" });
    deliver.lockouts.mockResolvedValue({ outcome: "delivered", sent: 2, failed: 0 });
    const res = await POST(post(`Bearer ${SECRET}`));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    await expect(res.json()).resolves.toEqual({
      outcome: "sent",
      count: 3,
      messageId: "m",
      accountNotifications: { outcome: "delivered", sent: 2, failed: 0 },
    });
  });

  it("maps a read failure to 503", async () => {
    process.env.INCIDENT_ALERT_DELIVERY_SECRET = SECRET;
    deliver.fn.mockResolvedValue({ outcome: "unavailable", error: "x" });
    expect((await POST(post(`Bearer ${SECRET}`))).status).toBe(503);
  });

  // Q114: the two deliveries are independent. A digest that cannot be read
  // must not silently swallow the account-holder notices, and vice versa --
  // which is exactly what a single `await` pair would do if either threw or
  // if the route returned early on the first failure.
  it("still runs the lockout notices when the digest is unavailable", async () => {
    process.env.INCIDENT_ALERT_DELIVERY_SECRET = SECRET;
    deliver.fn.mockResolvedValue({ outcome: "unavailable", error: "x" });
    deliver.lockouts.mockResolvedValue({ outcome: "delivered", sent: 1, failed: 0 });
    const res = await POST(post(`Bearer ${SECRET}`));
    expect(deliver.lockouts).toHaveBeenCalledOnce();
    await expect(res.json()).resolves.toMatchObject({
      accountNotifications: { outcome: "delivered", sent: 1 },
    });
  });

  it("maps an unavailable LOCKOUT read to 503 too, with the digest still reported", async () => {
    process.env.INCIDENT_ALERT_DELIVERY_SECRET = SECRET;
    deliver.fn.mockResolvedValue({ outcome: "sent", count: 1, messageId: "m" });
    deliver.lockouts.mockResolvedValue({ outcome: "unavailable", error: "y" });
    const res = await POST(post(`Bearer ${SECRET}`));
    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toMatchObject({ outcome: "sent", count: 1 });
  });
});
