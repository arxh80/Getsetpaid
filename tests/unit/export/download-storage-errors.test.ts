import { beforeEach, describe, expect, it, vi } from "vitest";

// Phase 10 Task 14 (G20). storage-js's exists() is a HEAD, and the storage API
// answers a HEAD on a missing object with 400, the status a fault gets too, so
// a Storage blip told the owner of a real archive "not found". The download
// now asks objectPresence() (info(), whose body says statusCode "404" for a
// missing object -- measured against the local stack): missing is still the
// 404, anything else is a 503 with no audit row. Clients are faked, the
// download-part-guard.test.ts shape; the live half is
// tests/integration/export/download-presence.test.ts.

const createClient = vi.fn();
const createStorageClient = vi.fn();
const getCurrentUser = vi.fn();
const rpc = vi.fn();
const info = vi.fn();
const createSignedUrl = vi.fn();

function fakeClient() {
  const chain: unknown = new Proxy({} as Record<string, unknown>, {
    get(_t, key) {
      if (key === "maybeSingle") {
        return async () => ({
          data: { id: JOB, status: "succeeded", storage_key: "k/archive.zip", expires_at: "2999-01-01T00:00:00Z" },
          error: null,
        });
      }
      return () => chain;
    },
  });
  return { from: () => chain, rpc };
}

vi.mock("@/lib/supabase/server", () => ({ createClient: (...a: unknown[]) => createClient(...a) }));
vi.mock("@/lib/supabase/storage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/supabase/storage")>()),
  createStorageClient: (...a: unknown[]) => createStorageClient(...a),
}));
vi.mock("@/lib/auth", () => ({ getCurrentUser: (...a: unknown[]) => getCurrentUser(...a) }));

const { issueExportDownloadUrl } = await import("@/lib/export/download");
const { GET } = await import("@/app/(app)/account/exports/[jobId]/download/route");

const JOB = "33333333-3333-4333-8333-333333333333";
const storageError = (status: number, statusCode: string) =>
  Object.assign(new Error(statusCode === "404" ? "Object not found" : "Bad Request"), { status, statusCode });

beforeEach(() => {
  vi.clearAllMocks();
  getCurrentUser.mockResolvedValue({ id: "44444444-4444-4444-8444-444444444444" });
  createClient.mockImplementation(async () => fakeClient());
  createStorageClient.mockImplementation(() => ({ storage: { from: () => ({ info, createSignedUrl }) } }));
  rpc.mockResolvedValue({ error: null });
  createSignedUrl.mockResolvedValue({ data: { signedUrl: "https://signed.example/x" }, error: null });
});

describe("an export download tells a Storage fault from a missing archive (G20)", () => {
  it("a Storage 400 with no not-found body is 503, and no audit row is written", async () => {
    info.mockResolvedValue({ data: null, error: storageError(400, "400") });
    expect(await issueExportDownloadUrl(JOB)).toEqual({ ok: false, status: 503 });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("a thrown info() is 503 too", async () => {
    info.mockRejectedValue(new Error("socket hang up"));
    expect(await issueExportDownloadUrl(JOB)).toEqual({ ok: false, status: 503 });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("a missing object (body statusCode 404, HTTP 400) is still the not-found answer", async () => {
    info.mockResolvedValue({ data: null, error: storageError(400, "404") });
    expect(await issueExportDownloadUrl(JOB)).toEqual({ ok: false, status: 404 });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("POSITIVE CONTROL: a present object is audited and signed", async () => {
    info.mockResolvedValue({ data: { id: "o" }, error: null });
    expect(await issueExportDownloadUrl(JOB)).toEqual({ ok: true, url: "https://signed.example/x" });
    expect(rpc).toHaveBeenCalledWith("audit_export_download", { p_job_id: JOB, p_part: 1 });
  });

  it("the route renders the 503 as temporarily unavailable, not the not-found text", async () => {
    info.mockResolvedValue({ data: null, error: storageError(400, "400") });
    const res = await GET(new Request(`http://localhost/account/exports/${JOB}/download`), {
      params: Promise.resolve({ jobId: JOB }),
    });
    expect(res.status).toBe(503);
    expect(await res.text()).toMatch(/temporarily unavailable/);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });
});
