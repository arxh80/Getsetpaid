// THE WORKSPACE-CLOSURE NOTICES AGAINST THE REAL DATABASE (founder 2026-09-30,
// Q176/Q178; Task 9c job 2b, database half 20261022001000).
//
// The TRANSPORT is stubbed -- no test sends a real email -- and everything
// else is real: the service_role client, the two resolver RPCs, the stamp RPC
// and the private ledger. The subjects are audit rows planted directly (the
// decisions' RPCs are aal2-superuser-only and proved in
// rls_phase8_workspace_closure.sql; here the subject only has to EXIST):
//
//   1. STAMP ONLY AFTER ok:true. The stub reads the ledger AT THE MOMENT OF
//      THE SEND; it must hold no row for that subject then, and one after.
//   2. A FAILED SEND LEAVES IT UNSTAMPED, AND THE NEXT TICK RETRIES IT.
//   3. NOTHING IS SENT TWICE.
//   4. RECIPIENTS: the closure goes to SUPPORT_CONTACT_EMAIL alone; a decision
//      goes to the user ids SNAPSHOTTED on its audit row and nobody else -- in
//      particular NOT to org A's other active Owner, who is a live Owner of the
//      workspace but is not in the snapshot.

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { getLocalSupabaseStatus } from "../rls/support/env";
import { createFixtures, destroyFixtures, type RlsFixtures } from "../rls/support/fixtures";

interface SentMail {
  to: string[];
  subject: string;
  text: string;
  html: string;
  ledgerAtSend: number;
}

const transport = vi.hoisted(() => ({
  ok: false,
  sent: [] as SentMail[],
  probe: null as null | (() => Promise<number>),
}));

vi.mock("@/lib/email/send", () => ({
  sendEmail: async (input: { to: { email: string }[]; bcc?: { email: string }[]; subject: string; text: string; html: string }) => {
    const ledgerAtSend = transport.probe ? await transport.probe() : -1;
    transport.sent.push({
      to: [...input.to, ...(input.bcc ?? [])].map((t) => t.email).sort(),
      subject: input.subject,
      text: input.text,
      html: input.html,
      ledgerAtSend,
    });
    return transport.ok ? { ok: true, messageId: "stub" } : { ok: false, error: "stubbed Brevo 503" };
  },
}));

const SUPPORT = "closure-founder-inbox@test.local";

let fx: RlsFixtures;
let pool: Pool;
let mod: typeof import("@/lib/email/workspace-closure-notifications");

const closedId = crypto.randomUUID();
const reassignedId = crypto.randomUUID();
const deletedId = crypto.randomUUID();
const PLANTED_REASON = "PLANTED SUPERUSER REASON 9c2b";

async function ledger(notice: string, id: string): Promise<number> {
  const { rows } = await pool.query<{ n: number }>(
    `select count(*)::int as n from private.notification_deliveries where notice = $1 and audit_event_id = $2`,
    [notice, id],
  );
  return rows[0].n;
}

const mine = (subject: (s: string) => boolean) => transport.sent.filter((m) => subject(m.subject));

beforeAll(async () => {
  const status = getLocalSupabaseStatus();
  process.env.NEXT_PUBLIC_SUPABASE_URL = status.apiUrl;
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = status.anonKey;
  process.env.SUPABASE_SERVICE_ROLE_KEY = status.serviceRoleKey;
  process.env.NEXT_PUBLIC_SITE_URL = "http://localhost:3000";
  process.env.SUPPORT_CONTACT_EMAIL = SUPPORT;
  vi.spyOn(console, "error").mockImplementation(() => {});
  mod = await import("@/lib/email/workspace-closure-notifications");
  fx = await createFixtures();
  pool = fx._pool;

  const admin = fx.activeByRole.admin;
  const c = await pool.connect();
  try {
    await c.query("begin");
    // Planted as postgres, past the audit table's append-only guard, because
    // the subject only has to exist; the audit rows' own writers are tested
    // where they are defined.
    await c.query("set local session_replication_role = replica");
    await c.query(
      `insert into public.audit_events (id, organisation_id, actor_user_id, action, target_type, target_id, correlation_id, after)
       values ($1, $4, $5, 'organisation.closed_by_owner',  'organisation', $4, gen_random_uuid(), jsonb_build_object('reason', $9::text)),
              ($2, $4, $5, 'organisation.closure_reassigned', 'organisation', $4, gen_random_uuid(),
                 jsonb_build_object('organisation_slug', $6::text, 'organisation_name', 'Closure Test Org A',
                                    'reason', $9::text, 'notify_user_ids', jsonb_build_array($7::text))),
              ($3, $4, $5, 'organisation.closure_deleted',    'organisation', $4, gen_random_uuid(),
                 jsonb_build_object('organisation_slug', $6::text, 'organisation_name', 'Closure Test Org A',
                                    'reason', $9::text, 'notify_user_ids', jsonb_build_array($7::text, $8::text)))`,
      [closedId, reassignedId, deletedId, fx.orgA.id, fx.ownerA.userId, fx.orgA.slug, admin.userId, fx.ownerA.userId, PLANTED_REASON],
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
      const ids = [closedId, reassignedId, deletedId];
      await c.query("delete from private.notification_deliveries where audit_event_id = any($1::uuid[])", [ids]);
      await c.query("delete from public.audit_events where id = any($1::uuid[])", [ids]);
      await c.query("commit");
    } finally {
      c.release();
    }
  }
  if (fx) await destroyFixtures(fx);
});

describe("workspace closed -> the superuser's inbox", () => {
  const isClosed = (s: string) => s === `[GetSetPaid] A workspace was closed by its Owner: ${fx.orgA.slug}`;

  it("a FAILED send stamps nothing", async () => {
    transport.ok = false;
    transport.sent = [];
    transport.probe = () => ledger("workspace_closed", closedId);
    await mod.deliverWorkspaceClosureNotifications();
    expect(mine(isClosed)).toHaveLength(1);
    expect(await ledger("workspace_closed", closedId)).toBe(0);
  });

  it("the next tick retries it to SUPPORT_CONTACT_EMAIL alone, stamping only AFTER ok:true", async () => {
    transport.ok = true;
    transport.sent = [];
    transport.probe = () => ledger("workspace_closed", closedId);
    await mod.deliverWorkspaceClosureNotifications();
    const sent = mine(isClosed);
    expect(sent).toHaveLength(1);
    const [mail] = sent;
    expect(mail.to).toEqual([SUPPORT]);
    expect(mail.ledgerAtSend).toBe(0);
    expect(await ledger("workspace_closed", closedId)).toBe(1);
    const body = `${mail.subject}${mail.text}${mail.html}`;
    expect(body).toContain("http://localhost:3000/super/closures");
    expect(body).not.toContain(PLANTED_REASON);
    expect(body).not.toContain(fx.ownerA.email);
  });

  it("a third tick sends nothing for it", async () => {
    transport.sent = [];
    await mod.deliverWorkspaceClosureNotifications();
    expect(mine(isClosed)).toHaveLength(0);
  });
});

describe("decisions -> ONLY the Owners/Admins snapshotted on the audit row", () => {
  const isReassigned = (s: string) => s === `Your closed GetSetPaid workspace ${fx.orgA.slug} has been reopened`;
  const isDeleted = (s: string) => s === `Your closed GetSetPaid workspace ${fx.orgA.slug} is being deleted`;

  it("a FAILED send stamps neither decision", async () => {
    transport.ok = false;
    transport.sent = [];
    transport.probe = async () =>
      (await ledger("workspace_reassigned", reassignedId)) + (await ledger("workspace_deleted", deletedId));
    await mod.deliverWorkspaceDecisionNotifications();
    expect(mine(isReassigned)).toHaveLength(1);
    expect(mine(isDeleted)).toHaveLength(1);
    expect(await ledger("workspace_reassigned", reassignedId)).toBe(0);
    expect(await ledger("workspace_deleted", deletedId)).toBe(0);
  });

  it("the retry reaches exactly each snapshot, stamps after ok:true, and carries no reason", async () => {
    transport.ok = true;
    transport.sent = [];
    transport.probe = async () =>
      (await ledger("workspace_reassigned", reassignedId)) + (await ledger("workspace_deleted", deletedId));
    await mod.deliverWorkspaceDecisionNotifications();

    const [reassigned] = mine(isReassigned);
    const [deleted] = mine(isDeleted);
    expect(reassigned).toBeDefined();
    expect(deleted).toBeDefined();
    // The denominator: org A's Owner IS a live, active Owner of the workspace,
    // so a resolver reading live membership would include them here.
    expect(reassigned.to).toEqual([fx.activeByRole.admin.email]);
    expect(reassigned.to).not.toContain(fx.ownerA.email);
    expect(deleted.to).toEqual([fx.activeByRole.admin.email, fx.ownerA.email].sort());
    for (const m of [reassigned, deleted]) {
      expect(m.to).not.toContain(SUPPORT);
      expect(m.to).not.toContain(fx.activeByRole.manager.email);
      expect(`${m.subject}${m.text}${m.html}`).not.toContain(PLANTED_REASON);
    }
    // The probe counts BOTH decisions' ledger rows, so at the i-th send exactly
    // the i earlier sends are stamped -- and never the one being sent.
    const decisions = transport.sent.filter((m) => isReassigned(m.subject) || isDeleted(m.subject));
    expect(decisions.map((m) => m.ledgerAtSend)).toEqual([0, 1]);
    expect(reassigned.text).toContain(`http://localhost:3000/${fx.orgA.slug}`);
    expect(deleted.text).toContain("Open GetSetPaid: http://localhost:3000/");
    expect(deleted.text).not.toContain(`http://localhost:3000/${fx.orgA.slug}`);
    expect(await ledger("workspace_reassigned", reassignedId)).toBe(1);
    expect(await ledger("workspace_deleted", deletedId)).toBe(1);
  });

  it("a third tick sends nothing for either", async () => {
    transport.sent = [];
    await mod.deliverWorkspaceDecisionNotifications();
    expect(mine(isReassigned)).toHaveLength(0);
    expect(mine(isDeleted)).toHaveLength(0);
  });
});
