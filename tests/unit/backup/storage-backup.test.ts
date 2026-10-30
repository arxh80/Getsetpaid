import { describe, expect, it } from "vitest";
import {
  BUCKETS,
  configFromEnv,
  listAll,
  runBackup,
  s3Destination,
} from "../../../scripts/storage-backup.mjs";

// Phase 10 Task 11 (G30): scripts/storage-backup.mjs over a fake Storage
// source and a fake fetch. The real signer was also proved once against the
// local stack's S3 endpoint (docs/runbooks/backup-restore.md § Storage).

type Entry = { name: string; id: string | null };

/** A fake bucket tree. list() honours limit/offset like Storage does. */
function fakeSource(tree: Record<string, Record<string, Entry[]>>, failing = new Set<string>()) {
  const calls: string[] = [];
  return {
    calls,
    async list(bucket: string, folder: string, { limit, offset }: { limit: number; offset: number }) {
      calls.push(`${bucket}:${folder}:${offset}`);
      return (tree[bucket]?.[folder] ?? []).slice(offset, offset + limit);
    },
    async download(bucket: string, path: string) {
      if (failing.has(`${bucket}/${path}`)) throw new Error("download failed");
      return new TextEncoder().encode(`${bucket}/${path}`);
    },
  };
}

const files = (n: number, stem: string): Entry[] =>
  Array.from({ length: n }, (_, i) => ({ name: `${stem}${String(i).padStart(3, "0")}.pdf`, id: `${stem}${i}` }));

const ENV = {
  SUPABASE_URL: "http://127.0.0.1:54321",
  SUPABASE_SERVICE_ROLE_KEY: "service-role",
  BACKUP_S3_ENDPOINT: "https://s3.backup.example",
  BACKUP_S3_BUCKET: "getsetpaid-backups",
  BACKUP_S3_REGION: "eu-central-1",
  BACKUP_S3_ACCESS_KEY_ID: "AKID",
  BACKUP_S3_SECRET_ACCESS_KEY: "secret",
  BACKUP_PREFIX: "2026-10-26",
};

describe("storage-backup (G30)", () => {
  it("names the three private buckets", () => {
    expect(BUCKETS).toEqual(["documents", "feedback-screenshots", "exports"]);
  });

  it("lists every object: pages past the first page and recurses into folders", async () => {
    const source = fakeSource({
      documents: {
        "": [{ name: "org-a", id: null }, ...files(150, "top")],
        "org-a": files(101, "nested"),
      },
    });
    const all = await listAll(source, "documents");
    expect(all).toHaveLength(251);
    expect(all).toContain("top149.pdf");
    expect(all).toContain("org-a/nested100.pdf");
  });

  it("copies every object of every bucket to the destination, keyed by prefix and bucket", async () => {
    const source = fakeSource({
      documents: { "": files(120, "d") },
      "feedback-screenshots": { "": files(2, "f") },
      exports: { "": files(1, "e") },
    });
    const put: string[] = [];
    const result = await runBackup({ source, dest: { put: async (k: string) => void put.push(k) }, prefix: "P" });
    expect(result).toEqual({ copied: 123, failed: [] });
    expect(put).toContain("P/documents/d119.pdf");
    expect(put).toContain("P/feedback-screenshots/f001.pdf");
    expect(put).toContain("P/exports/e000.pdf");
  });

  it("a failed copy is reported by name and the rest still copy", async () => {
    const source = fakeSource({ documents: { "": files(3, "d") } }, new Set(["documents/d001.pdf"]));
    const result = await runBackup({ source, dest: { put: async () => {} }, buckets: ["documents"], prefix: "P" });
    expect(result.copied).toBe(2);
    expect(result.failed).toEqual(["documents/d001.pdf: download failed"]);
  });

  it("sends every object to the configured endpoint and nowhere else, signed", async () => {
    const seen: { url: string; auth: string }[] = [];
    const dest = s3Destination(configFromEnv(ENV), async (url: URL | RequestInfo, init?: RequestInit) => {
      seen.push({ url: String(url), auth: String((init?.headers as Record<string, string>).authorization) });
      return new Response(null, { status: 200 });
    });
    await runBackup({ source: fakeSource({ documents: { "": files(2, "d") } }), dest, buckets: ["documents"], prefix: "2026-10-26" });
    expect(seen.map((s) => s.url)).toEqual([
      "https://s3.backup.example/getsetpaid-backups/2026-10-26/documents/d000.pdf",
      "https://s3.backup.example/getsetpaid-backups/2026-10-26/documents/d001.pdf",
    ]);
    for (const s of seen) expect(s.auth).toMatch(/^AWS4-HMAC-SHA256 Credential=AKID\/\d{8}\/eu-central-1\/s3\/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/);
  });

  it("a refused PUT is a failed copy, not a silent one", async () => {
    const dest = s3Destination(configFromEnv(ENV), async () => new Response(null, { status: 403 }));
    const result = await runBackup({ source: fakeSource({ documents: { "": files(1, "d") } }), dest, buckets: ["documents"], prefix: "P" });
    expect(result).toEqual({ copied: 0, failed: ["documents/d000.pdf: PUT 403"] });
  });

  it("refuses to start without its endpoint settings, or over plain http to a remote host", () => {
    expect(() => configFromEnv({ ...ENV, BACKUP_S3_ENDPOINT: "" })).toThrow(/missing BACKUP_S3_ENDPOINT/);
    expect(() => configFromEnv({ ...ENV, BACKUP_S3_ENDPOINT: "http://s3.backup.example" })).toThrow(/https/);
    expect(configFromEnv({ ...ENV, BACKUP_S3_ENDPOINT: "http://127.0.0.1:54321/storage/v1/s3" }).endpoint).toBe(
      "http://127.0.0.1:54321/storage/v1/s3",
    );
  });
});
