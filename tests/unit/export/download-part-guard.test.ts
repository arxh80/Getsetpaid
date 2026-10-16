import { beforeEach, describe, expect, it, vi } from "vitest";

// THE PART GUARD OF THE ONE DOWNLOAD PATH (Q228 Task 3, fix round 1).
//
// issueExportDownloadUrl(jobId, part) refuses a part that is not a positive
// whole number BEFORE it identifies the caller, builds a Supabase client, or
// calls the audit RPC. The route already refuses such a part through
// parsePartParam, so this guard is defence in depth for any other caller --
// and a guard that nothing measures is one a refactor removes silently. The
// clients are faked (the shape tests/unit/crm/finance-summary-outcome.test.ts
// uses): the property under test is "nothing was reached", which only spies
// can observe.

const createClient = vi.fn();
const createStorageClient = vi.fn();
const getCurrentUser = vi.fn();
const rpc = vi.fn();

/** `from(...).select(...).eq(...).maybeSingle()` resolving to no row, and an rpc spy. */
function fakeClient() {
  const chain: unknown = new Proxy({} as Record<string, unknown>, {
    get(_t, key) {
      if (key === "maybeSingle") return async () => ({ data: null, error: null });
      return () => chain;
    },
  });
  return { from: () => chain, rpc };
}

vi.mock("@/lib/supabase/server", () => ({ createClient: (...a: unknown[]) => createClient(...a) }));
vi.mock("@/lib/supabase/storage", () => ({
  createStorageClient: (...a: unknown[]) => createStorageClient(...a),
}));
vi.mock("@/lib/auth", () => ({ getCurrentUser: (...a: unknown[]) => getCurrentUser(...a) }));

const { issueExportDownloadUrl } = await import("@/lib/export/download");
const { GET } = await import("@/app/(app)/account/exports/[jobId]/download/route");

const JOB = "33333333-3333-4333-8333-333333333333";

beforeEach(() => {
  vi.clearAllMocks();
  // A SIGNED-IN caller, so the part guard is the only thing that can stop the
  // call before a client exists.
  getCurrentUser.mockResolvedValue({ id: "44444444-4444-4444-8444-444444444444" });
  createClient.mockImplementation(async () => fakeClient());
  createStorageClient.mockImplementation(() => ({ storage: { from: () => ({}) } }));
});

describe("issueExportDownloadUrl refuses a malformed part before anything is reached", () => {
  it.each([0, -1, 1.5])("part %s is a 404, with no client created and no RPC called", async (part) => {
    const outcome = await issueExportDownloadUrl(JOB, part);
    expect(outcome).toEqual({ ok: false, status: 404 });
    expect(getCurrentUser).not.toHaveBeenCalled();
    expect(createClient).not.toHaveBeenCalled();
    expect(createStorageClient).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });

  it("DENOMINATOR: a well-formed part does reach the caller's client (the spies are wired)", async () => {
    // No row comes back, so this is a 404 too -- but only AFTER the lookup.
    const outcome = await issueExportDownloadUrl(JOB, 2);
    expect(outcome).toEqual({ ok: false, status: 404 });
    expect(getCurrentUser).toHaveBeenCalledTimes(1);
    expect(createClient).toHaveBeenCalledTimes(1);
  });
});

describe("the download route answers a malformed ?part= with the literal 404", () => {
  it.each(["0", "-1", "1.5"])("?part=%s is \"Not found\", no-store, and reaches no client", async (raw) => {
    const res = await GET(new Request(`http://localhost/account/exports/${JOB}/download?part=${raw}`), {
      params: Promise.resolve({ jobId: JOB }),
    });
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("Not found");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(getCurrentUser).not.toHaveBeenCalled();
    expect(createClient).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });
});
