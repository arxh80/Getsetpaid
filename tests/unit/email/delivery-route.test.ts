import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// POST /api/incident-alerts/deliver: the bearer gate. Unset secret and wrong
// secret are both 404 (no endpoint exists for a prober); only the exact secret
// reaches the sender.

const deliver = vi.hoisted(() => ({
  fn: vi.fn(),
  telegram: vi.fn(),
  lockouts: vi.fn(),
  dsr: vi.fn(),
  exports: vi.fn(),
  erasures: vi.fn(),
  connections: vi.fn(),
  reminders: vi.fn(),
  closures: vi.fn(),
  decisions: vi.fn(),
}));
vi.mock("@/lib/email/incident-alerts", () => ({
  deliverPendingIncidentAlerts: () => deliver.fn(),
  deliverPendingIncidentAlertsToTelegram: () => deliver.telegram(),
}));
vi.mock("@/lib/email/lockout-notification", () => ({
  deliverLockoutNotifications: () => deliver.lockouts(),
}));
vi.mock("@/lib/email/requester-notifications", () => ({
  deliverDsrNotifications: () => deliver.dsr(),
  deliverExportReadyNotifications: () => deliver.exports(),
  deliverErasureFailureNotifications: () => deliver.erasures(),
}));
vi.mock("@/lib/email/network-notifications", () => ({
  deliverConnectionRequestNotifications: () => deliver.connections(),
}));
vi.mock("@/lib/email/task-reminder-notifications", () => ({
  deliverTaskReminderNotifications: () => deliver.reminders(),
}));
vi.mock("@/lib/email/workspace-closure-notifications", () => ({
  deliverWorkspaceClosureNotifications: () => deliver.closures(),
  deliverWorkspaceDecisionNotifications: () => deliver.decisions(),
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
  deliver.telegram.mockResolvedValue({ outcome: "disabled" });
  deliver.lockouts.mockResolvedValue({ outcome: "nothing_pending" });
  deliver.dsr.mockResolvedValue({ outcome: "nothing_pending" });
  deliver.exports.mockResolvedValue({ outcome: "nothing_pending" });
  deliver.erasures.mockResolvedValue({ outcome: "nothing_pending" });
  deliver.connections.mockResolvedValue({ outcome: "nothing_pending" });
  deliver.reminders.mockResolvedValue({ outcome: "nothing_pending" });
  deliver.closures.mockResolvedValue({ outcome: "nothing_pending" });
  deliver.decisions.mockResolvedValue({ outcome: "nothing_pending" });
});
afterEach(() => {
  deliver.fn.mockReset();
  deliver.telegram.mockReset();
  deliver.lockouts.mockReset();
  deliver.dsr.mockReset();
  deliver.exports.mockReset();
  deliver.erasures.mockReset();
  deliver.connections.mockReset();
  deliver.reminders.mockReset();
  deliver.closures.mockReset();
  deliver.decisions.mockReset();
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
      telegram: { outcome: "disabled" },
      accountNotifications: { outcome: "delivered", sent: 2, failed: 0 },
      dataRequestNotifications: { outcome: "nothing_pending" },
      exportReadyNotifications: { outcome: "nothing_pending" },
      erasureFailureNotifications: { outcome: "nothing_pending" },
      connectionRequestNotifications: { outcome: "nothing_pending" },
      taskReminderNotifications: { outcome: "nothing_pending" },
      workspaceClosureNotifications: { outcome: "nothing_pending" },
      workspaceDecisionNotifications: { outcome: "nothing_pending" },
    });
  });

  // Task 9c job 2b: the two workspace-closure loops run on the same tick,
  // and each still runs when the other throws.
  it("runs the closure and decision notices, each independent of the other", async () => {
    process.env.INCIDENT_ALERT_DELIVERY_SECRET = SECRET;
    deliver.closures.mockRejectedValue(new TypeError("boom"));
    deliver.decisions.mockResolvedValue({ outcome: "delivered", sent: 1, failed: 0, deferred: 0 });
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await POST(post(`Bearer ${SECRET}`));
    spy.mockRestore();
    expect(deliver.closures).toHaveBeenCalledOnce();
    expect(deliver.decisions).toHaveBeenCalledOnce();
    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toMatchObject({
      workspaceClosureNotifications: { outcome: "unavailable", error: "TypeError" },
      workspaceDecisionNotifications: { outcome: "delivered", sent: 1 },
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

  // Q111: Telegram is a THIRD independent delivery. Its failure -- returned
  // or thrown -- must not stop the email digest or the lockout notices, and
  // an email failure must not stop Telegram. (Each stamp is written inside
  // its own sender, so "not un-stamped" is senders.test.ts's half; this is
  // "not blocked".)
  it("a FAILED Telegram send leaves the email digest and lockouts reported as they were", async () => {
    process.env.INCIDENT_ALERT_DELIVERY_SECRET = SECRET;
    deliver.fn.mockResolvedValue({ outcome: "sent", count: 2, messageId: "m" });
    deliver.telegram.mockResolvedValue({ outcome: "failed", count: 2, error: "Telegram 502" });
    deliver.lockouts.mockResolvedValue({ outcome: "delivered", sent: 1, failed: 0 });
    const res = await POST(post(`Bearer ${SECRET}`));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      outcome: "sent",
      count: 2,
      messageId: "m",
      telegram: { outcome: "failed", count: 2, error: "Telegram 502" },
      accountNotifications: { outcome: "delivered", sent: 1, failed: 0 },
      dataRequestNotifications: { outcome: "nothing_pending" },
      exportReadyNotifications: { outcome: "nothing_pending" },
      erasureFailureNotifications: { outcome: "nothing_pending" },
      connectionRequestNotifications: { outcome: "nothing_pending" },
      taskReminderNotifications: { outcome: "nothing_pending" },
      workspaceClosureNotifications: { outcome: "nothing_pending" },
      workspaceDecisionNotifications: { outcome: "nothing_pending" },
    });
  });

  it("a THROWING Telegram delivery still lets the lockout notices run", async () => {
    process.env.INCIDENT_ALERT_DELIVERY_SECRET = SECRET;
    vi.spyOn(console, "error").mockImplementation(() => {});
    deliver.fn.mockResolvedValue({ outcome: "sent", count: 1, messageId: "m" });
    deliver.telegram.mockRejectedValue(new TypeError("boom"));
    deliver.lockouts.mockResolvedValue({ outcome: "delivered", sent: 1, failed: 0 });
    const res = await POST(post(`Bearer ${SECRET}`));
    expect(deliver.lockouts).toHaveBeenCalledOnce();
    await expect(res.json()).resolves.toMatchObject({
      outcome: "sent",
      telegram: { outcome: "unavailable" },
      accountNotifications: { outcome: "delivered" },
    });
  });

  it("a FAILED or THROWING email digest still lets Telegram run", async () => {
    process.env.INCIDENT_ALERT_DELIVERY_SECRET = SECRET;
    vi.spyOn(console, "error").mockImplementation(() => {});
    deliver.telegram.mockResolvedValue({ outcome: "sent", count: 1 });
    deliver.fn.mockResolvedValue({ outcome: "failed", count: 1, error: "Brevo 503" });
    let res = await POST(post(`Bearer ${SECRET}`));
    await expect(res.json()).resolves.toMatchObject({ outcome: "failed", telegram: { outcome: "sent" } });
    deliver.fn.mockRejectedValue(new TypeError("boom"));
    res = await POST(post(`Bearer ${SECRET}`));
    expect(deliver.telegram).toHaveBeenCalledTimes(2);
    await expect(res.json()).resolves.toMatchObject({ outcome: "unavailable", telegram: { outcome: "sent" } });
  });

  // Task 9b job 2 (Q157(3)/Q174/Q45): the requester and superuser notices are
  // three more independent deliveries on the same tick. Each runs whatever
  // the others did, and each is reported under its own key.
  it("runs all three requester/superuser notices, each even when another throws, and reports each", async () => {
    process.env.INCIDENT_ALERT_DELIVERY_SECRET = SECRET;
    vi.spyOn(console, "error").mockImplementation(() => {});
    deliver.lockouts.mockRejectedValue(new TypeError("boom"));
    deliver.dsr.mockRejectedValue(new TypeError("boom"));
    deliver.exports.mockResolvedValue({ outcome: "delivered", sent: 1, failed: 0, deferred: 0 });
    deliver.erasures.mockResolvedValue({ outcome: "sent", count: 2 });
    const res = await POST(post(`Bearer ${SECRET}`));
    expect(deliver.dsr).toHaveBeenCalledOnce();
    expect(deliver.exports).toHaveBeenCalledOnce();
    expect(deliver.erasures).toHaveBeenCalledOnce();
    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toMatchObject({
      dataRequestNotifications: { outcome: "unavailable" },
      exportReadyNotifications: { outcome: "delivered", sent: 1 },
      erasureFailureNotifications: { outcome: "sent", count: 2 },
    });
  });

  it("a FAILED requester notice is not a 503 (it retries next tick); an unreadable queue is", async () => {
    process.env.INCIDENT_ALERT_DELIVERY_SECRET = SECRET;
    deliver.erasures.mockResolvedValue({ outcome: "failed", count: 1, error: "Brevo 503" });
    expect((await POST(post(`Bearer ${SECRET}`))).status).toBe(200);
    deliver.exports.mockResolvedValue({ outcome: "unavailable", error: "x" });
    expect((await POST(post(`Bearer ${SECRET}`))).status).toBe(503);
  });

  it("a disabled Telegram channel is not a 503", async () => {
    process.env.INCIDENT_ALERT_DELIVERY_SECRET = SECRET;
    deliver.telegram.mockResolvedValue({ outcome: "disabled" });
    expect((await POST(post(`Bearer ${SECRET}`))).status).toBe(200);
  });

  // Task 9b job 3 (same ruling): the connection-request notices and the task
  // reminder are two more independent deliveries, LAST on the tick.
  it("runs the connection and reminder notices even when every earlier delivery throws, and reports each", async () => {
    process.env.INCIDENT_ALERT_DELIVERY_SECRET = SECRET;
    vi.spyOn(console, "error").mockImplementation(() => {});
    deliver.fn.mockRejectedValue(new TypeError("boom"));
    deliver.telegram.mockRejectedValue(new TypeError("boom"));
    deliver.lockouts.mockRejectedValue(new TypeError("boom"));
    deliver.dsr.mockRejectedValue(new TypeError("boom"));
    deliver.exports.mockRejectedValue(new TypeError("boom"));
    deliver.erasures.mockRejectedValue(new TypeError("boom"));
    deliver.connections.mockResolvedValue({ outcome: "delivered", sent: 2, failed: 0, deferred: 0 });
    deliver.reminders.mockResolvedValue({ outcome: "delivered", sent: 1, failed: 0, deferred: 0 });
    const res = await POST(post(`Bearer ${SECRET}`));
    expect(deliver.connections).toHaveBeenCalledOnce();
    expect(deliver.reminders).toHaveBeenCalledOnce();
    await expect(res.json()).resolves.toMatchObject({
      connectionRequestNotifications: { outcome: "delivered", sent: 2 },
      taskReminderNotifications: { outcome: "delivered", sent: 1 },
    });
  });

  it("a THROWING connection delivery still lets the reminders run, and an unreadable queue is a 503", async () => {
    process.env.INCIDENT_ALERT_DELIVERY_SECRET = SECRET;
    vi.spyOn(console, "error").mockImplementation(() => {});
    deliver.connections.mockRejectedValue(new TypeError("boom"));
    const res = await POST(post(`Bearer ${SECRET}`));
    expect(deliver.reminders).toHaveBeenCalledOnce();
    expect(res.status).toBe(503);
    deliver.connections.mockResolvedValue({ outcome: "nothing_pending" });
    deliver.reminders.mockResolvedValue({ outcome: "delivered", sent: 0, failed: 1, deferred: 0 });
    expect((await POST(post(`Bearer ${SECRET}`))).status).toBe(200);
  });
});
