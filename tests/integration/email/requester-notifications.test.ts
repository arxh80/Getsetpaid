// THE DSR / EXPORT-READY / ERASURE-FAILURE NOTICES AGAINST THE REAL DATABASE
// (founder 2026-09-30, Q157(3)/Q174/Q45; 20261015000000).
//
// The TRANSPORT is stubbed -- no test sends a real email -- and everything
// else is real: the service_role client, the resolver RPCs, the column grants,
// the stamp guard and the stamp RPC. Three properties, each per notice:
//
//   1. STAMP ONLY AFTER ok:true. The stub reads the row's stamp from Postgres
//      AT THE MOMENT OF THE SEND and records it; it must be null then, and
//      set after an ok:true.
//   2. A FAILED SEND LEAVES THE ROW UNSTAMPED, AND THE NEXT TICK RETRIES IT.
//   3. NOTHING IS SENT TWICE: a third tick sends nothing for a stamped row.
//
// The recipient is asserted to be the requester's CURRENT auth address, read
// back from auth.users -- not the DSR row's `user_email` snapshot, which the
// fixture deliberately sets to something else.

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { getLocalSupabaseStatus } from "../rls/support/env";
import { createFixtures, destroyFixtures, type RlsFixtures } from "../rls/support/fixtures";

interface SentMail {
  to: string;
  subject: string;
  text: string;
  html: string;
  /** The stamp column(s) read from Postgres when the send was attempted. */
  stampAtSend: string | null;
}

const transport = vi.hoisted(() => ({
  ok: false,
  sent: [] as SentMail[],
  probe: null as null | ((to: string) => Promise<string | null>),
}));

vi.mock("@/lib/email/send", () => ({
  sendEmail: async (input: { to: { email: string }[]; subject: string; text: string; html: string }) => {
    const to = input.to[0]?.email ?? "";
    const stampAtSend = transport.probe ? await transport.probe(input.subject) : null;
    transport.sent.push({ to, subject: input.subject, text: input.text, html: input.html, stampAtSend });
    return transport.ok
      ? { ok: true, messageId: "stub" }
      : { ok: false, error: "stubbed Brevo 503" };
  },
}));

let fx: RlsFixtures;
let pool: Pool;
let mod: typeof import("@/lib/email/requester-notifications");

let requesterId = "";
let requesterEmail = "";
const dsrId = crypto.randomUUID();
const exportId = crypto.randomUUID();
const erasureId = crypto.randomUUID();
const SUPPORT = "founder-inbox@test.local";

async function stamp(sql: string, id: string): Promise<string | null> {
  const { rows } = await pool.query<{ v: string | null }>(sql, [id]);
  return rows[0]?.v ?? null;
}
const dsrReceived = () =>
  stamp("select received_notified_at::text as v from public.data_subject_requests where id = $1", dsrId);
const dsrClosed = () =>
  stamp("select closed_notified_at::text as v from public.data_subject_requests where id = $1", dsrId);
const exportReady = () =>
  stamp("select ready_notified_at::text as v from public.export_jobs where id = $1", exportId);
const erasureFailure = () =>
  stamp("select failure_notified_at::text as v from public.erasure_jobs where id = $1", erasureId);

function mineTo(address: string): SentMail[] {
  return transport.sent.filter((m) => m.to === address);
}

beforeAll(async () => {
  const status = getLocalSupabaseStatus();
  process.env.NEXT_PUBLIC_SUPABASE_URL = status.apiUrl;
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = status.anonKey;
  process.env.SUPABASE_SERVICE_ROLE_KEY = status.serviceRoleKey;
  process.env.SUPPORT_CONTACT_EMAIL = SUPPORT;
  process.env.NEXT_PUBLIC_SITE_URL = "http://localhost:3000";
  vi.spyOn(console, "error").mockImplementation(() => {});

  mod = await import("@/lib/email/requester-notifications");
  fx = await createFixtures();
  pool = fx._pool;

  const persona = fx.activeByRole.marketing;
  requesterId = persona.userId;
  const { rows } = await pool.query<{ email: string }>("select email from auth.users where id = $1", [requesterId]);
  requesterEmail = rows[0].email;

  // Fixtures with triggers off -- the shape the psql suite uses; no client
  // has this path. A withdrawn request (owed RECEIVED and CLOSED), a
  // succeeded export, a failed erasure.
  const c = await pool.connect();
  try {
    await c.query("begin");
    await c.query("set local session_replication_role = replica");
    await c.query(
      `insert into public.data_subject_requests
         (id, user_id, user_email, right_type, subject_scope, detail, status, requested_at, withdrawn_at)
       values ($1, $2, 'snapshot-not-the-recipient@test.local', 'access', 'account',
               'PRIVATE DETAIL MUST NOT BE EMAILED', 'withdrawn', now(), now())`,
      [dsrId, requesterId],
    );
    await c.query(
      `insert into public.export_jobs
         (id, kind, requested_by, status, started_at, completed_at, expires_at, storage_key,
          byte_size, row_count, table_count, manifest)
       values ($1::uuid, 'account', $2, 'succeeded', now(), now(), now() + interval '7 days',
               'exports/' || $1::text || '.zip', 10, 1, 1, '{}'::jsonb)`,
      [exportId, requesterId],
    );
    await c.query(
      `insert into public.erasure_jobs
         (id, kind, subject_user_id, requested_by, status, started_at, completed_at, failure_reason)
       values ($1, 'account', $2, $2, 'failed', now(), now(), 'PRIVATE FAILURE REASON')`,
      [erasureId, requesterId],
    );
    await c.query("commit");
  } finally {
    c.release();
  }
}, 120_000);

afterAll(async () => {
  if (pool) {
    const c = await pool.connect();
    try {
      await c.query("begin");
      await c.query("set local session_replication_role = replica");
      await c.query("delete from public.data_subject_requests where id = $1", [dsrId]);
      await c.query("delete from public.export_jobs where id = $1", [exportId]);
      await c.query("delete from public.erasure_jobs where id = $1", [erasureId]);
      await c.query("commit");
    } finally {
      c.release();
    }
  }
  if (fx) await destroyFixtures(fx);
});

describe("DSR received/closed notices", () => {
  it("a FAILED send stamps nothing; the rows stay owed", async () => {
    transport.ok = false;
    transport.sent = [];
    transport.probe = async () => `${(await dsrReceived()) ?? ""}|${(await dsrClosed()) ?? ""}`;
    const result = await mod.deliverDsrNotifications();
    const mine = mineTo(requesterEmail);
    // The denominator: both notices were really attempted, to this person.
    expect(mine.map((m) => m.subject).sort()).toEqual([
      expect.stringMatching(/^We received your data request/),
      expect.stringMatching(/^Your data request #\d+ is closed/),
    ].sort());
    expect(result).toMatchObject({ outcome: "delivered", failed: expect.any(Number) });
    expect(await dsrReceived()).toBeNull();
    expect(await dsrClosed()).toBeNull();
  });

  it("the next tick retries, stamps only AFTER ok:true, to the CURRENT address, with no typed text", async () => {
    transport.ok = true;
    transport.sent = [];
    transport.probe = async () => `${(await dsrReceived()) ?? ""}|${(await dsrClosed()) ?? ""}`;
    await mod.deliverDsrNotifications();
    const mine = mineTo(requesterEmail);
    expect(mine).toHaveLength(2);
    // At the moment of each send, neither stamp had been written yet for the
    // FIRST, and only the first for the second -- never the one being sent.
    const received = mine.find((m) => m.subject.startsWith("We received"))!;
    const closed = mine.find((m) => m.subject.includes("is closed"))!;
    expect(received.stampAtSend?.split("|")[0]).toBe("");
    expect(closed.stampAtSend?.split("|")[1]).toBe("");
    expect(await dsrReceived()).not.toBeNull();
    expect(await dsrClosed()).not.toBeNull();
    expect(transport.sent.some((m) => m.to === "snapshot-not-the-recipient@test.local")).toBe(false);
    for (const m of mine) {
      expect(`${m.subject}${m.text}${m.html}`).not.toContain("PRIVATE DETAIL");
    }
  });

  it("a third tick sends nothing for those rows", async () => {
    transport.ok = true;
    transport.sent = [];
    await mod.deliverDsrNotifications();
    expect(mineTo(requesterEmail)).toHaveLength(0);
  });
});

describe("export-ready notice", () => {
  it("fails, then retries and stamps after ok:true, then never again -- and links the PAGE, not the archive", async () => {
    transport.probe = async () => exportReady();
    transport.ok = false;
    transport.sent = [];
    await mod.deliverExportReadyNotifications();
    expect(mineTo(requesterEmail)).toHaveLength(1);
    expect(await exportReady()).toBeNull();

    transport.ok = true;
    transport.sent = [];
    await mod.deliverExportReadyNotifications();
    const [mail] = mineTo(requesterEmail);
    expect(mail).toBeDefined();
    expect(mail.stampAtSend).toBeNull();
    expect(await exportReady()).not.toBeNull();
    const all = `${mail.subject}${mail.text}${mail.html}`;
    expect(all).toContain("/account/exports");
    expect(all).not.toContain(exportId);
    expect(all).not.toMatch(/exports\/[0-9a-f-]+\.zip|token=|\/sign\/|storage\/v1/i);

    transport.sent = [];
    await mod.deliverExportReadyNotifications();
    expect(mineTo(requesterEmail)).toHaveLength(0);
  });
});

describe("erasure-failure notice to the superuser", () => {
  it("fails, then retries and stamps after ok:true, then never again -- a count and a link only", async () => {
    transport.probe = async () => erasureFailure();
    transport.ok = false;
    transport.sent = [];
    await mod.deliverErasureFailureNotifications();
    expect(mineTo(SUPPORT)).toHaveLength(1);
    expect(await erasureFailure()).toBeNull();

    transport.ok = true;
    transport.sent = [];
    const result = await mod.deliverErasureFailureNotifications();
    expect(result.outcome).toBe("sent");
    const [mail] = mineTo(SUPPORT);
    expect(mail.stampAtSend).toBeNull();
    expect(await erasureFailure()).not.toBeNull();
    const all = `${mail.subject}${mail.text}${mail.html}`;
    expect(all).toContain("/super/data-requests");
    expect(all).not.toContain("PRIVATE FAILURE REASON");
    expect(all).not.toContain(requesterId);
    expect(all).not.toContain(requesterEmail);
    expect(all).not.toContain(erasureId);
    expect(mineTo(requesterEmail)).toHaveLength(0);

    transport.sent = [];
    expect((await mod.deliverErasureFailureNotifications()).outcome).toBe("nothing_pending");
    expect(transport.sent).toHaveLength(0);
  });
});
