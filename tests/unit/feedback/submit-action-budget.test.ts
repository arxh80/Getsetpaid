import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// THE ORDER OF submitFeedbackAction, which a database cannot see (Phase 7
// Task 6 fix round 1, finding I1): the budget is READ before any Storage I/O,
// so a spent budget -- or a budget the database could not report -- refuses
// with no upload, no scan and no insert. The first cut uploaded up to 5 MiB
// through the service-role Storage client and ran the scanner BEFORE the
// metered INSERT, so a refused submitter could loop the action and burn
// storage and scanner time with the counter flat at 10. The load-bearing
// assertion is `upload` never being called; against that code it fails.
//
// Also here, because they are order facts too: an impersonating session now
// submits a row with NO workspace on it rather than being refused (Q121,
// reversing fix round 1's M4, and the LABEL is the database's to stamp); a
// refused insert removes the orphaned object and LOGS a failed removal (M7);
// a PT429 that arrives without a hint is logged rather than silently
// over-stated (M7); and the founder's receipt runs through next/server's
// after(), not on the response path (I2).

const stubs = vi.hoisted(() => ({
  rpc: vi.fn(),
  insert: vi.fn(),
  upload: vi.fn(),
  remove: vi.fn(),
  scan: vi.fn(),
  notify: vi.fn(),
  afterCallbacks: [] as Array<() => unknown>,
  org: null as null | Record<string, unknown>,
}));

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "user-agent": "vitest/1.0" }),
}));
vi.mock("next/server", () => ({
  after: (fn: () => unknown) => {
    stubs.afterCallbacks.push(fn);
  },
}));
vi.mock("@/lib/auth", () => ({
  getCurrentUser: async () => ({ id: "u1", email: "u@example.test", fullName: null }),
  getCurrentOrg: async () => stubs.org,
}));
vi.mock("@/lib/auth/current-path", () => ({
  currentPath: async () => "/org-a/contacts/11111111-2222-4333-8444-555555555555?q=secret",
}));
vi.mock("@/lib/admin/impersonation-contract", () => ({
  auditableRoute: (p: string) => p.split("?")[0],
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    rpc: (name: string) => ({ single: async () => stubs.rpc(name) }),
    from: () => ({ insert: (row: unknown) => stubs.insert(row) }),
  }),
}));
vi.mock("@/lib/supabase/storage", () => ({
  createStorageClient: () => ({
    storage: {
      from: () => ({
        upload: (...a: unknown[]) => stubs.upload(...a),
        remove: (...a: unknown[]) => stubs.remove(...a),
      }),
    },
  }),
}));
vi.mock("@/lib/security/file-allowlist", () => ({
  sniffAndAllow: () => ({ ok: true, mime: "image/png" }),
}));
vi.mock("@/lib/security/malware-scan", () => ({
  getScanner: () => ({ scan: (...a: unknown[]) => stubs.scan(...a) }),
}));
vi.mock("@/lib/email/feedback-notification", () => ({
  notifyFounderOfFeedback: (...a: unknown[]) => stubs.notify(...a),
}));

import { submitFeedbackAction } from "@/lib/feedback/actions";
import { SUPPORT_ACCESS_LABEL } from "@/lib/feedback/contract";
import { EMPTY_FORM_STATE } from "@/lib/forms";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

function form(withScreenshot = true): FormData {
  const data = new FormData();
  data.set("category", "bug");
  data.set("message", "the venue picker forgets my filter");
  if (withScreenshot) {
    data.set("screenshot", new File([PNG], "shot.png", { type: "image/png" }));
  }
  return data;
}

const member = {
  id: "org-a-id",
  name: "Alpha",
  slug: "org-a",
  role: "manager",
  isSuspended: false,
  lifecycle: null,
  isImpersonated: false,
  impersonationExpiresAt: null,
};

beforeEach(() => {
  stubs.org = member;
  stubs.upload.mockResolvedValue({ data: { path: "x" }, error: null });
  stubs.remove.mockResolvedValue({ data: [], error: null });
  stubs.scan.mockResolvedValue("clean");
  stubs.insert.mockResolvedValue({ error: null });
  stubs.notify.mockResolvedValue(undefined);
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  for (const fn of Object.values(stubs)) if (typeof fn === "function") fn.mockReset();
  stubs.afterCallbacks.length = 0;
  vi.restoreAllMocks();
});

describe("submitFeedbackAction reads the budget before it touches storage (I1)", () => {
  it("a SPENT budget refuses with the human wait and performs NO upload, scan or insert", async () => {
    stubs.rpc.mockResolvedValue({ data: { remaining: 0, retry_after_seconds: 1800 }, error: null });

    const result = await submitFeedbackAction(EMPTY_FORM_STATE, form());

    expect(result.error).toBe("Too many feedback submissions just now. Try again in 30 minutes.");
    expect(stubs.rpc).toHaveBeenCalledWith("feedback_budget_remaining");
    expect(stubs.upload, "the 5 MiB service-role write must not happen for a spent budget").not.toHaveBeenCalled();
    expect(stubs.scan, "the scanner must not run for a spent budget").not.toHaveBeenCalled();
    expect(stubs.insert).not.toHaveBeenCalled();
    expect(stubs.notify).not.toHaveBeenCalled();
    expect(stubs.afterCallbacks).toHaveLength(0);
  });

  it("a budget the database could not report FAILS CLOSED the same way, and says so in the log", async () => {
    stubs.rpc.mockResolvedValue({ data: null, error: { message: "permission denied" } });

    const result = await submitFeedbackAction(EMPTY_FORM_STATE, form());

    expect(result.error).toBe("Too many feedback submissions just now. Try again in 60 minutes.");
    expect(stubs.upload).not.toHaveBeenCalled();
    expect(stubs.scan).not.toHaveBeenCalled();
    expect(stubs.insert).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("budget pre-check failed"),
      "permission denied",
    );
  });

  it("with budget left it uploads under feedback/{id}, scans, inserts, and hands the receipt to after()", async () => {
    stubs.rpc.mockResolvedValue({ data: { remaining: 9, retry_after_seconds: 1800 }, error: null });

    const result = await submitFeedbackAction(EMPTY_FORM_STATE, form());

    expect(result).toEqual({ message: "Thanks — your feedback has been recorded." });
    expect(stubs.upload).toHaveBeenCalledOnce();
    const key = stubs.upload.mock.calls[0][0] as string;
    expect(key).toMatch(/^feedback\/[0-9a-f-]{36}$/);
    expect(stubs.scan).toHaveBeenCalledOnce();
    expect(stubs.insert).toHaveBeenCalledOnce();
    const row = stubs.insert.mock.calls[0][0] as Record<string, unknown>;
    expect(row.screenshot_key).toBe(key);
    expect(row.screenshot_scan_status).toBe("clean");
    expect(row.organisation_id).toBe("org-a-id");
    expect(row.route, "the query string is never stored").toBe(
      "/org-a/contacts/11111111-2222-4333-8444-555555555555",
    );
    expect(row).not.toHaveProperty("user_id");

    // I2: the receipt is NOT awaited on the response path. It was handed to
    // after(); nothing has been sent yet, and running the callback sends it.
    expect(stubs.notify).not.toHaveBeenCalled();
    expect(stubs.afterCallbacks).toHaveLength(1);
    await stubs.afterCallbacks[0]();
    expect(stubs.notify).toHaveBeenCalledOnce();
    expect(stubs.notify.mock.calls[0][0]).toMatchObject({
      feedbackId: key.slice("feedback/".length),
      organisationSlug: "org-a",
      screenshot: "clean",
    });
  });

  it("the upload comes AFTER the budget read, never before it", async () => {
    const order: string[] = [];
    stubs.rpc.mockImplementation(async () => {
      order.push("budget");
      return { data: { remaining: 1, retry_after_seconds: 10 }, error: null };
    });
    stubs.upload.mockImplementation(async () => {
      order.push("upload");
      return { data: { path: "x" }, error: null };
    });

    await submitFeedbackAction(EMPTY_FORM_STATE, form());

    expect(order).toEqual(["budget", "upload"]);
  });
});

describe("submitFeedbackAction under a support-access session (Q121)", () => {
  beforeEach(() => {
    stubs.org = {
      ...member,
      role: "read_only",
      isImpersonated: true,
      impersonationExpiresAt: "2026-09-11T10:00:00Z",
    };
    stubs.rpc.mockResolvedValue({ data: { remaining: 5, retry_after_seconds: 600 }, error: null });
  });

  it("is ACCEPTED, and the row carries NO workspace -- the reversal of fix round 1's M4", async () => {
    const result = await submitFeedbackAction(EMPTY_FORM_STATE, form());

    expect(result.message).toContain("recorded");
    expect(stubs.insert).toHaveBeenCalledOnce();
    const row = stubs.insert.mock.calls[0]![0] as Record<string, unknown>;
    expect(row.organisation_id).toBeNull();
    // The workspace the operator was LOOKING at is not smuggled in under
    // another name either: the row is exactly as workspace-less as it claims.
    expect(Object.values(row)).not.toContain(member.id);
  });

  it("never sets the label itself -- `during_support_access` is the database's column", async () => {
    await submitFeedbackAction(EMPTY_FORM_STATE, form());

    const row = stubs.insert.mock.calls[0]![0] as Record<string, unknown>;
    // Naming it would be 42501 at the column grant (20260916002000); this
    // asserts the action does not try, which is what keeps the app path and
    // the raw PostgREST path bound by the same rule.
    expect(Object.keys(row)).not.toContain("during_support_access");
    expect(SUPPORT_ACCESS_LABEL).toBe("Sent during support access");
  });

  it("still captures the route the operator was on, and still uploads the screenshot", async () => {
    await submitFeedbackAction(EMPTY_FORM_STATE, form());

    const row = stubs.insert.mock.calls[0]![0] as Record<string, unknown>;
    expect(row.route).toBe("/org-a/contacts/11111111-2222-4333-8444-555555555555");
    expect(stubs.upload).toHaveBeenCalledOnce();
  });

  it("tells the founder's receipt it was support access, and names no workspace", async () => {
    await submitFeedbackAction(EMPTY_FORM_STATE, form());
    for (const cb of stubs.afterCallbacks) await cb();

    expect(stubs.notify).toHaveBeenCalledOnce();
    const payload = stubs.notify.mock.calls[0]![0] as Record<string, unknown>;
    expect(payload.supportAccess).toBe(true);
    expect(payload.organisationName).toBeNull();
    expect(payload.organisationSlug).toBeNull();
    expect(payload.organisationRole).toBeNull();
  });
});

describe("submitFeedbackAction after a refused insert (M7)", () => {
  beforeEach(() => {
    stubs.rpc.mockResolvedValue({ data: { remaining: 1, retry_after_seconds: 600 }, error: null });
  });

  it("removes the orphaned object, and LOGS a removal that fails rather than ignoring it", async () => {
    stubs.insert.mockResolvedValue({ error: { code: "PT429", hint: "600", message: "limit" } });
    stubs.remove.mockResolvedValue({ data: null, error: { message: "object locked" } });

    const result = await submitFeedbackAction(EMPTY_FORM_STATE, form());

    expect(result.error).toBe("Too many feedback submissions just now. Try again in 10 minutes.");
    expect(stubs.remove).toHaveBeenCalledOnce();
    expect(stubs.remove.mock.calls[0][0]).toEqual([stubs.upload.mock.calls[0][0]]);
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("could not be removed after a refused insert"),
      "object locked",
    );
  });

  it("a PT429 that arrives WITHOUT a hint is logged and rendered as the whole window (60 minutes)", async () => {
    stubs.insert.mockResolvedValue({ error: { code: "PT429", hint: undefined, message: "limit" } });

    const result = await submitFeedbackAction(EMPTY_FORM_STATE, form(false));

    expect(result.error).toBe("Too many feedback submissions just now. Try again in 60 minutes.");
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("PT429 arrived without a usable hint"),
      undefined,
    );
    expect(stubs.remove, "nothing was uploaded, so nothing is removed").not.toHaveBeenCalled();
  });
});
