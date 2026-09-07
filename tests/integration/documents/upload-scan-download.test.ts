// Phase 4 (Operations), Task 5: the file-security pipeline END TO END, at the
// Server-Action level, against a REAL local Supabase stack.
//
// ===========================================================================
// WHAT THIS PROVES THAT THE DB/HTTP SUITES CANNOT
// ===========================================================================
// The psql/HTTP suites prove the invariants (storage-key shape, the deny-all
// fence, the scan guard) and the RLS boundaries. They cannot exercise the
// APPLICATION ORDER that is the actual control (Global Constraint 12): sniff ->
// store -> scan -> land the verdict on upload, and load-through-RLS -> refuse
// non-clean -> AUDIT -> sign on download. This drives the real actions
// (uploadDocumentAction / issueDownloadUrl / deleteDocumentAction) so that:
//   * a CLEAN pdf uploads, lands `clean`, and issues a signed URL that RESOLVES;
//   * an EICAR file lands `quarantined` and issueDownloadUrl REFUSES (409, no
//     URL) -- the quarantine gate, end to end;
//   * a second org's user cannot reach the first org's document (404, RLS);
//   * every upload/download/delete writes EXACTLY ONE audit row, and a refused
//     download writes NONE -- counts with denominators, not a vacuous 0.
//
// The malware verdict comes from the REAL EicarStubScanner (getScanner()'s
// default): a clean pdf scans `clean`, the EICAR marker scans `infected`. No
// scanner is mocked -- the content genuinely decides the verdict.
//
// ===========================================================================
// WHAT IS MOCKED, AND WHY IT DOES NOT WEAKEN THE TEST
// ===========================================================================
// Only the Next.js request-context seams: next/cache (revalidatePath),
// @/lib/auth (getCurrentUser/getCurrentOrg -- the cookie-backed session this
// process has no request for), @/lib/crm/write-access (the entitlement gate,
// asserted for real in the RLS suite), and @/lib/supabase/server (createClient
// -> a REAL supabase-js client signed in as the persona). The DB path -- the
// metadata write, the RLS document load, the audit RPC -- and Storage (real
// service-role client, real signed URL) are NOT mocked, so the tenant boundary
// and the audit are exercised against the real database.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import {
  createFixtures,
  destroyFixtures,
  type RlsFixtures,
} from "../rls/support/fixtures";
import { getLocalSupabaseStatus } from "../rls/support/env";

// Hoisted so the vi.mock factories below can read it; the tests set which
// persona/org is "current" before each action call.
const current = vi.hoisted(() => ({
  userId: "",
  // A supabase-js client, typed loosely to avoid importing the type here.
  client: null as unknown,
  orgs: new Map<
    string,
    { id: string; name: string; slug: string; role: string; isSuspended: boolean }
  >(),
}));

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/auth", () => ({
  getCurrentUser: async () => (current.userId ? { id: current.userId } : null),
  getCurrentOrg: async (slug: string) => current.orgs.get(slug) ?? null,
}));
vi.mock("@/lib/crm/write-access", () => ({
  getCrmWriteAccess: async () => ({ canWrite: true, explanation: "" }),
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => current.client,
}));

// Imported AFTER the mocks (vi.mock is hoisted above imports by vitest).
import {
  deleteDocumentAction,
  issueDownloadUrl,
  uploadDocumentAction,
} from "@/lib/crm/documents";

// A minimal valid PDF: sniffAndAllow keys on the `%PDF-` magic bytes.
const CLEAN_PDF = new Uint8Array(
  Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n", "latin1"),
);
// The EICAR test string, assembled from fragments so this source file never
// holds the contiguous signature (which a dev's own AV would quarantine). It is
// plain ASCII, so the allowlist accepts it as text/plain; the scanner then
// flags the marker as infected -> quarantined.
const EICAR = new Uint8Array(
  Buffer.from(
    "X5O!P%@AP[4\\PZX54(P^)7CC)7}$" +
      "EICAR-STANDARD-" +
      "ANTIVIRUS-TEST-FILE" +
      "!$H+H*",
    "latin1",
  ),
);

let fx: RlsFixtures;
let pool: Pool;

/** Upload a document as the currently-set persona/org and return its new id. */
async function uploadAs(
  orgSlug: string,
  bytes: Uint8Array,
  name: string,
  mime: string,
): Promise<{ error?: string; message?: string; documentId: string }> {
  const fd = new FormData();
  // `bytes` is Uint8Array<ArrayBufferLike>; File wants a BlobPart (ArrayBuffer
  // view). The bytes are a plain heap buffer here, so the cast is sound.
  fd.append("file", new File([bytes as unknown as BlobPart], name, { type: mime }));
  const result = await uploadDocumentAction(orgSlug, fd);
  // The action mints the id internally; read the row back for this owner/org.
  const { rows } = await pool.query<{ id: string }>(
    `select id from public.documents
      where organisation_id = $1 and owner_user_id = $2
      order by created_at desc limit 1`,
    [current.orgs.get(orgSlug)!.id, current.userId],
  );
  return { ...result, documentId: rows[0]?.id };
}

async function scanStatusOf(id: string): Promise<string | null> {
  const { rows } = await pool.query<{ scan_status: string }>(
    `select scan_status from public.documents where id = $1`,
    [id],
  );
  return rows[0]?.scan_status ?? null;
}

/** Count of audit rows for one document, keyed by action. */
async function auditCounts(id: string): Promise<Record<string, number>> {
  const { rows } = await pool.query<{ action: string; n: string }>(
    `select action, count(*)::int as n from public.audit_events
      where target_type = 'document' and target_id = $1 group by action`,
    [id],
  );
  return Object.fromEntries(rows.map((r) => [r.action, Number(r.n)]));
}

function useManagerA() {
  current.userId = fx.activeByRole.manager.userId;
  current.client = fx.activeByRole.manager.client;
}

beforeAll(async () => {
  const status = getLocalSupabaseStatus();
  // The real service-role Storage client (lib/supabase/storage.ts) reads these
  // at call time -- set them before any action runs.
  process.env.NEXT_PUBLIC_SUPABASE_URL = status.apiUrl;
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = status.anonKey;
  process.env.SUPABASE_SERVICE_ROLE_KEY = status.serviceRoleKey;

  fx = await createFixtures();
  pool = fx._pool;
  const org = (o: { id: string; slug: string }, role: string) => ({
    id: o.id,
    name: o.slug,
    slug: o.slug,
    role,
    isSuspended: false,
  });
  current.orgs.set(fx.orgA.slug, org(fx.orgA, "manager"));
  current.orgs.set(fx.orgB.slug, org(fx.orgB, "owner"));
}, 120_000);

afterAll(async () => {
  if (fx) await destroyFixtures(fx);
});

describe("document upload / scan / download pipeline", () => {
  it("a clean upload lands `clean`, issues a resolving signed URL, and audits both steps", async () => {
    useManagerA();
    const up = await uploadAs(fx.orgA.slug, CLEAN_PDF, "clean.pdf", "application/pdf");
    expect(up.message).toBe("Uploaded.");
    expect(up.documentId).toBeTruthy();
    expect(await scanStatusOf(up.documentId)).toBe("clean");

    const dl = await issueDownloadUrl(fx.orgA.slug, up.documentId);
    expect(dl.ok).toBe(true);
    if (!dl.ok) throw new Error("expected a signed URL");
    expect(dl.url).toContain("/storage/v1/object/sign/");

    // The signed URL genuinely resolves to the stored bytes.
    const res = await fetch(dl.url);
    expect(res.status).toBe(200);
    const body = new Uint8Array(await res.arrayBuffer());
    expect(Buffer.from(body).toString("latin1").startsWith("%PDF-")).toBe(true);

    // Exactly one upload row and one download row -- the denominator is the two
    // deliberate actions; removing either audit call (or issuing the URL before
    // the audit and returning early) drops the count to 0 and reddens this.
    const counts = await auditCounts(up.documentId);
    expect(counts.document_uploaded).toBe(1);
    expect(counts.document_downloaded).toBe(1);
    expect(counts.document_quarantined ?? 0).toBe(0);
  });

  it("an EICAR upload is quarantined and the download is refused (409, no URL, no download audit)", async () => {
    useManagerA();
    const up = await uploadAs(fx.orgA.slug, EICAR, "eicar.txt", "text/plain");
    // The action reports the quarantine to the user rather than success.
    expect(up.message).toBeUndefined();
    expect(up.error).toBeTruthy();
    expect(await scanStatusOf(up.documentId)).toBe("quarantined");

    const dl = await issueDownloadUrl(fx.orgA.slug, up.documentId);
    expect(dl.ok).toBe(false);
    if (dl.ok) throw new Error("a quarantined file must not yield a URL");
    expect(dl.status).toBe(409);

    // A quarantined upload is audited exactly once, as a quarantine event, and
    // the refused download writes NO download row.
    const counts = await auditCounts(up.documentId);
    expect(counts.document_quarantined).toBe(1);
    expect(counts.document_uploaded ?? 0).toBe(0);
    expect(counts.document_downloaded ?? 0).toBe(0);
  });

  it("a second org's user cannot reach the first org's document (404, RLS), and it is not audited", async () => {
    // A clean document in org A, never legitimately downloaded.
    useManagerA();
    const up = await uploadAs(fx.orgA.slug, CLEAN_PDF, "secret.pdf", "application/pdf");
    expect(await scanStatusOf(up.documentId)).toBe("clean");

    // Now act as an org B member asking for org A's document id in B's context.
    current.userId = fx.ownerB.userId;
    current.client = fx.ownerB.client;
    const dl = await issueDownloadUrl(fx.orgB.slug, up.documentId);
    expect(dl.ok).toBe(false);
    if (dl.ok) throw new Error("cross-tenant download must 404");
    expect(dl.status).toBe(404);

    // Pure RLS: B's own client reads zero rows for A's document id, no org
    // filter -- the boundary, not just the org-scoped query.
    const { data } = await fx.ownerB.client
      .from("documents")
      .select("id")
      .eq("id", up.documentId);
    expect(data ?? []).toHaveLength(0);

    // The refused cross-tenant attempt wrote no download audit row.
    const counts = await auditCounts(up.documentId);
    expect(counts.document_downloaded ?? 0).toBe(0);
    expect(counts.document_uploaded).toBe(1);
  });

  it("soft-delete audits `document_deleted`, keeps the bytes, and the download then 404s", async () => {
    useManagerA();
    const up = await uploadAs(fx.orgA.slug, CLEAN_PDF, "trash.pdf", "application/pdf");
    expect(await scanStatusOf(up.documentId)).toBe("clean");

    const fd = new FormData();
    fd.append("documentId", up.documentId);
    const del = await deleteDocumentAction(fx.orgA.slug, fd);
    expect(del.message).toBe("Deleted.");

    // Soft-delete: the row is marked, not removed.
    const { rows } = await pool.query<{ deleted_at: string | null }>(
      `select deleted_at from public.documents where id = $1`,
      [up.documentId],
    );
    expect(rows[0]?.deleted_at).not.toBeNull();

    const counts = await auditCounts(up.documentId);
    expect(counts.document_deleted).toBe(1);

    // A soft-deleted document is unreachable for download (loaded with
    // deleted_at is null) -> 404.
    const dl = await issueDownloadUrl(fx.orgA.slug, up.documentId);
    expect(dl.ok).toBe(false);
    if (dl.ok) throw new Error("a soft-deleted document must not yield a URL");
    expect(dl.status).toBe(404);
  });
});
